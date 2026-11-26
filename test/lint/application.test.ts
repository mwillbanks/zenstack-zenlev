import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { lintProject, type LintConfig } from '../../src'

let cwd: string
beforeEach(async () => {
  cwd = await mkdtemp(join(import.meta.dir, '.zenlev-application-'))
})
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const source = ['**/*.ts', 'app/*.ts']
const prefix = 'zenlev/queries/'
function write(path: string, code: string) {
  return Bun.write(join(cwd, path), code)
}
function lint(config: LintConfig = {}) {
  return lintProject({ cwd, lint: { source, ...config } })
}

test('checks query interfaces, client access, SQL, and schema builders without executing app modules', async () => {
  await write(
    'app/queries.ts',
    [
      "import { ZenStackClient } from '@zenstackhq/orm'",
      "import { Kysely, sql as query } from 'kysely'",
      "throw new Error('Do not import application source')",
      'const db = new ZenStackClient(schema, options)',
      'const { $qb: tableQuery, $qbRaw: physical } = db',
      "tableQuery.selectFrom('items').selectAll()",
      'db.item.findMany()',
      'query`select * from items where id = ${id}`',
      "tableQuery.schema.createTable('items')",
      'const direct = new Kysely(options)',
      'const fake = { findMany() {} }',
      'fake.findMany()',
    ].join('\n'),
  )
  const result = await lint({
    rules: {
      [prefix + 'allowed-types']: ['error', { allow: ['query-builder'] }],
      [prefix + 'no-schema-changes']: 'warn',
    },
  })
  expect(result.files).toBe(1)
  expect(result.diagnostics.map(({ ruleId, source }) => [ruleId, source?.line])).toEqual([
    [prefix + 'no-direct-kysely', 5],
    [prefix + 'allowed-types', 7],
    [prefix + 'no-raw', 8],
    [prefix + 'no-schema-changes', 9],
    [prefix + 'no-direct-kysely', 10],
  ])
  expect(result.diagnostics.every(({ source }) => source?.path === 'app/queries.ts')).toBe(true)
})

test('allows standalone Kysely builders, with a file override for ZenStack mode', async () => {
  const code = [
    "import { Kysely } from 'kysely'",
    'const db = new Kysely(options)',
    "db.selectFrom('items').selectAll()",
  ].join('\n')
  await write('app/standalone.ts', code)
  await write('app/strict.ts', code)
  const result = await lint({
    zmodel: false,
    overrides: [
      {
        files: ['app/strict.ts'],
        origins: ['application'],
        rules: { [prefix + 'no-direct-kysely']: ['error', { mode: 'zenstack' }] },
      },
    ],
  })
  expect(result.diagnostics.length).toBeGreaterThan(0)
  expect(result.diagnostics.every(({ source }) => source?.path === 'app/strict.ts')).toBe(true)
})

test('exempts migrations from application rules even with migration analysis disabled', async () => {
  const code = "import { sql } from 'kysely'\nexport const up = () => sql`select 1`"
  await write('migrations/a12345678901234567890123_query.ts', code)
  await write('app/query.ts', code)
  await write('app/generated.d.ts', 'not application syntax')
  await write('app/readme.txt', 'not application syntax')
  const result = await lint({ migrations: false })
  expect(result.files).toBe(1)
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      ruleId: prefix + 'no-raw',
      source: expect.objectContaining({ path: 'app/query.ts' }),
    }),
  ])
})

test('traces local client exports, transaction aliases, and driver calls', async () => {
  await write(
    'db/client.ts',
    [
      "import { ZenStackClient as Client } from '@zenstackhq/orm'",
      'export const database = new Client(schema, options)',
    ].join('\n'),
  )
  await write('db/index.ts', "export { database as db } from './client'")
  await write(
    'app/service.ts',
    [
      "import { db } from '../db'",
      "import { Pool } from 'pg'",
      'db.$transaction(async (tx) => {',
      "  const builder = tx['$qb']",
      "  builder.selectFrom('items').selectAll()",
      "  const raw = tx['$qbRaw']",
      '  tx.item.findMany()',
      '})',
      'const pool = new Pool()',
      "pool.query('select * from items where id = $1', [id])",
      'function unrelated(db) { db.item.findMany() }',
      'const member = getMemberName()',
      'db[member]()',
    ].join('\n'),
  )
  const result = await lint({
    source: ['app/*.ts'],
    rules: { [prefix + 'allowed-types']: ['warn', { allow: ['query-api'] }] },
  })
  expect(result.files).toBe(1)
  expect(result.diagnostics.map(({ ruleId }) => ruleId)).toContain(prefix + 'allowed-types')
  expect(
    result.diagnostics
      .filter(({ ruleId }) => ruleId !== prefix + 'allowed-types')
      .map(({ ruleId, source }) => [ruleId, source?.line]),
  ).toEqual([
    [prefix + 'no-direct-kysely', 6],
    [prefix + 'no-raw', 10],
  ])
  expect(result.coverage.gaps).toEqual([
    expect.objectContaining({ source: expect.objectContaining({ line: 13 }) }),
  ])
})

