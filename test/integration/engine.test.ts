import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Kysely } from 'kysely'
import {
  createKyselyAdapter,
  createZenlev,
  definePlugin,
  type MigrationMeta,
  type Plan,
  type Warning,
  type Zenlev,
} from '../../src'
import { createStore } from '../../src/store'
import { createBunSqliteDialect } from '../fixtures/bun-sqlite'

let cwd: string
let raw: Database
let db: Kysely<any>
let zenlev: Zenlev
let adapter: ReturnType<typeof createKyselyAdapter>
const createdAt = '2026-11-21T12:00:00.000Z'

beforeEach(async () => {
  cwd = await mkdtemp(resolve(import.meta.dir, '../.zenlev-engine-'))
  raw = new Database(':memory:')
  db = new Kysely({ dialect: createBunSqliteDialect(raw) })
  adapter = createKyselyAdapter(db, 'sqlite')
  zenlev = await createZenlev({ cwd, adapter, env: 'test' })
})

afterEach(async () => {
  await zenlev.close()
  await db.destroy()
  await rm(cwd, { recursive: true, force: true })
})

async function migration(
  id: string,
  up: string,
  down?: string,
  extra: Partial<MigrationMeta> = {},
): Promise<string> {
  const meta = { id, name: id, namespace: 'default', createdAt, ...extra }
  const path = resolve(cwd, 'migrations', id + '_' + meta.name + '.ts')
  await Bun.write(
    path,
    'export const meta = ' +
      JSON.stringify(meta) +
      '\nexport async function up(ctx) { ' +
      up +
      ' }\n' +
      (down === undefined ? '' : 'export async function down(ctx) { ' + down + ' }\n'),
  )
  return path
}

const createAccounts =
  "await ctx.db.schema.createTable('accounts').addColumn('id','integer').execute()"
const dropAccounts = "await ctx.db.schema.dropTable('accounts').execute()"
const addAccount = "await ctx.db.kysely.insertInto('accounts').values({ id: 1 }).execute()"
const removeAccount = "await ctx.db.kysely.deleteFrom('accounts').where('id','=',1).execute()"
const exists = (name: string) =>
  raw.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null

test('previews, applies and inspects a scoped dependency chain', async () => {
  await migration('aaa', createAccounts, dropAccounts, { namespace: 'predeploy' })
  await migration('bbb', addAccount, removeAccount, { dependsOn: ['aaa'], namespace: 'deploy' })
  expect(
    (await zenlev.migrate.apply({ namespace: ['deploy'], dryRun: true })).plan.blockers,
  ).toMatchObject([{ code: 'PENDING_PREREQUISITE', migrationId: 'bbb' }])
  expect(exists('zenlev_migrations')).toBe(false)
  expect(exists('accounts')).toBe(false)
  expect(await zenlev.migrate.tree({ format: 'mermaid' })).toContain('m_aaa --> m_bbb')
  expect(await zenlev.migrate.tree({ namespace: ['deploy'] })).toContain('bbb bbb [pending]')
  expect((await zenlev.migrate.apply({ namespace: ['predeploy'] })).status).toBe('ok')
  expect((await zenlev.migrate.apply({ namespace: ['deploy'] })).status).toBe('ok')
  expect(raw.query('SELECT * FROM accounts').all()).toEqual([{ id: 1 }])
  expect((await zenlev.migrate.status()).map(({ status }) => status)).toEqual([
    'applied',
    'applied',
  ])
  expect((await zenlev.migrate.apply()).migrations).toEqual([])
})

test('rolls back the migration plan and ledger together when a handler throws', async () => {
  await migration('aaa', createAccounts, dropAccounts)
  await migration('bbb', "throw new Error('second step failed')", undefined, { dependsOn: ['aaa'] })
  const result = await zenlev.migrate.apply()
  expect(result.status).toBe('failed')
  expect(result.migrations.map(({ status }) => status)).toEqual(['rolled_back', 'failed'])
  expect(result.migrations[1]?.error).toBe('second step failed')
  expect(exists('accounts')).toBe(false)
  expect(await createStore(adapter).read()).toEqual([])
})

