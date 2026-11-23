import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Kysely } from 'kysely'
import { createKyselyAdapter, createZenlev, type Warning, type Zenlev } from '../../src'
import { createBunSqliteDialect } from '../fixtures/sqlite'
import { readCatalog } from '../../src/schema/catalog'
import { loadSchemaModel } from '../../src/schema/model'

const sqlite = 'datasource db { provider = "sqlite" }\n'
const current =
  sqlite +
  `
model Account {
  id Int @id @default(autoincrement())
  email String @unique @map("contact")
  active Boolean @default(true)
  @@map("account")
}`
const baseline = sqlite + 'model Placeholder { id Int @id }\n'
let cwd: string
let raw: Database
let db: Kysely<any>
let zenlev: Zenlev
let warnings: Warning[]

beforeEach(async () => {
  cwd = await mkdtemp(resolve(import.meta.dir, '../.zenlev-schema-'))
  raw = new Database(':memory:')
  db = new Kysely({ dialect: createBunSqliteDialect(raw) })
  warnings = []
  zenlev = await createZenlev({
    cwd,
    adapter: createKyselyAdapter(db, 'sqlite'),
    onWarning(warning: Warning) {
      warnings.push(warning)
      if (warning.code === 'DROP_TABLE') expect(table('old')).toBe(true)
    },
  })
  await Bun.write(resolve(cwd, 'schema.zmodel'), current)
})

afterEach(async () => {
  await zenlev.close()
  await db.destroy()
  await rm(cwd, { force: true, recursive: true })
})

const table = (name: string) =>
  raw.query('SELECT name FROM sqlite_schema WHERE name = ?').get(name) !== null

test('prints the same change set that push executes, and excludes migration bookkeeping', async () => {
  raw.exec('CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY)')
  const preview = await zenlev.db.push({ sql: true })
  expect(preview.status).toBe('planned')
  expect(table('zenlev_migrations')).toBe(false)
  expect(table('account')).toBe(false)
  expect(preview.changes.missingTables).toEqual([])
  expect(
    preview.changes.operations.flatMap(({ up }) => up.map(({ sql }) => sql)).join('\n'),
  ).toContain('"contact"')
  expect((await zenlev.db.push()).changes).toEqual(preview.changes)
  raw.exec("INSERT INTO account(contact) VALUES ('contact@example.test')")
  expect(raw.query('SELECT id,active FROM account').all()).toEqual([{ id: 1, active: 1 }])
  expect((await zenlev.db.push({ dryRun: true })).changes.operations).toEqual([])
})

test('enforces explicit drop choices and invalidates the plan if live tables change', async () => {
  raw.exec('CREATE TABLE old (id INTEGER PRIMARY KEY)')
  const inspection = await zenlev.db.push({ dryRun: true })
  expect(inspection.changes.missingTables).toMatchObject([{ id: 'old' }])
  await expect(zenlev.db.push()).rejects.toThrow('--drop-missing-tables')
  await expect(zenlev.db.push({ confirmDrops: () => ['invented'] })).rejects.toThrow('outside')
  const stale = await zenlev.db.push({
    confirmDrops: (tables) => {
      raw.exec('CREATE TABLE concurrent_table (id INTEGER PRIMARY KEY)')
      return tables
    },
  })
  expect(stale).toMatchObject({ status: 'blocked', error: expect.stringContaining('changed') })
  expect(table('old')).toBe(true)
  expect((await zenlev.db.push({ dropMissingTables: 'skip' })).status).toBe('applied')
  expect(table('old')).toBe(true)
  expect((await zenlev.db.push({ confirmDrops: () => ['old'] })).status).toBe('applied')
  expect(table('old')).toBe(false)
  expect(table('concurrent_table')).toBe(true)
  expect(warnings.map(({ code }) => code)).toContain('DROP_TABLE')
})

test('creates effective SQL migrations from push and schema source differences', async () => {
  const generated = await zenlev.db.push({
    createMigration: true,
    name: 'init',
    namespace: 'initial',
    format: true,
  })
  expect(generated.status).toBe('created')
  expect(generated.migration?.namespace).toBe('initial')
  expect(table('account')).toBe(false)
  expect(await Bun.file(generated.migration!.filePath).text()).toContain('function down')
  expect((await zenlev.migrate.apply()).status).toBe('ok')
  expect(table('account')).toBe(true)
  await Bun.write(resolve(cwd, 'baseline.zmodel'), baseline)
  await expect(
    zenlev.migrate.create({ name: 'invalid', fromSchema: 'baseline.zmodel', empty: true }),
  ).rejects.toThrow('--empty')
  await expect(
    zenlev.migrate.create({
      name: 'invalid',
      fromSchema: 'baseline.zmodel',
      dropMissingTables: 'skip',
      dependsOn: ['unseen'],
    }),
  ).rejects.toThrow('Unknown migration')
  const retired = await zenlev.migrate.create({ name: 'retired', empty: true })
  const diff = await zenlev.migrate.create({
    name: 'diff_schema',
    fromSchema: 'baseline.zmodel',
    toDb: true,
    dropMissingTables: 'apply',
    dependsOn: [generated.migration!.id],
    tags: ['ddl'],
    custom: { ticket: 'example' },
    supersedes: [retired.id],
  })
  expect(diff.tags).toEqual(['ddl'])
  expect(await Bun.file(diff.filePath).text()).not.toContain('function down')
})

