import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ZenStackClient } from '@zenstackhq/orm'
import type { SchemaDef } from '@zenstackhq/schema'
import { MysqlDialect, PostgresDialect, sql } from 'kysely'
import { createPool } from 'mysql2'
import { Pool } from 'pg'
import { createZenlev, createZenStackAdapter, type Zenlev } from '../../src'
import { createStore } from '../../src/store'
import { alignCatalogSchema, readCatalog } from '../../src/schema-catalog'
import { loadSchemaModel } from '../../src/schema-model'
import type { Dialect, MigrationMeta } from '../../src/types'

const parentTable = 'zenlev_qualification_parents'
const childTable = 'zenlev_qualification_children'
const markerTable = 'zenlev_qualification_marker'
const partialTable = 'zenlev_qualification_partial'
const transactionTable = 'zenlev_qualification_transaction'
const scalarTable = 'zenlev_qualification_scalars'
const enumName = 'zenlev_qualification_category'
const viewName = 'zenlev_qualification_view'
const tables = [scalarTable, childTable, parentTable, markerTable, partialTable, transactionTable]
const createdAt = '2026-11-21T12:00:00.000Z'

const models = {
  Parent: {
    name: 'Parent',
    attributes: [
      { name: '@@map', args: [{ name: 'name', value: { kind: 'literal', value: parentTable } }] },
    ],
    fields: {
      id: { name: 'id', type: 'Int', id: true },
      name: {
        name: 'name',
        type: 'String',
        default: 'parent',
        attributes: [
          {
            name: '@map',
            args: [{ name: 'name', value: { kind: 'literal', value: 'display_name' } }],
          },
        ],
      },
      active: { name: 'active', type: 'Boolean', default: true },
    },
    idFields: ['id'],
    uniqueFields: { id: { type: 'Int' } },
  },
  Child: {
    name: 'Child',
    attributes: [
      { name: '@@map', args: [{ name: 'name', value: { kind: 'literal', value: childTable } }] },
    ],
    fields: {
      id: { name: 'id', type: 'Int', id: true },
      parentId: {
        name: 'parentId',
        type: 'Int',
        attributes: [
          {
            name: '@map',
            args: [{ name: 'name', value: { kind: 'literal', value: 'parent_id' } }],
          },
        ],
      },
      label: { name: 'label', type: 'String', default: 'child' },
    },
    idFields: ['id'],
    uniqueFields: { id: { type: 'Int' } },
  },
} as const satisfies SchemaDef['models']

function nativeClient(dialect: 'postgresql' | 'mysql', url: string, searchPath = 'public') {
  return new ZenStackClient(
    { provider: { type: dialect }, models, plugins: {} },
    {
      dialect:
        dialect === 'postgresql'
          ? new PostgresDialect({
              pool: new Pool({
                connectionString: url,
                max: 4,
                options: '-c search_path=' + searchPath,
              }),
            })
          : new MysqlDialect({ pool: createPool({ uri: url, connectionLimit: 4 }) }),
    },
  )
}

interface Fixture {
  readonly cwd: string
  readonly client: ReturnType<typeof nativeClient>
  readonly zenlev: Zenlev
}

function zmodel(dialect: Dialect, empty = false): string {
  const provider = 'datasource db {\n  provider = "' + dialect + '"\n}\n'
  if (empty) return provider + 'model Marker {\n id Int @id\n @@map("' + markerTable + '")\n}\n'
  return (
    provider +
    `
model Parent {
  id Int @id
  name String @default("parent") @map("display_name")
  active Boolean @default(true)
  children Child[]
  @@map("${parentTable}")
}
model Child {
  id Int @id
  parentId Int @map("parent_id")
  parent Parent @relation(fields: [parentId], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "zenlev_qualification_child_parent_fk")
  label String @default("child")
  @@index([parentId], map: "zenlev_qualification_child_parent_idx")
  @@map("${childTable}")
}
`
  )
}

async function cleanDatabase(
  client: ReturnType<typeof nativeClient>,
  dialect: 'postgresql' | 'mysql',
) {
  await sql`DROP VIEW IF EXISTS ${sql.id(viewName)}`.execute(client.$qbRaw)
  for (const table of tables)
    await sql`DROP TABLE IF EXISTS ${sql.id(table)}`.execute(client.$qbRaw)
  if (dialect === 'postgresql')
    await sql`DROP TYPE IF EXISTS ${sql.id(enumName)}`.execute(client.$qbRaw)
  const ledger =
    dialect === 'postgresql'
      ? sql`DROP SCHEMA IF EXISTS ${sql.id('zenlev')} CASCADE`
      : sql`DROP DATABASE IF EXISTS ${sql.id('zenlev')}`
  await ledger.execute(client.$qbRaw)
}

