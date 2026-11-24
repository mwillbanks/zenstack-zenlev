import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Kysely } from 'kysely'
import { createKyselyAdapter, createZenlev, definePlugin, lintPlugin } from '../../src'
import { authorMigration } from '../../src/migrate/files'
import { createBunSqliteDialect } from '../fixtures/sqlite'

let cwd: string
let sqlite: Database
let db: Kysely<any>
const createdAt = new Date('2026-11-21T12:00:00.000Z')

beforeEach(async () => {
  cwd = await mkdtemp(join(import.meta.dir, '.zenlev-lint-'))
  sqlite = new Database(':memory:')
  db = new Kysely({ dialect: createBunSqliteDialect(sqlite) })
})

afterEach(async () => {
  await db.destroy()
  await rm(cwd, { recursive: true, force: true })
})

function write(path: string, content: string | object) {
  return Bun.write(join(cwd, path), typeof content === 'string' ? content : JSON.stringify(content))
}

const datasource = 'datasource db { provider = "sqlite" }\n'

test('checks the final transformed apply plan and warns when catalog evidence is unavailable', async () => {
  await migration(
    'aaaa',
    'items',
    "await ctx.db.schema.createTable('items').addColumn('id', 'text', c => c.primaryKey()).execute()",
  )
  await migration(
    'bbbb',
    'bad',
    "await ctx.db.schema.createTable('BadTable').addColumn('id', 'text', c => c.primaryKey()).execute()",
  )
  const zenlev = await createZenlev({
    cwd,
    adapter: createKyselyAdapter(db, 'sqlite'),
    lint: {
      catalog: {
        dialect: 'sqlite',
        read() {
          throw new Error('Unavailable catalog')
        },
      },
    },
    plugins: [
      lintPlugin(),
      definePlugin({
        name: 'select-first',
        setup(api) {
          api.onPlan((_context, plan) => ({ ...plan, migrations: plan.migrations.slice(0, 1) }))
        },
      }),
    ],
  })
  try {
    const result = await zenlev.migrate.apply()
    expect(result.status).toBe('ok')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ ruleId: 'zenlev/coverage', severity: 'warn' }),
    ])
    expect(
      sqlite.query("SELECT name FROM sqlite_schema WHERE name IN ('items','BadTable')").all(),
    ).toEqual([{ name: 'items' }])
  } finally {
    await zenlev.close()
  }
})

test('warns on opaque writes without reading the catalog', async () => {
  await migration('aaaa', 'opaque', 'await Promise.resolve()')
  const catalogRead = mock(() => ({ nodes: [], gaps: [] }))
  const zenlev = await createZenlev({
    cwd,
    adapter: createKyselyAdapter(db, 'sqlite'),
    lint: { catalog: { dialect: 'sqlite', read: catalogRead } },
    plugins: [lintPlugin()],
  })
  try {
    const result = await zenlev.migrate.apply()
    expect(result.status).toBe('ok')
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ ruleId: 'zenlev/coverage', severity: 'warn' }),
    ])
    expect(catalogRead).not.toHaveBeenCalled()
  } finally {
    await zenlev.close()
  }
})

function migration(
  id: string,
  name: string,
  upBody: string,
  downBody?: string,
  dependsOn?: readonly string[],
) {
  return authorMigration(
    join(cwd, 'migrations'),
    {
      name,
      upBody,
      ...(downBody === undefined ? {} : { downBody }),
      ...(dependsOn ? { dependsOn } : {}),
    },
    { now: () => createdAt, createId: () => id },
  )
}

