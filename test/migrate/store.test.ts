import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Kysely } from 'kysely'
import { createKyselyAdapter } from '../../src/database'
import { createStore, type StoreAudit } from '../../src/migrate/store'
import type { DatabaseAdapter, MigrationIdentity, StoreConfig } from '../../src/types'
import { createBunSqliteDialect } from '../fixtures/sqlite'

const hash = 'a'.repeat(64)
const alternate = 'b'.repeat(64)
const at = new Date('2026-01-02T03:04:05.000Z')
const audit: StoreAudit = { actor: 'operator', reason: 'reviewed' }
interface Fixture {
  readonly sqlite: Database
  readonly db: Kysely<any>
  readonly adapter: DatabaseAdapter<Kysely<any>, any>
  readonly store: ReturnType<typeof createStore>
}

const fixtures: Fixture[] = []

function fixture(config: StoreConfig = {}): Fixture {
  const sqlite = new Database(':memory:')
  const db = new Kysely({ dialect: createBunSqliteDialect(sqlite) })
  const adapter = createKyselyAdapter(db, 'sqlite')
  let sequence = 0
  let store: ReturnType<typeof createStore>
  try {
    store = createStore(adapter, config, {
      now: () => at,
      ownerId: () => 'owner-' + ++sequence,
    })
  } catch (error) {
    sqlite.close()
    throw error
  }
  const value = { sqlite, db, adapter, store }
  fixtures.push(value)
  return value
}

function migration(id = 'migration-a'): MigrationIdentity {
  return {
    id,
    name: 'add_accounts',
    namespace: 'default',
    createdAt: at.toISOString(),
    dependsOn: [],
    filePath: '/private/project/migrations/' + id + '.ts',
    hash,
  }
}

async function applied(f: ReturnType<typeof fixture>, id = 'migration-a') {
  await f.store.withLock(async (owner) => {
    await f.store.start(f.adapter.root, owner, migration(id), 'attempt-' + id)
    await f.store.apply(f.adapter.root, owner, migration(id), [], 42)
  })
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.db.destroy()))
})