test('distinguishes typed compiled queries from raw and unresolved compiled queries', async () => {
  await write(
    'app/compiled.ts',
    [
      "import * as orm from '@zenstackhq/orm'",
      "import { CompiledQuery } from 'kysely'",
      'function run(db: orm.ZenStackClient<Schema>) {',
      '  const qb = (db as orm.ZenStackClient<Schema>).$qb!',
      "  const typed = qb.selectFrom('item').selectAll().compile()",
      '  qb.executeQuery(typed)',
      "  qb.executeQuery({ sql: 'select 1', parameters: [] })",
      "  qb.executeQuery(CompiledQuery.raw('select 1'))",
      '  qb.executeQuery(loadStatement())',
      '  external(qb)',
      '}',
    ].join('\n'),
  )
  const result = await lint()
  expect(result.diagnostics.map(({ ruleId }) => ruleId)).toEqual([
    prefix + 'no-raw',
    prefix + 'no-raw',
  ])
  expect(result.coverage.gaps.map(({ source }) => source?.line)).toEqual([9, 10])
})

test('follows exported typed clients, assignments, and recognized driver bindings', async () => {
  await write(
    'db/client.ts',
    [
      "import { ZenStackClient } from '@zenstackhq/orm'",
      'declare const db: ZenStackClient<Schema>',
      'export default db',
      'export { db as named }',
    ].join('\n'),
  )
  await write('db/barrel.ts', "export * from './client'")
  await write(
    'app/drivers.ts',
    [
      "import first from '../db/client'",
      "import * as clients from '../db/barrel'",
      "import mysql from 'mysql2/promise'",
      "import postgres from 'postgres'",
      "import { SQL } from 'bun'",
      'let db = first',
      'db = clients.named',
      "db.$queryRawUnsafe('select 1')",
      'const pool = mysql.createPool(options)',
      'const conn = await pool.getConnection()',
      "conn.execute('select 1')",
      'const client = postgres(url)',
      "client.unsafe('select 1')",
      'const bunSql = new SQL(url)',
      "bunSql.unsafe('select 1')",
    ].join('\n'),
  )
  await write('app/typed.ts', "import db from '../db/client'\ndb.item.findMany()")
  const result = await lint({ source: ['app/*.ts'] })
  expect(result.files).toBe(2)
  expect(result.diagnostics.map(({ ruleId, source }) => [ruleId, source?.line])).toEqual(
    [8, 11, 13, 15].map((line) => [prefix + 'no-raw', line]),
  )
  expect(result.coverage.gaps).toEqual([])
})

test('reports unresolved module evidence and rejects invalid selected syntax', async () => {
  await write(
    'app/opaque.ts',
    [
      "import missing from './missing'",
      "import opaque from './invalid'",
      "import('./dynamic')",
      'missing.item.findMany()',
      'opaque.$qb.selectFrom("item")',
    ].join('\n'),
  )
  await write('app/invalid.ts', 'const =')
  const result = await lint({ source: ['app/opaque.ts'] })
  expect(result.diagnostics).toEqual([])
  expect(result.coverage.gaps.map(({ source }) => source?.line)).toEqual([3, 4, 5])
  await expect(lint()).rejects.toThrow('Invalid application source')
})

test('checks CommonJS bindings and keeps catch and loop shadows isolated', async () => {
  await write(
    'app/queries.cjs',
    [
      "const { ZenStackClient } = require('@zenstackhq/orm')",
      "const { sql: statement } = require('kysely')",
      'const db = new ZenStackClient(schema, options)',
      "try { run() } catch (db) { db.$qbRaw.selectFrom('item') }",
      "for (const db of local) { db.$qbRaw.selectFrom('item') }",
      "for (let db = fake; db; db = null) db.$qbRaw.selectFrom('item')",
      "for (const db in local) db.$qbRaw.selectFrom('item')",
      "const raw = db['$qbRaw']",
      "statement.raw('select 1')",
      "function unrelated(require) { require('kysely').sql.raw('not a query') }",
    ].join('\n'),
  )
  const result = await lint({ source: ['app/*.cjs'] })
  expect(result.diagnostics.map(({ ruleId, source }) => [ruleId, source?.line])).toEqual([
    [prefix + 'no-direct-kysely', 8],
    [prefix + 'no-raw', 9],
  ])
  expect(result.coverage.gaps).toEqual([])
})

test('keeps tuple aliases and warns after an unresolved client reassignment', async () => {
  await write(
    'app/aliases.ts',
    [
      "import { ZenStackClient } from '@zenstackhq/orm'",
      'const db = new ZenStackClient(schema, options)',
      'const [alias] = [db]',
      "alias.$queryRawUnsafe('select 1')",
      'let client = db',
      'client = unknownClient()',
      'client.$qbRaw',
      'const { [dynamicKey]: unresolved } = db',
    ].join('\n'),
  )
  const result = await lint()
  expect(result.diagnostics.map(({ ruleId, source }) => [ruleId, source?.line])).toEqual([
    [prefix + 'no-raw', 4],
  ])
  expect(result.coverage.gaps.map(({ source }) => source?.line)).toEqual([7, 8])
})