test('continues independent nontransactional work and recovers the exact recorded attempt', async () => {
  const path = await migration('aaa', createAccounts + "; throw 'after DDL'")
  await migration('bbb', addAccount, undefined, { dependsOn: ['aaa'] })
  await migration(
    'ccc',
    "await ctx.db.schema.createTable('independent').addColumn('id','integer').execute()",
  )
  const result = await zenlev.migrate.apply({ noTransaction: true, continueOnFailure: true })
  expect(result.status).toBe('partial')
  expect(result.migrations.map(({ status }) => status)).toEqual(['failed', 'skipped', 'applied'])
  expect(exists('accounts')).toBe(true)
  expect(exists('independent')).toBe(true)
  const store = createStore(adapter)
  const attempt = (await store.read()).find(({ meta }) => meta.id === 'aaa')
  expect(attempt?.attemptId).toBeString()
  expect((await zenlev.migrate.apply()).plan.blockers).toContainEqual(
    expect.objectContaining({
      migrationId: 'aaa',
      code: 'UNRESOLVED_ATTEMPT',
    }),
  )
  await zenlev.migrate.recover({
    id: 'aaa',
    attemptId: attempt!.attemptId!,
    action: 'applied',
    actor: 'test',
    reason: 'checked table',
    evidence: 'schema query verified',
  })
  expect((await zenlev.migrate.apply()).status).toBe('ok')
  expect(await Bun.file(path).exists()).toBe(true)
  expect(raw.query('SELECT * FROM accounts').all()).toEqual([{ id: 1 }])
})

test.each([
  ['transaction', (plan: Plan) => ({ ...plan, transactional: false }), /cannot change transaction/],
  [
    'order',
    (plan: Plan) => ({ ...plan, migrations: plan.migrations.toReversed() }),
    /prerequisite/,
  ],
  [
    'duplicate',
    (plan: Plan) => ({ ...plan, migrations: [plan.migrations[0]!, ...plan.migrations] }),
    /duplicate/,
  ],
] as const)('rejects an invalid plugin plan (%s)', async (_label, replace, error) => {
  await migration('aaa', createAccounts)
  await migration('bbb', addAccount, undefined, { dependsOn: ['aaa'] })
  const plugin = definePlugin({
    name: 'planner',
    setup(api) {
      api.onPlan((_ctx, plan) => replace(plan))
    },
  })
  const client = await createZenlev({ cwd, adapter, plugins: [plugin] })
  try {
    await expect(client.migrate.apply({ planOnly: true })).rejects.toThrow(error)
    expect(exists('zenlev_migrations')).toBe(false)
    expect(exists('accounts')).toBe(false)
  } finally {
    await client.close()
  }
})

test('lets plugins narrow a plan without substituting identities or suppressing warnings', async () => {
  const declared = { code: 'DESTRUCTIVE_DATA', message: 'Review data changes' } as const
  const warning = { code: 'UNIQUE_CONSTRAINT', message: 'Review index changes' } as const
  await migration('aaa', createAccounts, undefined, { warnings: [declared] })
  await migration('bbb', addAccount, undefined, { dependsOn: ['aaa'] })
  const plugin = definePlugin({
    name: 'planner',
    setup(api) {
      api.onPlan((_ctx, plan) => ({
        ...plan,
        migrations: [{ ...plan.migrations[0]!, hash: 'ignored' }],
        warnings: [warning, declared],
      }))
    },
  })
  const observed: Warning[] = []
  const client = await createZenlev({
    cwd,
    adapter,
    plugins: [plugin],
    onWarning(next) {
      observed.push(next)
      throw new Error('warning observer')
    },
  })
  try {
    const result = await client.migrate.apply()
    expect(result.status).toBe('ok')
    expect(result.plan.migrations).toHaveLength(1)
    expect(result.plan.migrations[0]?.hash).toEqual((await createStore(adapter).read())[0]?.hash)
    expect(observed).toEqual([declared, warning])
    expect(raw.query('SELECT * FROM accounts').all()).toEqual([])
  } finally {
    await client.close()
  }
})

test('continues eligible migrations after cancellation and observes committed outcomes', async () => {
  await migration('aaa', "throw Error('cancelled handler must not run')")
  await migration('bbb', "throw Error('dependent handler must not run')", undefined, {
    dependsOn: ['aaa'],
  })
  await migration(
    'ccc',
    createAccounts +
      "; await ctx.db.kysely.deleteFrom('accounts').execute(); await ctx.db.schema.createIndex('account_id').unique().on('accounts').column('id').execute()",
  )
  const effects: string[] = []
  const plugin = definePlugin({
    name: 'guard',
    setup(api) {
      api.onBeforeMigration((_ctx, { id }) => {
        if (id === 'aaa') return false
      })
      api.onAfterMigration((_ctx, { id }, result) => {
        effects.push(id + ':' + result.status)
      })
      api.onWarning((_ctx, warning) => {
        effects.push(warning.code)
      })
      api.onStoreWrite((_ctx, delta) => {
        effects.push(delta.applied.map(({ id }) => id).join())
      })
    },
  })
  const client = await createZenlev({ cwd, adapter, plugins: [plugin] })
  try {
    const result = await client.migrate.apply()
    expect(result.status).toBe('partial')
    expect(effects).toEqual([
      'aaa:skipped',
      'bbb:skipped',
      'ccc:applied',
      'DESTRUCTIVE_DATA',
      'UNIQUE_CONSTRAINT',
      'ccc',
    ])
    expect(exists('accounts')).toBe(true)
  } finally {
    await client.close()
  }
})