describe('ledger initialization and names', () => {
  test('reads an absent store without creating any tables', async () => {
    const f = fixture()
    expect(await f.store.read()).toEqual([])
    expect(await f.store.lockInfo()).toBeUndefined()
    expect(f.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([])
  })

  test('initializes one versioned store with prefixed or overridden names', async () => {
    const f = fixture({ tableName: 'custom_migrations', lockTableName: 'custom_lock' })
    expect(f.store.tables.map((table) => table.name)).toEqual([
      'custom_migrations',
      'custom_migrations_resolutions',
      'custom_lock',
      'custom_migrations_audit',
    ])
    await f.store.withLock(async (owner) => {
      expect(await f.store.lockInfo()).toEqual({ owner, acquiredAt: at.toISOString() })
      await f.store.assertOwner(f.adapter.root, owner)
      await expect(f.store.assertOwner(f.adapter.root, 'wrong')).rejects.toThrow(
        'ownership changed',
      )
    })
    expect(await f.store.lockInfo()).toEqual({ owner: null, acquiredAt: null })
    await f.store.withLock(async () => {})
    expect(await f.store.read()).toEqual([])
  })

  test('declares PostgreSQL and MySQL namespace defaults and table overrides', () => {
    const f = fixture()
    expect(createStore({ ...f.adapter, dialect: 'postgresql' }).tables[0]).toEqual({
      name: 'migrations',
      namespace: 'zenlev',
    })
    expect(createStore({ ...f.adapter, dialect: 'mysql' }).tables[0]).toEqual({
      name: 'migrations',
      namespace: 'zenlev',
    })
    expect(
      createStore({ ...f.adapter, dialect: 'postgresql' }, { location: 'table' }).tables[0],
    ).toEqual({ name: 'zenlev_migrations', namespace: undefined })
    expect(
      createStore({ ...f.adapter, dialect: 'postgresql' }, { schemaName: 'custom' }).tables[0]
        ?.namespace,
    ).toBe('custom')
    expect(
      createStore({ ...f.adapter, dialect: 'mysql' }, { databaseName: 'custom' }).tables[0]
        ?.namespace,
    ).toBe('custom')
  })

  test.each([
    { location: 'schema' },
    { location: 'database' },
    { schemaName: 'bad' },
    { databaseName: 'bad' },
    { tableName: 'not.valid' },
    { tableName: 'x'.repeat(64) },
    { lockTableName: 'zenlev_migrations' },
    { tableName: 'x'.repeat(60) },
  ] as StoreConfig[])('rejects incompatible or unsafe store identifiers %j', (config) => {
    expect(() => fixture(config)).toThrow()
  })

  test('rejects future and incomplete ledger versions', async () => {
    const f = fixture()
    await f.store.withLock(async () => {})
    f.sqlite.run('UPDATE zenlev_lock SET version = 2')
    await expect(f.store.read()).rejects.toThrow('ledger version')
    await expect(f.store.withLock(async () => {})).rejects.toThrow('ledger version')
    f.sqlite.run('DELETE FROM zenlev_lock')
    await expect(f.store.lockInfo()).rejects.toThrow('ledger version')
  })
})

describe('lock ownership', () => {
  test('excludes another runner and releases after command errors', async () => {
    const f = fixture()
    const competing = createStore(f.adapter, {}, { now: () => at, ownerId: () => 'other' })
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const command = f.store.withLock(async () => {
      entered.resolve()
      await finish.promise
      throw new Error('command failed')
    })
    await entered.promise
    await expect(competing.withLock(async () => {})).rejects.toThrow('locked')
    finish.resolve()
    await expect(command).rejects.toThrow('command failed')
    await competing.withLock(async () => {})
  })

  test('rejects invalid owner IDs', async () => {
    const f = fixture()
    const invalid = createStore(f.adapter, {}, { now: () => at, ownerId: () => '' })
    await expect(invalid.withLock(async () => {})).rejects.toThrow('owner')
  })

  test('detects ownership changed before release', async () => {
    const f = fixture()
    await expect(
      f.store.withLock(async () => {
        f.sqlite.run("UPDATE zenlev_lock SET owner = 'recovered'")
      }),
    ).rejects.toThrow('ownership changed before release')
  })

  test('rejects a transaction as the ledger root', async () => {
    const f = fixture()
    await f.adapter.transaction(async (session) => {
      const invalid = createStore({ ...f.adapter, root: session })
      await expect(invalid.withLock(async () => {})).rejects.toThrow('transaction client')
      await expect(
        invalid.recover({
          action: 'release-lock',
          owner: 'x',
          actor: 'a',
          reason: 'r',
          evidence: 'e',
        }),
      ).rejects.toThrow('transaction client')
    })
  })
})

describe('attempt state and history', () => {
  test('records metadata and immutable executed hashes with accepted alternatives', async () => {
    const f = fixture()
    await applied(f)
    await f.store.withLock(async (owner) => {
      await f.store.acceptHash(f.adapter.root, owner, 'migration-a', alternate, audit)
      await f.store.acceptHash(f.adapter.root, owner, 'migration-a', alternate, audit)
      const records = await f.store.read()
      expect(records[0]).toMatchObject({
        hash,
        status: 'applied',
        durationMs: 42,
        unresolvedAttempt: false,
        attemptId: 'attempt-migration-a',
        appliedAt: at.toISOString(),
        acceptedHashes: [alternate],
      })
      expect(records[0]?.meta).not.toHaveProperty('filePath')
      expect(records[0]?.meta).not.toHaveProperty('hash')
      await f.store.dropHash(f.adapter.root, owner, 'migration-a', alternate, { actor: 'operator' })
      expect((await f.store.read())[0]?.acceptedHashes).toEqual([])
      expect(f.sqlite.query('SELECT action FROM zenlev_migrations_audit').all()).toHaveLength(3)
      await expect(f.store.start(f.adapter.root, owner, migration(), 'again')).rejects.toThrow(
        'requires attempt recovery',
      )
    })
  })

  test('rolls accepted hashes back when the audit write fails', async () => {
    const f = fixture()
    await applied(f)
    await f.store.withLock(async (owner) => {
      f.sqlite.run(
        "CREATE TRIGGER audit_denied BEFORE INSERT ON zenlev_migrations_audit BEGIN SELECT RAISE(ABORT, 'audit denied'); END",
      )
      await expect(
        f.store.acceptHash(f.adapter.root, owner, 'migration-a', alternate, audit),
      ).rejects.toThrow('audit denied')
      expect((await f.store.read())[0]?.acceptedHashes).toEqual([])
      f.sqlite.run('DROP TRIGGER audit_denied')
      await f.store.acceptHash(f.adapter.root, owner, 'migration-a', alternate, audit)
      f.sqlite.run(
        "CREATE TRIGGER audit_denied BEFORE INSERT ON zenlev_migrations_audit BEGIN SELECT RAISE(ABORT, 'audit denied'); END",
      )
      await expect(
        f.store.dropHash(f.adapter.root, owner, 'migration-a', alternate, audit),
      ).rejects.toThrow('audit denied')
      expect((await f.store.read())[0]?.acceptedHashes).toEqual([alternate])
    })
  })

  test('shares application DDL and ledger rollback inside the supplied transaction', async () => {
    const f = fixture()
    await f.store.withLock(async (owner) => {
      await expect(
        f.adapter.transaction(async (session) => {
          await f.store.start(session, owner, migration(), 'attempt')
          await session.kysely.schema
            .createTable('application_table')
            .addColumn('id', 'integer')
            .execute()
          await f.store.apply(session, owner, migration())
          expect((await f.store.read(session))[0]?.status).toBe('applied')
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      expect(await f.store.read()).toEqual([])
      expect(
        f.sqlite.query("SELECT name FROM sqlite_master WHERE name='application_table'").get(),
      ).toBeNull()
    })
  })

  test('records unresolved partial attempts and prevents automatic retry', async () => {
    const f = fixture()
    await f.store.withLock(async (owner) => {
      await f.store.start(f.adapter.root, owner, migration(), 'attempt')
      await f.store.fail(f.adapter.root, owner, 'migration-a', 7)
      expect((await f.store.read())[0]).toMatchObject({
        durationMs: 7,
        status: 'failed',
        unresolvedAttempt: true,
      })
      await expect(f.store.start(f.adapter.root, owner, migration(), 'retry')).rejects.toThrow(
        'requires attempt recovery',
      )
      await expect(f.store.fail(f.adapter.root, owner, 'migration-a')).rejects.toThrow(
        'no active attempt',
      )
      await expect(f.store.apply(f.adapter.root, owner, migration())).rejects.toThrow(
        'matching active attempt',
      )
    })
  })

  test('validates migration, attempt, hash and audit arguments', async () => {
    const f = fixture()
    await f.store.withLock(async (owner) => {
      await expect(
        f.store.start(f.adapter.root, owner, { ...migration(), hash: 'wrong' }, 'attempt'),
      ).rejects.toThrow('hexadecimal')
      await expect(f.store.start(f.adapter.root, owner, migration(), '')).rejects.toThrow('IDs')
      await expect(
        f.store.start(f.adapter.root, owner, { ...migration(), id: '' }, 'attempt'),
      ).rejects.toThrow('IDs')
      await expect(f.store.apply(f.adapter.root, owner, migration())).rejects.toThrow('Unknown')
      await f.store.start(f.adapter.root, owner, migration(), 'attempt')
      await expect(f.store.apply(f.adapter.root, owner, migration(), [], -1)).rejects.toThrow(
        'duration',
      )
      await expect(f.store.fail(f.adapter.root, owner, 'migration-a', 1.5)).rejects.toThrow(
        'duration',
      )
      await expect(
        f.store.apply(f.adapter.root, owner, { ...migration(), hash: alternate }),
      ).rejects.toThrow('matching active attempt')
      await expect(
        f.store.acceptHash(f.adapter.root, owner, 'migration-a', 'bad', audit),
      ).rejects.toThrow('hexadecimal')
      await expect(
        f.store.acceptHash(f.adapter.root, owner, 'migration-a', alternate, { actor: '' }),
      ).rejects.toThrow('actor')
      await expect(
        f.store.dropHash(f.adapter.root, owner, 'migration-a', 'bad', audit),
      ).rejects.toThrow('hexadecimal')
      await expect(
        f.store.dropHash(f.adapter.root, owner, 'migration-a', alternate, { actor: '' }),
      ).rejects.toThrow('actor')
    })
  })

  test('records superseding rollback history without modifying source metadata', async () => {
    const f = fixture()
    await applied(f, 'original')
    const replacement = { ...migration('rollback'), supersedes: ['original'] }
    await f.store.withLock(async (owner) => {
      await f.store.start(f.adapter.root, owner, replacement, 'rollback-attempt')
      await expect(f.store.apply(f.adapter.root, owner, replacement, ['rollback'])).rejects.toThrow(
        'not applied',
      )
      await f.adapter.transaction(async (session) => {
        await f.store.apply(session, owner, replacement, ['original', 'original'])
      })
    })
    const records = await f.store.read()
    expect(records.find((record) => record.meta.id === 'original')).toMatchObject({
      status: 'rolled_back',
      rolledBackAt: at.toISOString(),
    })
    expect(records.find((record) => record.meta.id === 'rollback')).toMatchObject({
      status: 'applied',
    })
  })
})

describe('operator recovery', () => {
  const confirmation = {
    actor: 'operator',
    reason: 'inspected after crash',
    evidence: 'verified database tables and rows',
  }

  test('requires complete audit evidence', async () => {
    const f = fixture()
    await expect(
      f.store.recover({ action: 'release-lock', owner: 'owner', ...confirmation, actor: '' }),
    ).rejects.toThrow('actor')
    await expect(
      f.store.recover({ action: 'release-lock', owner: 'owner', ...confirmation, reason: '' }),
    ).rejects.toThrow('evidence')
    await expect(
      f.store.recover({ action: 'release-lock', owner: 'owner', ...confirmation, evidence: '' }),
    ).rejects.toThrow('evidence')
    await expect(
      f.store.recover({ action: 'release-lock', owner: '', ...confirmation }),
    ).rejects.toThrow('owner')
  })

  test('releases only the observed abandoned owner and records evidence atomically', async () => {
    const f = fixture()
    await f.store.withLock(async () => {})
    f.sqlite.run("UPDATE zenlev_lock SET owner = 'abandoned'")
    await expect(
      f.store.recover({ action: 'release-lock', owner: 'stale', ...confirmation }),
    ).rejects.toThrow('ownership changed')
    await f.store.recover({ action: 'release-lock', owner: 'abandoned', ...confirmation })
    expect((await f.store.lockInfo())?.owner).toBeNull()
    expect(
      f.sqlite.query('SELECT action, actor, evidence FROM zenlev_migrations_audit').all(),
    ).toEqual([
      { action: 'release-lock', actor: confirmation.actor, evidence: confirmation.evidence },
    ])
  })

  test('reconciles only the current attempt and permits an inspected retry', async () => {
    const f = fixture()
    await f.store.withLock(async (owner) => {
      await f.store.start(f.adapter.root, owner, migration(), 'attempt')
      await f.store.fail(f.adapter.root, owner, 'migration-a')
    })
    await expect(
      f.store.recover({ action: 'retry', id: 'migration-a', attemptId: 'stale', ...confirmation }),
    ).rejects.toThrow('attempt ID')
    await expect(
      f.store.recover({ action: 'retry', id: 'migration-a', attemptId: '', ...confirmation }),
    ).rejects.toThrow('attempt ID')
    await f.store.recover({
      action: 'retry',
      id: 'migration-a',
      attemptId: 'attempt',
      ...confirmation,
    })
    expect((await f.store.read())[0]).toMatchObject({ status: 'pending', unresolvedAttempt: false })
    await expect(
      f.store.recover({
        action: 'retry',
        id: 'migration-a',
        attemptId: 'attempt',
        ...confirmation,
      }),
    ).rejects.toThrow('attempt ID')
    await f.store.withLock(async (owner) => {
      await f.store.start(f.adapter.root, owner, migration(), 'retry-attempt')
      await f.store.apply(f.adapter.root, owner, migration())
    })
    expect((await f.store.read())[0]?.status).toBe('applied')
  })

  test('marks an inspected attempt applied and preserves its executed hash', async () => {
    const f = fixture()
    await f.store.withLock(async (owner) =>
      f.store.start(f.adapter.root, owner, migration(), 'attempt'),
    )
    await f.store.recover({
      action: 'applied',
      id: 'migration-a',
      attemptId: 'attempt',
      ...confirmation,
    })
    expect((await f.store.read())[0]).toMatchObject({
      status: 'applied',
      hash,
      unresolvedAttempt: false,
      appliedAt: at.toISOString(),
    })
  })

  test('refuses applied recovery for a rollback whose reversal set is unproven', async () => {
    const f = fixture()
    const rollback = {
      ...migration(),
      rollback: { mode: 'compensate' as const, target: 'original', reversals: ['original'] },
    }
    await f.store.withLock(async (owner) =>
      f.store.start(f.adapter.root, owner, rollback, 'attempt'),
    )
    await expect(
      f.store.recover({
        action: 'applied',
        id: rollback.id,
        attemptId: 'attempt',
        ...confirmation,
      }),
    ).rejects.toThrow('explicit retry')
    expect((await f.store.read())[0]?.unresolvedAttempt).toBe(true)
  })
})