async function tableExists(
  fixture: Fixture,
  dialect: 'postgresql' | 'mysql',
  name: string,
): Promise<boolean> {
  const schema = dialect === 'postgresql' ? sql`current_schema()` : sql`DATABASE()`
  const result =
    await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = ${name}`.execute(
      fixture.client.$qbRaw,
    )
  return result.rows.length === 1
}

async function migration(
  fixture: Fixture,
  id: string,
  body: string,
  extra: Partial<MigrationMeta> = {},
) {
  const meta = { id, name: id, namespace: 'default', createdAt, ...extra }
  await Bun.write(
    resolve(fixture.cwd, 'migrations', id + '_' + meta.name + '.ts'),
    'export const meta = ' +
      JSON.stringify(meta) +
      '\nexport async function up(ctx) { ' +
      body +
      ' }\n',
  )
}

for (const dialect of ['postgresql', 'mysql'] as const) {
  const url =
    dialect === 'postgresql'
      ? process.env.ZENLEV_TEST_POSTGRES_URL
      : process.env.ZENLEV_TEST_MYSQL_URL

  describe.skipIf(url === undefined)(dialect + ' configured ZenStack integration', () => {
    let fixture: Fixture | undefined

    beforeEach(async () => {
      const cwd = await mkdtemp(resolve(import.meta.dir, '../.zenlev-dialects-'))
      const client = nativeClient(dialect, url!)
      try {
        await cleanDatabase(client, dialect)
        await Bun.write(resolve(cwd, 'schema.zmodel'), zmodel(dialect))
        const zenlev = await createZenlev({ cwd, client, env: 'integration' })
        fixture = { cwd, client, zenlev }
      } catch (error) {
        await client.$disconnect()
        await rm(cwd, { recursive: true, force: true })
        throw error
      }
    })

    afterEach(async () => {
      if (fixture === undefined) return
      const current = fixture
      fixture = undefined
      try {
        await current.zenlev.close()
        await cleanDatabase(current.client, dialect)
      } finally {
        await current.client.$disconnect()
        await rm(current.cwd, { recursive: true, force: true })
      }
    })

    test.skipIf(dialect !== 'postgresql')(
      'rolls back ledger creation when it would change the PostgreSQL search path',
      async () => {
        const client = nativeClient(dialect, url!, 'zenlev,public')
        const zenlev = await createZenlev({ cwd: fixture!.cwd, client })
        try {
          await expect(zenlev.db.push({ dropMissingTables: 'skip' })).rejects.toThrow(
            'Creating the Zenlev ledger would change the PostgreSQL search path',
          )
          const result = await sql<{ schema: string | null }>`
            SELECT pg_catalog.to_regnamespace('zenlev')::text AS schema
          `.execute(client.$qbRaw)
          expect(result.rows[0]?.schema).toBeNull()
        } finally {
          await zenlev.close()
          await client.$disconnect()
        }
      },
    )

    test('pushes mapped tables, defaults, indexes and foreign keys and then produces no diff', async () => {
      const f = fixture!
      const result = await f.zenlev.db.push({ dropMissingTables: 'skip' })
      expect(result.status).toBe('applied')
      expect(result.changes.blockers).toEqual([])
      expect(result.changes.operations.map(({ kind }) => kind)).toContain('create-index')
      expect(result.changes.operations.map(({ kind }) => kind)).toContain('add-foreign-key')
      await f.client.parent.create({ data: { id: 1, name: 'ORM mapped', active: false } })
      await f.client.$qbRaw.insertInto(parentTable).values({ id: 2 }).execute()
      const parents = await f.client.parent.findMany({ orderBy: { id: 'asc' } })
      expect(parents).toEqual([
        { id: 1, name: 'ORM mapped', active: false },
        { id: 2, name: 'parent', active: true },
      ])
      await f.client.child.create({ data: { id: 1, parentId: 1, label: 'linked' } })
      await expect(
        Promise.resolve(
          f.client.child.create({ data: { id: 2, parentId: 999, label: 'invalid' } }),
        ),
      ).rejects.toThrow()
      const second = await f.zenlev.db.push({ dryRun: true })
      expect(second.changes.blockers).toEqual([])
      expect(second.changes.operations).toEqual([])
      expect(second.changes.missingTables).toEqual([])
      const store = createStore(createZenStackAdapter(f.client))
      expect(store.tables[0]).toEqual({ name: 'migrations', namespace: 'zenlev' })
      expect((await store.lockInfo())?.owner).toBeNull()
    })

    test('round-trips enums, scalar defaults, native timestamp precision and PostgreSQL arrays', async () => {
      const f = fixture!
      await Bun.write(
        resolve(f.cwd, 'schema.zmodel'),
        zmodel(dialect) +
          '\nenum Category {\n FIRST\n SECOND\n @@map("' +
          enumName +
          '")\n}\n' +
          'model Scalars {\n id Int @id @default(autoincrement())\n' +
          ' category Category @default(FIRST)\n amount Decimal @default(1.5)\n' +
          ' createdAt DateTime @default(now())\n enabled Boolean @default(false)\n' +
          (dialect === 'postgresql' ? ' labels String[]\n' : '') +
          ' @@map("' +
          scalarTable +
          '")\n}\n',
      )
      const first = await f.zenlev.db.push({ dropMissingTables: 'skip' })
      expect(first.changes.blockers).toEqual([])
      expect(first.error).toBeUndefined()
      expect(first.status).toBe('applied')
      const second = await f.zenlev.db.push({ dryRun: true })
      expect(second.changes.blockers).toEqual([])
      expect(second.changes.operations).toEqual([])
      if (dialect === 'mysql') {
        const path = resolve(f.cwd, 'schema.zmodel')
        await Bun.write(path, (await Bun.file(path).text()).replace(' SECOND', ' THIRD'))
        const changed = await f.zenlev.db.push({ dryRun: true })
        expect(changed.changes.operations.map(({ kind }) => kind)).toEqual(['alter-column'])
        expect(changed.changes.warnings.map(({ code }) => code)).toContain('TYPE_NARROWING')
      }
    })

    test('reports unsupported generated columns, indexes and views while preserving catalog constraints', async () => {
      const f = fixture!
      await f.zenlev.db.push({ dropMissingTables: 'skip' })
      await sql
        .raw(
          'CREATE TABLE ' +
            scalarTable +
            ' (id integer PRIMARY KEY, parent_id integer, ' +
            "label varchar(64) DEFAULT 'catalog', calculated integer GENERATED ALWAYS AS (id + 1) STORED, " +
            'CONSTRAINT qualification_unique UNIQUE(label), CONSTRAINT qualification_positive CHECK(id > 0), ' +
            'CONSTRAINT qualification_parent FOREIGN KEY(parent_id) REFERENCES ' +
            parentTable +
            '(id) ON DELETE SET NULL ON UPDATE RESTRICT' +
            (dialect === 'postgresql'
              ? ', fallback integer DEFAULT 1, CONSTRAINT qualification_fallback FOREIGN KEY(fallback) REFERENCES ' +
                parentTable +
                '(id) ON DELETE SET DEFAULT ON UPDATE NO ACTION'
              : '') +
            ')',
        )
        .execute(f.client.$qbRaw)
      await sql
        .raw(
          dialect === 'postgresql'
            ? 'CREATE INDEX qualification_complex ON ' +
                scalarTable +
                ' ((lower(label))) WHERE id > 0'
            : 'CREATE INDEX qualification_complex ON ' + scalarTable + ' (label(8))',
        )
        .execute(f.client.$qbRaw)
      await sql
        .raw('CREATE VIEW ' + viewName + ' AS SELECT id FROM ' + scalarTable)
        .execute(f.client.$qbRaw)
      const desired = await alignCatalogSchema(
        f.client.$qbRaw,
        await loadSchemaModel({ cwd: f.cwd }),
      )
      const catalog = await readCatalog(f.client.$qbRaw, desired, [], false)
      const table = catalog.tables.find(({ name }) => name === scalarTable)!
      expect(table.primaryKey).toEqual(['id'])
      expect(table.indexes.some(({ unique, columns }) => unique && columns[0] === 'label')).toBe(
        true,
      )
      expect(table.foreignKeys.find(({ name }) => name === 'qualification_parent')).toMatchObject({
        onDelete: 'SetNull',
        onUpdate: 'Restrict',
        columns: ['parent_id'],
      })
      if (dialect === 'postgresql') {
        expect(
          table.foreignKeys.find(({ name }) => name === 'qualification_fallback'),
        ).toMatchObject({
          onDelete: 'SetDefault',
          onUpdate: 'NoAction',
        })
      }
      expect(catalog.unsupported.map(({ message }) => message).join('\n')).toContain(
        'generated columns',
      )
      expect(catalog.unsupported.map(({ message }) => message).join('\n')).toContain(
        'qualification_complex',
      )
      expect(catalog.unsupported.map(({ message }) => message).join('\n')).toContain('is a view')
      expect(catalog.tables.some(({ name }) => name === viewName)).toBe(false)
    })

    test('preserves declined tables and drops approved tables with their foreign key dependencies', async () => {
      const f = fixture!
      expect((await f.zenlev.db.push({ dropMissingTables: 'skip' })).status).toBe('applied')
      await Bun.write(resolve(f.cwd, 'schema.zmodel'), zmodel(dialect, true))
      const skipped = await f.zenlev.db.push({ dropMissingTables: 'skip' })
      expect(skipped.status).toBe('applied')
      expect(await tableExists(f, dialect, parentTable)).toBe(true)
      expect(await tableExists(f, dialect, childTable)).toBe(true)
      const dropped = await f.zenlev.db.push({
        confirmDrops: (ids) => ids,
      })
      expect(dropped.status).toBe('applied')
      expect(dropped.changes.blockers).toEqual([])
      expect(dropped.changes.operations[0]?.kind).toBe('drop-foreign-key')
      expect(await tableExists(f, dialect, parentTable)).toBe(false)
      expect(await tableExists(f, dialect, childTable)).toBe(false)
      expect(await tableExists(f, dialect, markerTable)).toBe(true)
    })

    test('uses the configured client for migrations and recovers a durable partial attempt', async () => {
      const f = fixture!
      expect((await f.zenlev.db.push({ dropMissingTables: 'skip' })).status).toBe('applied')
      await migration(
        f,
        'aaa',
        "await ctx.zenstack.client.parent.create({data:{id:5,name:'migrated',active:true}})",
      )
      await migration(
        f,
        'bbb',
        "await ctx.db.schema.createTable('" +
          partialTable +
          "').addColumn('id','integer').execute(); throw new Error('after DDL')",
        { dependsOn: ['aaa'] },
      )
      const result = await f.zenlev.migrate.apply({ noTransaction: true })
      expect(result.status).toBe('partial')
      expect(result.migrations.map(({ status }) => status)).toEqual(['applied', 'failed'])
      expect((await f.client.parent.findUnique({ where: { id: 5 } }))?.name).toBe('migrated')
      expect(await tableExists(f, dialect, partialTable)).toBe(true)
      const store = createStore(createZenStackAdapter(f.client))
      const failed = (await store.read()).find(({ meta }) => meta.id === 'bbb')
      expect(failed?.status).toBe('failed')
      expect(failed?.attemptId).toBeString()
      expect(failed?.unresolvedAttempt).toBe(true)
      await f.zenlev.migrate.recover({
        action: 'applied',
        id: 'bbb',
        attemptId: failed!.attemptId!,
        actor: 'integration',
        reason: 'Inspected after deliberate handler failure',
        evidence: 'Verified partial table exists and no remaining DDL was expected',
      })
      expect((await f.zenlev.migrate.apply()).migrations).toEqual([])
      expect((await store.read()).every(({ status }) => status === 'applied')).toBe(true)
    })

    if (dialect === 'postgresql') {
      test('rolls back a failed PostgreSQL migration plan and its ledger together', async () => {
        const f = fixture!
        await migration(
          f,
          'aaa',
          "await ctx.db.schema.createTable('" +
            transactionTable +
            "').addColumn('id','integer').execute()",
        )
        await migration(f, 'bbb', "throw new Error('atomic abort')", { dependsOn: ['aaa'] })
        const result = await f.zenlev.migrate.apply()
        expect(result.status).toBe('failed')
        expect(result.migrations.map(({ status }) => status)).toEqual(['rolled_back', 'failed'])
        expect(await tableExists(f, dialect, transactionTable)).toBe(false)
        expect(await createStore(createZenStackAdapter(f.client)).read()).toEqual([])
      })
    }
  })
}
