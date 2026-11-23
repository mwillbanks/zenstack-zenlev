import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Kysely } from 'kysely'
import { operationWarnings } from '../src/warnings'
import type { Warning } from '../src/types'
import { createBunSqliteDialect } from './fixtures/sqlite'

test('identifies Kysely type changes, drops, and uniqueness from compiled statements', async () => {
  const db = new Kysely<{ entries: { key: string } }>({
    dialect: createBunSqliteDialect(new Database(':memory:')),
  })
  const warnings: Warning[] = []
  const connection = db.withPlugin(operationWarnings('abc', (warning) => warnings.push(warning)))
  try {
    connection.schema
      .alterTable('entries')
      .alterColumn('cost', (column) => column.setDataType('integer'))
      .compile()
    connection.schema.alterTable('entries').dropColumn('old_value').compile()
    connection.schema
      .createTable('entries')
      .addColumn('key', 'text', (column) => column.unique())
      .compile()
    connection.deleteFrom('entries').where('key', '=', 'only').compile()
    expect(warnings.map(({ code }) => code)).toEqual([
      'TYPE_NARROWING',
      'DROP_COLUMN',
      'UNIQUE_CONSTRAINT',
    ])
    expect(warnings.every(({ migrationId }) => migrationId === 'abc')).toBe(true)
  } finally {
    await db.destroy()
  }
})