test('stops a nontransactional plan when continuation is omitted', async () => {
  await migration('aaa', "throw new Error('stop')")
  await migration('bbb', createAccounts)
  expect((await zenlev.migrate.apply({ noTransaction: true })).migrations).toHaveLength(1)
  expect(exists('accounts')).toBe(false)
})

test.each(['cascade', 'compensate'] as const)('generates and applies %s rollback', async (mode) => {
  await migration('aaa', createAccounts, dropAccounts)
  await migration('bbb', addAccount, removeAccount, { dependsOn: ['aaa'] })
  expect((await zenlev.migrate.apply()).status).toBe('ok')
  const dry = await zenlev.migrate.rollback({ id: 'aaa', mode, dryRun: true })
  expect(dry.migration).toBeUndefined()
  expect(dry.reversals).toEqual(mode === 'cascade' ? ['bbb', 'aaa'] : ['aaa'])
  expect(dry.warnings.map(({ code }) => code)).toEqual(
    mode === 'cascade' ? [] : ['ACTIVE_DEPENDENTS'],
  )
  const generated = await zenlev.migrate.rollback({ id: 'aaa', mode })
  expect(generated.migration?.supersedes).toEqual(dry.reversals)
  expect(await zenlev.migrate.tree({ format: 'mermaid', showSupersedes: true })).toContain(
    'supersedes',
  )
  expect(await zenlev.migrate.tree({ showSupersedes: true })).toContain('→')
  expect((await zenlev.migrate.apply()).status).toBe('ok')
  expect(exists('accounts')).toBe(false)
  const status = await zenlev.migrate.status()
  expect(status.find(({ id }) => id === 'aaa')?.status).toBe('rolled_back')
  expect(status.find(({ id }) => id === 'bbb')?.status).toBe(
    mode === 'cascade' ? 'rolled_back' : 'applied',
  )
})

test('rechecks active cascade members and source hashes before reversal', async () => {
  const path = await migration('aaa', createAccounts, dropAccounts)
  await migration('bbb', addAccount, removeAccount, { dependsOn: ['aaa'] })
  await zenlev.migrate.apply({ only: ['aaa'] })
  const rollback = await zenlev.migrate.rollback({ id: 'aaa', mode: 'cascade' })
  await zenlev.migrate.remove({ id: ['bbb'], force: true })
  expect((await zenlev.migrate.apply({ only: [rollback.migration!.id] })).status).toBe('ok')
  expect(exists('accounts')).toBe(false)
  await Bun.write(path, (await Bun.file(path).text()) + '\n// edit')
  expect(await zenlev.migrate.status()).toContainEqual(
    expect.objectContaining({ id: 'aaa', status: 'rolled_back' }),
  )
})

test('applies a generated rollback to a destination that never applied its target', async () => {
  await migration('aaa', createAccounts, dropAccounts)
  await zenlev.migrate.apply()
  const generated = await zenlev.migrate.rollback({ id: 'aaa', mode: 'cascade' })
  const destination = new Kysely({ dialect: createBunSqliteDialect(new Database(':memory:')) })
  const target = await createZenlev({ cwd, adapter: createKyselyAdapter(destination, 'sqlite') })
  try {
    expect((await target.migrate.apply()).migrations).toMatchObject([
      { id: generated.migration!.id, status: 'applied' },
    ])
    expect(await destination.introspection.getTables()).not.toContainEqual(
      expect.objectContaining({ name: 'accounts' }),
    )
  } finally {
    await target.close()
    await destination.destroy()
  }
})

test('rejects invalid rollback modes, unapplied targets and active migrations without down', async () => {
  await migration('aaa', createAccounts)
  await expect(zenlev.migrate.rollback({ id: 'aaa', mode: 'invalid' as never })).rejects.toThrow(
    'either',
  )
  await expect(zenlev.migrate.rollback({ id: 'aaa', mode: 'cascade' })).rejects.toThrow(
    'actively applied',
  )
  await zenlev.migrate.apply()
  await expect(zenlev.migrate.rollback({ id: 'aaa', mode: 'cascade' })).rejects.toThrow(
    'no local down',
  )
})

