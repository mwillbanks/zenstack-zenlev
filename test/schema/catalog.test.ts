import { afterEach, expect, test } from 'bun:test'
import { Kysely, MysqlDialect, PostgresDialect, type Driver } from 'kysely'
import { readCatalog } from '../../src/schema/catalog'
import { literalDefault } from '../../src/schema/catalog/shared'
import { mysqlTable } from '../../src/schema/mysql/catalog'
import { postgresTable } from '../../src/schema/postgresql/catalog'
import type { SchemaDiagnostic, SchemaModel } from '../../src/schema/model'

const databases: Kysely<any>[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()))
})

function database(dialect: 'postgresql' | 'mysql', respond: (query: string) => any[]) {
  const native =
    dialect === 'postgresql'
      ? new PostgresDialect({ pool: {} as never })
      : new MysqlDialect({ pool: {} as never })
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => native.createAdapter(),
      createIntrospector: (db) => native.createIntrospector(db),
      createQueryCompiler: () => native.createQueryCompiler(),
      createDriver: () =>
        ({
          init: async () => {},
          acquireConnection: async () => ({
            executeQuery: async ({ sql }: { sql: string }) => ({ rows: respond(sql) }),
            streamQuery() {
              throw new Error('Catalog reads must use bounded queries')
            },
          }),
          releaseConnection: async () => {},
          beginTransaction: async () => {},
          commitTransaction: async () => {},
          rollbackTransaction: async () => {},
          destroy: async () => {},
        }) as Driver,
    },
  })
  databases.push(db)
  return db
}

function model(dialect: 'postgresql' | 'mysql'): SchemaModel {
  return {
    dialect,
    sourcePath: 'schema.zmodel',
    namespaces: ['existing', 'missing'],
    tables: [],
    enums: [],
    unsupported: [],
    warnings: [],
  }
}

test.each(['postgresql', 'mysql'] as const)(
  'returns discovered %s namespaces, including empty schemas',
  async (dialect) => {
    const db = database(dialect, (query) => {
      if (query.includes('pg_namespace WHERE') || query.includes('information_schema.schemata'))
        return [{ name: 'existing' }]
      return []
    })
    expect((await readCatalog(db, model(dialect), [])).namespaces).toEqual(['existing'])
  },
)

test('blocks PostgreSQL foreign tables rather than treating their names as available', async () => {
  const db = database('postgresql', (query) => {
    if (query.includes('pg_class c JOIN')) {
      expect(query).toContain("'f'")
      return [{ name: 'remote', namespace: 'existing', key: '100', isView: false, isForeign: true }]
    }
    return []
  })
  const catalog = await readCatalog(db, model('postgresql'), [])
  expect(catalog.tables).toEqual([])
  expect(catalog.unsupported[0]?.message).toContain('existing.remote is a foreign table')
})

test('blocks PostgreSQL invalid or not-ready indexes', async () => {
  const db = database('postgresql', (query) => {
    if (query.includes('FROM pg_catalog.pg_index')) {
      expect(query).toContain('NOT i.indisvalid')
      expect(query).toContain('NOT i.indisready')
      return [{ name: 'failed_concurrent_index', is_unique: false, complex: true, columns: ['id'] }]
    }
    return []
  })
  const unsupported: SchemaDiagnostic[] = []
  const table = await postgresTable(db, { name: 'items', key: '100', isView: false }, unsupported)
  expect(table.indexes).toEqual([])
  expect(unsupported[0]?.message).toContain('unsupported index failed_concurrent_index')
})

test('reads MySQL temporal literals separately from generated default expressions', async () => {
  const db = database('mysql', (query) =>
    query.includes('information_schema.columns')
      ? [
          {
            name: 'day',
            data_type: 'date',
            type: 'date',
            nullable: 'NO',
            extra: '',
            default_value: '2026-11-23',
          },
          {
            name: 'moment',
            data_type: 'datetime',
            type: 'datetime',
            nullable: 'NO',
            extra: '',
            default_value: '2026-11-23 12:00:00',
          },
          {
            name: 'clock',
            data_type: 'time',
            type: 'time',
            nullable: 'NO',
            extra: '',
            default_value: '12:00:00',
          },
          {
            name: 'created',
            data_type: 'timestamp',
            type: 'timestamp',
            nullable: 'NO',
            extra: 'DEFAULT_GENERATED',
            default_value: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'optional',
            data_type: 'varchar',
            type: 'varchar(50)',
            nullable: 'YES',
            extra: '',
            default_value: null,
          },
        ]
      : [],
  )
  const table = await mysqlTable(
    db,
    { name: 'items', namespace: 'existing', key: 'items', isView: false },
    undefined,
    [],
  )
  expect(table.columns.map(({ default: value }) => value)).toEqual([
    { kind: 'literal', value: '2026-11-23' },
    { kind: 'literal', value: '2026-11-23 12:00:00' },
    { kind: 'literal', value: '12:00:00' },
    { kind: 'sql', sql: 'CURRENT_TIMESTAMP' },
    undefined,
  ])
})

test.each([
  ['0x2a', 42],
  ['+0x2A', 42],
  ['-0x2a', -42],
  ['(0x2a)', 42],
  ['0xffffffffffffffff', -1],
] as const)('normalizes SQLite hexadecimal default %s', (source, value) => {
  expect(literalDefault(source)).toEqual({ kind: 'literal', value })
})