test('migration plugin checks final selection before any handler, and warning-only plans execute', async () => {
  await migration(
    'aaaa',
    'items',
    "await ctx.db.schema.createTable('items').addColumn('id', 'text', c => c.primaryKey()).execute()",
  )
  await migration(
    'bbbb',
    'bad',
    "await ctx.db.schema.createTable('BadTable').addColumn('id', 'text', c => c.primaryKey()).execute()",
    undefined,
    ['aaaa'],
  )
  const adapter = createKyselyAdapter(db, 'sqlite')
  const calls: string[] = []
  const observer = definePlugin({
    name: 'observer',
    setup(hooks) {
      hooks.onBeforeWrite((_ctx, plan) => {
        calls.push(plan.command)
      })
    },
  })
  const zenlev = await createZenlev({ cwd, adapter, plugins: [lintPlugin(), observer] })
  try {
    expect((await zenlev.migrate.apply({ planOnly: true })).status).toBe('planned')
    expect(calls).toEqual([])
    const blocked = await zenlev.migrate.apply()
    expect(blocked).toMatchObject({
      status: 'failed',
      migrations: [],
      diagnostics: [
        expect.objectContaining({ ruleId: 'zenlev/naming/table-case', severity: 'error' }),
      ],
    })
    expect(calls).toEqual(['migrate apply'])
    expect(
      sqlite.query("SELECT name FROM sqlite_schema WHERE name IN ('items','BadTable')").all(),
    ).toEqual([])
  } finally {
    await zenlev.close()
  }

  const warnings = await createZenlev({
    cwd,
    adapter,
    plugins: [lintPlugin()],
    lint: { rules: { 'zenlev/naming/table-case': 'warn' } },
  })
  try {
    const result = await warnings.migrate.apply()
    expect(result.status).toBe('ok')
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'warn' })])
  } finally {
    await warnings.close()
  }
})

test('gate checks resolved rollback down handlers and leaves reverted writes unapplied', async () => {
  await migration(
    'aaaa',
    'items',
    "await ctx.db.schema.createTable('items').addColumn('id', 'text', c => c.primaryKey()).execute()",
    "await ctx.db.schema.createTable('BadTable').addColumn('id', 'text', c => c.primaryKey()).execute()",
  )
  const adapter = createKyselyAdapter(db, 'sqlite')
  const zenlev = await createZenlev({ cwd, adapter, plugins: [lintPlugin()] })
  try {
    expect((await zenlev.migrate.apply()).status).toBe('ok')
    await zenlev.migrate.rollback({ id: 'aaaa', mode: 'cascade', format: false })
    const result = await zenlev.migrate.apply()
    expect(result.status).toBe('failed')
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'zenlev/naming/table-case',
          source: expect.objectContaining({ path: 'migrations/aaaa_items.ts' }),
        }),
      ]),
    )
    expect(sqlite.query("SELECT name FROM sqlite_schema WHERE name='BadTable'").all()).toEqual([])
  } finally {
    await zenlev.close()
  }
})

test('schema push runs the lint gate only before executing affected definitions', async () => {
  await write('schema.zmodel', datasource + 'model item { id String @id @@map("BadTable") }')
  const adapter = createKyselyAdapter(db, 'sqlite')
  const editSource = definePlugin({
    name: 'edit-source',
    setup(hooks) {
      hooks.onBeforeWrite(async () => {
        await write('schema.zmodel', datasource + 'model Item { id String @id @@map("BadTable") }')
      })
    },
  })
  const zenlev = await createZenlev({ cwd, adapter, plugins: [editSource, lintPlugin()] })
  try {
    expect((await zenlev.db.push({ sql: true })).status).toBe('planned')
    const result = await zenlev.db.push()
    expect(result.status).toBe('blocked')
    expect(result.diagnostics?.map(({ ruleId }) => ruleId)).toContain('zenlev/naming/model-case')
    expect(result.diagnostics?.map(({ ruleId }) => ruleId)).toContain('zenlev/naming/table-case')
    expect(sqlite.query("SELECT name FROM sqlite_schema WHERE name='BadTable'").all()).toEqual([])
  } finally {
    await zenlev.close()
  }
})

