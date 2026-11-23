import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Kysely, MysqlDialect, sql } from 'kysely'
import { createPool } from 'mysql2'
import { createKyselyAdapter, createZenlev, lintPlugin, lintProject } from '../../../src'
import { readBuiltinLintCatalog } from '../../../src/lint/catalog'
import { authorMigration } from '../../../src/migrate/files'

const mysqlUrl = process.env.ZENLEV_TEST_MYSQL_URL
describe.skipIf(mysqlUrl === undefined)('MySQL lint catalog', () => {
  test('reads objects and column metadata, reports visibility, and rejects a complete migration plan before DDL', async () => {
    const namespace = 'zenlev_lint_catalog'
    const cwd = await mkdtemp(join(import.meta.dir, '.zenlev-lint-mysql-'))
    const db = new Kysely<any>({
      dialect: new MysqlDialect({ pool: createPool({ uri: mysqlUrl!, connectionLimit: 2 }) }),
    })
    const adapter = createKyselyAdapter(db, 'mysql')
    let zenlev: { close(): Promise<void> } | undefined
    try {
      await sql.raw('DROP DATABASE IF EXISTS ' + namespace).execute(db)
      await sql.raw('CREATE DATABASE ' + namespace).execute(db)
      const statements = [
        `CREATE TABLE ${namespace}.parents (id bigint AUTO_INCREMENT PRIMARY KEY, label varchar(128) NOT NULL DEFAULT 'parent', CONSTRAINT uq_parents_label UNIQUE(label), CONSTRAINT ck_parents_label CHECK (length(label) > 0))`,
        `CREATE TABLE ${namespace}.children (id varchar(32) PRIMARY KEY, parent_id bigint, label varchar(64), computed varchar(128) GENERATED ALWAYS AS (concat(label, '_computed')) STORED, CONSTRAINT fk_children_parent FOREIGN KEY(parent_id) REFERENCES ${namespace}.parents(id))`,
        `CREATE INDEX idx_children_parent ON ${namespace}.children(parent_id)`,
        `CREATE INDEX idx_children_prefix ON ${namespace}.children(label(8))`,
        `CREATE INDEX idx_children_invisible ON ${namespace}.children(label) INVISIBLE`,
        `CREATE SQL SECURITY INVOKER VIEW ${namespace}.visible_children AS SELECT id FROM ${namespace}.children`,
        `CREATE FUNCTION ${namespace}.increment_value(value integer) RETURNS integer DETERMINISTIC NO SQL RETURN value + 1`,
        `CREATE PROCEDURE ${namespace}.procedure_value() SQL SECURITY INVOKER SELECT 1`,
        `CREATE TRIGGER ${namespace}.children_trigger BEFORE INSERT ON ${namespace}.children FOR EACH ROW SET NEW.label = COALESCE(NEW.label, 'child')`,
        `CREATE EVENT ${namespace}.scheduled_event ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1`,
        `CREATE TABLE ${namespace}.internal_migrations (id text)`,
      ]
      for (const statement of statements) await sql.raw(statement).execute(db)
      const result = await readBuiltinLintCatalog({
        adapter,
        namespaces: [namespace],
        store: { databaseName: namespace, tableName: 'internal_migrations' },
      })
      expect(result.gaps).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('metadata privileges') }),
      )
      for (const kind of [
        'schema',
        'table',
        'column',
        'primary-key',
        'foreign-key',
        'unique',
        'check',
        'index',
        'view',
        'function',
        'procedure',
        'trigger',
        'event',
      ])
        expect(result.nodes.some((node) => node.kind === kind)).toBe(true)
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'column', table: 'parents', name: 'id', sequential: true }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'column',
          table: 'children',
          name: 'computed',
          generated: true,
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'view', name: 'visible_children', security: 'invoker' }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'procedure',
          name: 'procedure_value',
          security: 'invoker',
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'function', name: 'increment_value', security: 'definer' }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'foreign-key',
          name: 'fk_children_parent',
          targetSchema: namespace,
          targetTable: 'parents',
          targetColumns: ['id'],
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'index', name: 'idx_children_prefix', partial: true }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'index', name: 'idx_children_invisible', partial: true }),
      )
      expect(result.nodes.some((node) => (node.table ?? node.name) === 'internal_migrations')).toBe(
        false,
      )
      expect(
        (await readBuiltinLintCatalog({ adapter })).nodes.some((node) => node.schema === namespace),
      ).toBe(false)
      await authorMigration(
        join(cwd, 'migrations'),
        {
          name: 'lint_rejected',
          upBody: `await ctx.db.kysely.schema.createTable('${namespace}.written_before_violation').addColumn('id', 'varchar(32)', col => col.primaryKey()).execute()
await ctx.db.kysely.schema.createTable('${namespace}.BadTable').addColumn('id', 'varchar(32)', col => col.primaryKey()).execute()`,
        },
        { createId: () => 'lintcatalog', now: () => new Date('2026-11-23T12:00:00.000Z') },
      )
      const service = await createZenlev({
        cwd,
        adapter,
        store: {
          databaseName: namespace,
          tableName: 'gate_migrations',
          lockTableName: 'gate_lock',
        },
        lint: { zmodel: false, namespaces: [namespace] },
        plugins: [lintPlugin()],
      })
      zenlev = service
      const applied = await service.migrate.apply()
      expect(applied.status).toBe('failed')
      expect(applied.diagnostics).toContainEqual(
        expect.objectContaining({ ruleId: 'zenlev/naming/table-case', severity: 'error' }),
      )
      const unchanged = await sql<{
        count: string
      }>`SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${namespace} AND TABLE_NAME IN ('written_before_violation', 'BadTable')`.execute(
        db,
      )
      expect(Number(unchanged.rows[0]?.count)).toBe(0)
      expect(
        (await lintProject({ cwd, adapter, lint: { namespaces: [namespace] } }, { live: true }))
          .coverage.capabilities,
      ).toContain('events')
    } finally {
      try {
        await zenlev?.close()
        await sql.raw('DROP DATABASE IF EXISTS ' + namespace).execute(db)
      } finally {
        await db.destroy()
        await rm(cwd, { recursive: true, force: true })
      }
    }
  })

  test('requires an explicit namespace when the connection has no default database', async () => {
    const url = new URL(mysqlUrl!)
    url.pathname = '/'
    const db = new Kysely<any>({
      dialect: new MysqlDialect({ pool: createPool({ uri: url.href, connectionLimit: 1 }) }),
    })
    try {
      await expect(
        readBuiltinLintCatalog({ adapter: createKyselyAdapter(db, 'mysql') }),
      ).rejects.toThrow('selected MySQL database')
    } finally {
      await db.destroy()
    }
  })
})
