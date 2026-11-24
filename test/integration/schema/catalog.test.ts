import { expect, test } from 'bun:test'
import { Kysely, MysqlDialect, PostgresDialect, CompiledQuery, sql } from 'kysely'
import { createPool } from 'mysql2'
import { Pool } from 'pg'
import { readCatalog } from '../../../src/schema/catalog'
import { buildChangeSet } from '../../../src/schema/diff'
import type { SchemaColumn, SchemaModel, SchemaTable } from '../../../src/schema/model'

function column(name: string, type: string, extra: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name, field: name, type, nullable: true, array: false, autoIncrement: false, ...extra }
}

function model(
  dialect: 'postgresql' | 'mysql',
  namespace: string,
  columns: SchemaColumn[],
): SchemaModel {
  const table: SchemaTable = {
    name: 'zenlev_catalog_regression',
    namespace,
    model: 'CatalogRegression',
    isView: false,
    columns,
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
  }
  return {
    dialect,
    sourcePath: 'schema.zmodel',
    namespaces: [namespace],
    tables: [table],
    enums: [],
    unsupported: [],
    warnings: [],
  }
}

const postgresUrl = process.env.ZENLEV_TEST_POSTGRES_URL
test.skipIf(!postgresUrl)(
  'PostgreSQL creates missing namespaces, preserves varchar aliases, and blocks invalid indexes',
  async () => {
    const db = new Kysely<any>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: postgresUrl, max: 1 }) }),
    })
    const namespace = 'zenlev_catalog_regression_schema'
    const desired = model('postgresql', namespace, [
      column('id', 'integer', { nullable: false }),
      column('label', 'varchar(80)'),
    ])
    try {
      await sql`DROP SCHEMA IF EXISTS ${sql.id(namespace)} CASCADE`.execute(db)
      const empty = await readCatalog(db, desired, [])
      expect(empty.namespaces).toEqual([])
      const changes = buildChangeSet(empty, desired, { db })
      expect(changes.blockers).toEqual([])
      expect(changes.operations[0]?.kind).toBe('create-schema')
      for (const operation of changes.operations)
        for (const query of operation.up)
          await db.executeQuery(CompiledQuery.raw(query.sql, [...query.parameters]))
      const live = await readCatalog(db, desired, [])
      expect(buildChangeSet(live, desired, { db }).operations).toEqual([])
      await sql`INSERT INTO ${sql.id(namespace, 'zenlev_catalog_regression')} (id, label) VALUES (1, 'duplicate'), (2, 'duplicate')`.execute(
        db,
      )
      await expect(
        sql`CREATE UNIQUE INDEX CONCURRENTLY ${sql.id('zenlev_catalog_invalid_index')} ON ${sql.id(namespace, 'zenlev_catalog_regression')} (label)`.execute(
          db,
        ),
      ).rejects.toThrow()
      const invalid = await readCatalog(db, desired, [])
      expect(invalid.tables[0]?.indexes).toEqual([])
      expect(buildChangeSet(invalid, desired, { db }).blockers).toMatchObject([
        {
          code: 'UNSUPPORTED_CATALOG_OBJECT',
          message: expect.stringContaining('zenlev_catalog_invalid_index'),
        },
      ])
    } finally {
      try {
        await sql`DROP SCHEMA IF EXISTS ${sql.id(namespace)} CASCADE`.execute(db)
      } finally {
        await db.destroy()
      }
    }
  },
)

const mysqlUrl = process.env.ZENLEV_TEST_MYSQL_URL
test.skipIf(!mysqlUrl)(
  'MySQL round-trips temporal literal and nullable NULL defaults',
  async () => {
    const db = new Kysely<any>({
      dialect: new MysqlDialect({ pool: createPool({ uri: mysqlUrl!, connectionLimit: 1 }) }),
    })
    try {
      const { rows } = await sql<{ name: string }>`SELECT DATABASE() AS name`.execute(db)
      const namespace = rows[0]!.name
      const desired = model('mysql', namespace, [
        column('id', 'integer', { nullable: false }),
        column('day', 'date', {
          nullable: false,
          default: { kind: 'literal', value: '2026-11-23' },
        }),
        column('moment', 'datetime', {
          nullable: false,
          default: { kind: 'literal', value: '2026-11-23 12:00:00' },
        }),
        column('clock', 'time', {
          nullable: false,
          default: { kind: 'literal', value: '12:00:00' },
        }),
        column('optional', 'varchar(50)', { default: { kind: 'literal', value: null } }),
      ])
      await sql`DROP TABLE IF EXISTS zenlev_catalog_regression`.execute(db)
      await sql`CREATE TABLE zenlev_catalog_regression (
      id INTEGER PRIMARY KEY,
      day DATE NOT NULL DEFAULT '2026-11-23',
      moment DATETIME NOT NULL DEFAULT '2026-11-23 12:00:00',
      clock TIME NOT NULL DEFAULT '12:00:00',
      optional VARCHAR(50) DEFAULT NULL
    )`.execute(db)
      const live = await readCatalog(db, desired, [])
      expect(buildChangeSet(live, desired, { db }).operations).toEqual([])
      expect(buildChangeSet(live, desired, { db }).blockers).toEqual([])
    } finally {
      try {
        await sql`DROP TABLE IF EXISTS zenlev_catalog_regression`.execute(db)
      } finally {
        await db.destroy()
      }
    }
  },
)