test('retains outer assignments without leaking a shadowed block binding', async () => {
  await write(
    'app/blocks.ts',
    [
      "import { ZenStackClient } from '@zenstackhq/orm'",
      'let db',
      '{ db = new ZenStackClient(schema, options) }',
      'db.$qbRaw',
      '{ const db = localObject; db.$qbRaw }',
      'db.$qbRaw',
    ].join('\n'),
  )
  const result = await lint()
  expect(result.diagnostics.map(({ ruleId, source }) => [ruleId, source?.line])).toEqual([
    [prefix + 'no-direct-kysely', 4],
    [prefix + 'no-direct-kysely', 6],
  ])
  expect(result.coverage.gaps).toEqual([])
})

test('reports uncertain assignments instead of inferring a definite client', async () => {
  await write(
    'app/branches.ts',
    [
      "import { ZenStackClient } from '@zenstackhq/orm'",
      'const initial = new ZenStackClient(schema, options)',
      'let db = initial',
      'if (condition) db = helper()',
      'db.$qbRaw',
      'db = initial',
      'try { db = helper() } catch { db = initial }',
      'db.$qbRaw',
    ].join('\n'),
  )
  const result = await lint()
  expect(result.diagnostics).toEqual([])
  expect(result.coverage.gaps.map(({ source }) => source?.line)).toEqual([5, 8])
})

test('rejects a low-level ZenStack builder imported into standalone code', async () => {
  await write(
    'db/physical.ts',
    [
      "import { ZenStackClient } from '@zenstackhq/orm'",
      'const db = new ZenStackClient(schema, options)',
      'export const physical = db.$qbRaw',
    ].join('\n'),
  )
  await write(
    'app/standalone.ts',
    [
      "import { physical } from '../db/physical'",
      "physical.selectFrom('items').selectAll()",
      'const unrelated = { physical: 1 }',
    ].join('\n'),
  )
  const result = await lint({ zmodel: false, source: ['app/*.ts'] })
  expect(result.files).toBe(1)
  expect(result.diagnostics.map(({ ruleId, source }) => [ruleId, source?.line])).toEqual([
    [prefix + 'no-direct-kysely', 2],
  ])
})

test('checks SQL in defaults and traces a client from an absent tuple element', async () => {
  await write(
    'app/defaults.ts',
    [
      "import { ZenStackClient } from '@zenstackhq/orm'",
      "import { sql } from 'kysely'",
      'const known = new ZenStackClient(schema, options)',
      'const [db = known] = []',
      "db.$queryRawUnsafe('select 1')",
      'const [other = known] = [{}]',
      "other.$queryRawUnsafe('not a database call')",
      'function get(value = sql`select 1`) { return value }',
      'const [fallback = sql`select 2`] = []',
    ].join('\n'),
  )
  const result = await lint()
  expect(result.diagnostics.map(({ ruleId, source }) => [ruleId, source?.line])).toEqual(
    [5, 8, 9].map((line) => [prefix + 'no-raw', line]),
  )
})

test('handles deferred client captures without mistaking parameter shadows for clients', async () => {
  await write(
    'app/captures.ts',
    [
      "import { ZenStackClient } from '@zenstackhq/orm'",
      "function run() { db.$queryRawUnsafe('select 1') }",
      "function unrelated(db) { db.$queryRawUnsafe('not a database call') }",
      'const db = new ZenStackClient(schema, options)',
      'run()',
    ].join('\n'),
  )
  const result = await lint()
  const lines = [
    ...result.diagnostics.map(({ source }) => source?.line),
    ...result.coverage.gaps.map(({ source }) => source?.line),
  ]
  expect(lines).toEqual([2])
  expect(result.diagnostics.every(({ ruleId }) => ruleId === prefix + 'no-raw')).toBe(true)
})

test('hoists var declarations and preserves the outer client across switch cases', async () => {
  await write(
    'app/scopes.ts',
    [
      "import { ZenStackClient } from '@zenstackhq/orm'",
      '{ var db = new ZenStackClient(schema, options) }',
      "db.$queryRawUnsafe('select 1')",
      "switch (flag) { case 0: const db = {}; db.$queryRawUnsafe('not a database call'); break }",
      "db.$queryRawUnsafe('select 2')",
      'function run() {',
      '  { var inner = db }',
      "  inner.$queryRawUnsafe('select 3')",
      '}',
    ].join('\n'),
  )
  const result = await lint()
  expect(result.diagnostics.map(({ ruleId, source }) => [ruleId, source?.line])).toEqual(
    [3, 5, 8].map((line) => [prefix + 'no-raw', line]),
  )
  expect(result.coverage.gaps).toEqual([])
})

test('validates source input and query options before scanning', async () => {
  await expect(lint({ source: [''] })).rejects.toThrow('lint.source')
  await expect(
    lint({ rules: { [prefix + 'allowed-types']: ['error', { allow: ['raw'] }] } }),
  ).rejects.toThrow('Invalid lint options')
  await expect(
    lint({ rules: { [prefix + 'no-direct-kysely']: ['error', { mode: 'unknown' }] } }),
  ).rejects.toThrow('Invalid lint options')
})