test('retains the executed hash while resolving or reshaping an observed edit', async () => {
  const path = await migration('aaa', createAccounts, dropAccounts)
  await zenlev.migrate.apply()
  const original = (await zenlev.migrate.status())[0]?.appliedHash
  await Bun.write(path, (await Bun.file(path).text()) + '\n// edit')
  const changed = (await zenlev.migrate.status({ mismatchedOnly: true }))[0]?.hash
  expect(changed).toBeString()
  await expect(zenlev.migrate.resolve({ id: 'aaa', hash: original! })).rejects.toThrow(
    'currently observed',
  )
  await expect(zenlev.migrate.resolve({ id: 'zzz' })).rejects.toThrow('without a local')
  expect(await zenlev.migrate.resolve({ id: 'aaa', actor: 'test', reason: 'reviewed' })).toEqual({
    id: 'aaa',
    hash: changed!,
  })
  expect(await zenlev.migrate.status({ showResolved: true })).toContainEqual(
    expect.objectContaining({ status: 'resolved', appliedHash: original }),
  )
  expect(await zenlev.migrate.status()).toContainEqual(
    expect.objectContaining({ status: 'applied', appliedHash: original }),
  )
  await expect(zenlev.migrate.reshape({ id: 'aaa' })).rejects.toThrow('exactly one')
  await zenlev.migrate.reshape({ id: 'aaa', drop: changed! })
  expect(await zenlev.migrate.status({ mismatchedOnly: true })).toHaveLength(1)
  await zenlev.migrate.reshape({ id: 'aaa', accept: changed! })
  expect(await zenlev.migrate.status({ mismatchedOnly: true })).toHaveLength(0)
})

test('validates authoring and removal commands and confirms actual file deletion', async () => {
  await expect(zenlev.migrate.create({ name: 'child', dependsOn: ['missing'] })).rejects.toThrow(
    'Unknown migration',
  )
  const parent = await zenlev.migrate.create({ name: 'parent' })
  const child = await zenlev.migrate.create({ name: 'child', dependsOn: [parent.id] })
  await expect(
    zenlev.migrate.create({
      name: 'cycle',
      supersedes: [parent.id],
      dependsOn: [child.id],
    }),
  ).rejects.toThrow('dependency graph contains a cycle')
  expect(await zenlev.migrate.status()).toHaveLength(2)
  await expect(zenlev.migrate.remove({})).rejects.toThrow('Choose migration')
  await expect(zenlev.migrate.remove({ all: true, namespace: 'default' })).rejects.toThrow(
    'without IDs',
  )
  await expect(zenlev.migrate.remove({ id: ['missing'] })).rejects.toThrow('No local')
  await expect(zenlev.migrate.remove({ id: [parent.id], dryRun: true })).rejects.toThrow()
  expect(await zenlev.migrate.remove({ id: [child.id], dryRun: true })).toHaveLength(1)
  expect(await Bun.file(child.filePath).exists()).toBe(true)
  await expect(zenlev.migrate.remove({ id: [child.id] })).rejects.toThrow('requires confirmation')
  expect(await zenlev.migrate.remove({ id: [child.id], confirm: () => true })).toHaveLength(1)
  expect(await Bun.file(child.filePath).exists()).toBe(false)
  expect(await zenlev.migrate.remove({ namespace: 'missing', force: true })).toEqual([])
  await zenlev.migrate.apply()
  await expect(zenlev.migrate.remove({ id: [parent.id], force: true })).rejects.toThrow('recorded')
})

test('supports offline inspection and rejects database-only operations', async () => {
  const offline = await createZenlev({ cwd })
  try {
    await offline.migrate.create({ name: 'offline', empty: true })
    expect(await offline.migrate.status()).toHaveLength(1)
    expect(await offline.migrate.remove({ all: true, dryRun: true })).toHaveLength(1)
    await expect(offline.migrate.remove({ all: true, force: true })).rejects.toThrow(
      'verify that the migrations are unrecorded',
    )
    await expect(offline.migrate.apply()).rejects.toThrow('Configure a ZenStack client')
    await expect(offline.migrate.rollback({ id: 'aaa', mode: 'cascade' })).rejects.toThrow(
      'Configure a database',
    )
  } finally {
    await offline.close()
  }
})