test('write hooks inspect identities with non-cloneable migration metadata', async () => {
  const authored = await migration(
    'aaaa',
    'items',
    "await ctx.db.schema.createTable('items').addColumn('id', 'text', c => c.primaryKey()).execute()",
  )
  const source = await Bun.file(authored.filePath).text()
  await Bun.write(
    authored.filePath,
    source.replace('"custom": {}', '"custom": { transform: () => 1 }'),
  )
  const observe = mock(() => undefined)
  const zenlev = await createZenlev({
    cwd,
    adapter: createKyselyAdapter(db, 'sqlite'),
    plugins: [
      lintPlugin(),
      definePlugin({
        name: 'inspect-write',
        setup(api) {
          api.onBeforeWrite((_context, plan) => {
            expect(plan.command).toBe('migrate apply')
            if (plan.command === 'migrate apply') {
              expect(plan.handlers[0]?.migration).toMatchObject({
                id: 'aaaa',
                filePath: authored.filePath,
              })
              expect(plan.handlers[0]?.migration).not.toHaveProperty('custom')
            }
            observe()
          })
        },
      }),
    ],
  })
  try {
    expect((await zenlev.migrate.apply()).status).toBe('ok')
    expect(observe).toHaveBeenCalledTimes(1)
  } finally {
    await zenlev.close()
  }
})

test('write lint vetoes dropping an index that covers a foreign key', async () => {
  sqlite.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, customer_id TEXT REFERENCES customers(id));
    CREATE INDEX items_customer ON items (customer_id);
  `)
  await migration(
    'aaaa',
    'remove_index',
    "await ctx.db.schema.dropIndex('items_customer').execute()",
  )
  const zenlev = await createZenlev({
    cwd,
    adapter: createKyselyAdapter(db, 'sqlite'),
    plugins: [lintPlugin()],
    lint: { rules: { 'zenlev/keys/foreign-key-index': 'error' } },
  })
  try {
    const result = await zenlev.migrate.apply()
    expect(result.status).toBe('failed')
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'zenlev/keys/foreign-key-index', severity: 'error' }),
      ]),
    )
    expect(
      sqlite.query("SELECT name FROM sqlite_schema WHERE name = 'items_customer'").all(),
    ).toHaveLength(1)
  } finally {
    await zenlev.close()
  }
})

test('write lint applies overrides to catalog-style qualified index identities', async () => {
  sqlite.exec('CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL);')
  await migration(
    'aaaa',
    'add_index',
    "await ctx.db.schema.createIndex('Nonstandard').on('items').column('id').execute()",
  )
  const zenlev = await createZenlev({
    cwd,
    adapter: createKyselyAdapter(db, 'sqlite'),
    plugins: [lintPlugin()],
    lint: {
      rules: { 'zenlev/naming/identifier': ['error', { kinds: ['index'], format: 'snake_case' }] },
      overrides: [
        { identities: ['main.items.Nonstandard'], rules: { 'zenlev/naming/identifier': 'off' } },
      ],
    },
  })
  try {
    const result = await zenlev.migrate.apply()
    expect(result.status).toBe('ok')
    expect(
      sqlite.query("SELECT name FROM sqlite_schema WHERE name = 'Nonstandard'").all(),
    ).toHaveLength(1)
  } finally {
    await zenlev.close()
  }
})

test('write lint forgets indexes removed by an earlier table drop', async () => {
  sqlite.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL);
    CREATE INDEX items_id ON items (id);
  `)
  await migration(
    'aaaa',
    'drop_items',
    `
    await ctx.db.schema.dropTable('items').execute()
    await ctx.db.schema.dropIndex('items_id').ifExists().execute()
  `,
  )
  const indexDrops: string[] = []
  const zenlev = await createZenlev({
    cwd,
    adapter: createKyselyAdapter(db, 'sqlite'),
    plugins: [lintPlugin()],
    lint: {
      plugins: [
        {
          meta: { name: 'test' },
          rules: {
            'record-index-drop': {
              meta: { messages: {} },
              create: () => ({
                index(node) {
                  if (node.action === 'drop') indexDrops.push(node.identity ?? node.name)
                },
              }),
            },
          },
        },
      ],
      rules: { 'test/record-index-drop': 'error' },
    },
  })
  try {
    expect((await zenlev.migrate.apply()).status).toBe('ok')
    expect(indexDrops).toEqual(['main.items_id'])
    expect(
      sqlite.query("SELECT name FROM sqlite_schema WHERE name IN ('items', 'items_id')").all(),
    ).toEqual([])
  } finally {
    await zenlev.close()
  }
})
