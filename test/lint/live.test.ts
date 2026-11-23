import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Kysely } from 'kysely'
import { createKyselyAdapter, lintProject, type LintConfig } from '../../src'
import { createBunSqliteDialect } from '../fixtures/sqlite'

let cwd: string
let sqlite: Database
let db: Kysely<any>

beforeEach(async () => {
  cwd = await mkdtemp(join(import.meta.dir, '.zenlev-lint-'))
  sqlite = new Database(':memory:')
  db = new Kysely({ dialect: createBunSqliteDialect(sqlite) })
})

afterEach(async () => {
  await db.destroy()
  await rm(cwd, { recursive: true, force: true })
})

test('audits SQLite rowid, CHECK names, index and view catalogs through a borrowed adapter', async () => {
  sqlite.exec(`
    CREATE TABLE "WrongTable" (
      "WrongID" INTEGER PRIMARY KEY,
      name TEXT CONSTRAINT nonempty CHECK(length(name) > 0)
    );
    CREATE INDEX wrong_name ON "WrongTable"(name);
    CREATE TABLE rows_desc(id INTEGER PRIMARY KEY DESC);
    CREATE TABLE rows_without(id INTEGER PRIMARY KEY) WITHOUT ROWID;
    CREATE VIEW saved_view AS SELECT name FROM "WrongTable";
    CREATE TRIGGER update_name AFTER INSERT ON "WrongTable"
    BEGIN UPDATE "WrongTable" SET name = lower(new.name); END;
    ATTACH DATABASE ':memory:' AS other;
    CREATE TABLE other.attached_items (id TEXT PRIMARY KEY);
  `)
  const adapter = createKyselyAdapter(db, 'sqlite')
  const result = await lintProject(
    {
      cwd,
      adapter,
      lint: {
        namespaces: ['main', 'other', 'absent'],
        rules: { 'zenlev/objects/restricted': ['error', { kinds: ['view', 'trigger'] }] },
      },
    },
    { live: true },
  )
  expect(
    result.diagnostics.filter(({ ruleId }) => ruleId === 'zenlev/keys/no-sequential'),
  ).toHaveLength(1)
  expect(result.diagnostics.map(({ identity }) => identity)).toContain('main.saved_view')
  expect(result.coverage.gaps).toEqual(
    expect.arrayContaining([expect.objectContaining({ identity: 'absent' })]),
  )
  expect(sqlite.query('SELECT count(*) AS count FROM "WrongTable"').get()).toEqual({ count: 0 })
})

test('reports unsupported SQLite catalog DDL against the table identity', async () => {
  sqlite.exec("CREATE TABLE 'legacy_items' (id TEXT PRIMARY KEY)")
  const result = await lintProject(
    { cwd, adapter: createKyselyAdapter(db, 'sqlite'), lint: { presets: [] } },
    { live: true },
  )
  expect(result.coverage.gaps).toContainEqual(
    expect.objectContaining({ identity: 'main.legacy_items' }),
  )
})

test('uses custom catalog capabilities and disposes custom connections after failure', async () => {
  const disposed: string[] = []
  const provider: LintConfig['catalog'] = {
    dialect: 'custom',
    connect(environment) {
      return {
        physical: db,
        dispose() {
          disposed.push(environment.name)
        },
      }
    },
    read() {
      throw new Error('catalog connection failed')
    },
  }
  await expect(
    lintProject({ cwd, env: 'qa', lint: { catalog: provider } }, { live: true }),
  ).rejects.toThrow('catalog connection failed')
  expect(disposed).toEqual(['qa'])
  const adapter = createKyselyAdapter(db, 'sqlite')
  await expect(
    lintProject(
      { cwd, adapter, lint: { catalog: { dialect: 'custom', read: provider.read } } },
      { live: true },
    ),
  ).rejects.toThrow('does not match')
  await expect(lintProject({ cwd }, { live: true })).rejects.toThrow('Configure a ZenStack client')
  const custom = await lintProject(
    {
      cwd,
      adapter,
      lint: {
        catalog: {
          dialect: 'sqlite',
          read() {
            return { nodes: [], gaps: [], capabilities: ['provided'] }
          },
        },
      },
    },
    { live: true },
  )
  expect(custom.coverage.capabilities).toEqual(['provided'])
})
