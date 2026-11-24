import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { SqliteDialect } from 'kysely'

/** Bridge Bun statements to the structural interface accepted by Kysely's SQLite driver. */
export function createBunSqliteDialect(database: Database): SqliteDialect {
  return new SqliteDialect({
    database: {
      close: () => database.close(),
      prepare(sql) {
        const statement = database.prepare(sql)
        return {
          reader: statement.columnNames.length > 0,
          all: (parameters) => statement.all(...(parameters as SQLQueryBindings[])),
          run: (parameters) => statement.run(...(parameters as SQLQueryBindings[])),
          iterate: (parameters) => statement.iterate(...(parameters as SQLQueryBindings[])),
        }
      },
    },
  })
}
