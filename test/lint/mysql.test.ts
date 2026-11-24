import { expect, test } from 'bun:test'
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type CompiledQuery,
} from 'kysely'
import { mysql } from '../../src/lint/mysql/catalog'

for (const mode of [0, 1, 2]) {
  test('resolves MySQL namespaces with lower_case_table_names=' + mode, async () => {
    const queries: CompiledQuery[] = []
    class CatalogDriver extends DummyDriver {
      override async acquireConnection() {
        return {
          async executeQuery<R>(query: CompiledQuery) {
            queries.push(query)
            const rows = query.sql.includes('SELECT DATABASE()')
              ? [{ name: 'other', case_mode: mode }]
              : query.sql.includes('information_schema.SCHEMATA')
                ? [{ name: mode === 2 ? 'Foo' : 'foo' }]
                : []
            return { rows: rows as R[] }
          },
          streamQuery(): never {
            throw new Error('Streaming is not used by catalog audits')
          },
        }
      }
    }
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => new CatalogDriver(),
        createIntrospector: (database) => new MysqlIntrospector(database),
        createQueryCompiler: () => new MysqlQueryCompiler(),
      },
    })
    try {
      const result = await mysql(db, ['FOO', 'missing'])
      const schemas = result.nodes.filter((node) => node.kind === 'schema').map((node) => node.name)
      expect(schemas).toEqual(mode === 0 ? [] : [mode === 2 ? 'Foo' : 'foo'])
      expect(result.gaps.filter((gap) => gap.identity).map((gap) => gap.identity)).toEqual(
        mode === 0 ? ['FOO', 'missing'] : ['missing'],
      )
      const tables = queries.find((query) => query.sql.includes('information_schema.TABLES'))
      if (mode === 0) expect(tables).toBeUndefined()
      else expect(tables?.parameters).toEqual([mode === 2 ? 'Foo' : 'foo'])
      const exact = await mysql(db, [mode === 2 ? 'Foo' : 'foo'])
      expect(exact.nodes.some((node) => node.kind === 'schema')).toBe(true)
    } finally {
      await db.destroy()
    }
  })
}