test('rejects stale live-schema changes during diff migration confirmation', async () => {
  await Bun.write(resolve(cwd, 'baseline.zmodel'), baseline)
  await expect(
    zenlev.migrate.create({
      name: 'stale',
      fromSchema: 'baseline.zmodel',
      toDb: true,
      confirmDrops(tables: readonly string[]) {
        raw.exec('CREATE TABLE new_live (id INTEGER PRIMARY KEY)')
        return tables
      },
    }),
  ).rejects.toThrow(/Schema changed[\s\S]*new_live/)
  expect(await zenlev.migrate.status()).toEqual([])
})

test('blocks unsupported DDL and rejects an incompatible provider', async () => {
  raw.exec('CREATE TABLE account (id TEXT PRIMARY KEY, contact TEXT, active INTEGER)')
  expect((await zenlev.db.push({ dropMissingTables: 'apply' })).status).toBe('blocked')
  await Bun.write(
    resolve(cwd, 'baseline.zmodel'),
    sqlite + 'model Account { id String @id @@map("account") }',
  )
  await expect(
    zenlev.migrate.create({ name: 'rewrite', fromSchema: 'baseline.zmodel' }),
  ).rejects.toThrow('rewrite')
  await Bun.write(resolve(cwd, 'schema.zmodel'), baseline.replace('sqlite', 'postgresql'))
  await expect(zenlev.db.push()).rejects.toThrow('provider does not match')
})

test('reads SQLite constraints and reports catalog objects that require manual migration', async () => {
  raw.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY, code TEXT UNIQUE, field_without_type);
    CREATE TABLE details (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES parent(id) ON DELETE SET NULL ON UPDATE RESTRICT,
      cascade_parent INTEGER REFERENCES parent(id) ON DELETE CASCADE ON UPDATE SET DEFAULT,
      implicit_id INTEGER REFERENCES parent,
      raw_text TEXT DEFAULT 'it''s valid',
      null_text TEXT DEFAULT NULL,
      num DECIMAL DEFAULT (40.5),
      expression TEXT DEFAULT (lower('DEFAULT'))
    );
    CREATE TABLE composite (left_id INTEGER, right_id INTEGER, PRIMARY KEY(right_id, left_id));
    CREATE TABLE generated (id INTEGER PRIMARY KEY, amount INT, doubled INT
      GENERATED ALWAYS AS (amount * 2) STORED, CHECK (amount > 0));
    CREATE INDEX ordered_code ON parent(code DESC) WHERE code IS NOT NULL;
    CREATE INDEX collated_code ON parent(code COLLATE NOCASE);
    CREATE VIEW enabled AS SELECT id FROM parent;
  `)
  const target = await loadSchemaModel({ cwd })
  const live = await readCatalog(db, target, [], false)
  expect(live.tables.find(({ name }) => name === 'composite')?.primaryKey).toEqual([
    'right_id',
    'left_id',
  ])
  const details = live.tables.find(({ name }) => name === 'details')!
  expect(details.foreignKeys).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ onDelete: 'SetNull', onUpdate: 'Restrict' }),
      expect.objectContaining({ onDelete: 'Cascade', onUpdate: 'SetDefault' }),
    ]),
  )
  expect(details.columns.find(({ name }) => name === 'raw_text')?.default).toEqual({
    kind: 'literal',
    value: "it's valid",
  })
  expect(details.columns.find(({ name }) => name === 'null_text')?.default).toEqual({
    kind: 'literal',
    value: null,
  })
  expect(details.columns.find(({ name }) => name === 'num')?.default).toEqual({
    kind: 'literal',
    value: 40.5,
  })
  expect(details.columns.find(({ name }) => name === 'expression')?.default).toEqual({
    kind: 'sql',
    sql: "lower('DEFAULT')",
  })
  expect(live.unsupported.map(({ message }) => message).join('\n')).toMatch(/enabled.*view/)
  expect(live.unsupported.map(({ message }) => message).join('\n')).toContain(
    'implicit SQLite foreign key',
  )
  expect(live.unsupported.map(({ message }) => message).join('\n')).toContain('generated columns')
  expect(live.unsupported.map(({ message }) => message).join('\n')).toMatch(
    /ordered, or collated index collated_code/,
  )
})

test('rolls direct SQLite DDL back when the second statement fails', async () => {
  const preview = await zenlev.db.push({ dryRun: true })
  const indexSql = preview.changes.operations.find(({ kind }) => kind === 'create-index')!.up[0]!
    .sql
  const indexName = indexSql.match(/create unique index ("[^"]+")/)![1]!
  raw.exec(
    'CREATE TABLE other (id INTEGER PRIMARY KEY); CREATE INDEX ' + indexName + ' ON other(id)',
  )
  const result = await zenlev.db.push({ dropMissingTables: 'skip' })
  expect(result).toMatchObject({ status: 'failed', executedStatements: 0 })
  expect(table('account')).toBe(false)
})
