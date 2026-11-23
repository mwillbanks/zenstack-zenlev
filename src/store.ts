import { randomUUID } from 'node:crypto'
import { sql, type RawBuilder } from 'kysely'
import type { RecordedMigration } from './graph'
import type {
  DatabaseAdapter,
  DatabaseSession,
  Dialect,
  MigrationIdentity,
  MigrationMeta,
  MigrationStatus,
  StoreConfig,
} from './types'

export interface StoreRuntime {
  readonly now?: () => Date
  readonly ownerId?: () => string
}

export interface StoreAudit {
  readonly actor: string
  readonly reason?: string
}

export interface StoredMigration extends RecordedMigration {
  readonly durationMs: number
  readonly attemptId?: string
  readonly appliedAt?: string
  readonly rolledBackAt?: string
}

export type RecoveryOptions = {
  readonly actor: string
  readonly reason: string
  readonly evidence: string
} & (
  | { readonly action: 'release-lock'; readonly owner: string }
  | { readonly action: 'applied' | 'retry'; readonly id: string; readonly attemptId: string }
)

export interface StoreLock {
  readonly owner: string | null
  readonly acquiredAt: string | null
}

interface LedgerRow {
  id: string
  meta: string
  hash: string
  status: MigrationStatus
  attempt_id: string | null
  unresolved: number
  applied_at: string | null
  rolled_back_at: string | null
  duration_ms: number
}

interface LockRow {
  owner: string | null
  acquired_at: string | null
  version: number
}

interface PhysicalTable {
  readonly name: string
  readonly namespace: string | undefined
  readonly identifier: RawBuilder<unknown>
}

const version = 1
const lockId = 'zenlev'

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value) || value.length > 63) {
    throw new TypeError(
      'Store identifiers must contain letters, digits, or underscores and be at most 63 characters',
    )
  }
  return value
}

function location(dialect: Dialect, config: StoreConfig) {
  const kind =
    config.location ??
    (dialect === 'postgresql' ? 'schema' : dialect === 'mysql' ? 'database' : 'table')
  if (
    !['schema', 'database', 'table'].includes(kind) ||
    (kind === 'schema' && dialect !== 'postgresql') ||
    (kind === 'database' && dialect !== 'mysql')
  ) {
    throw new TypeError('Unsupported store location for ' + dialect + ': ' + kind)
  }
  if (config.schemaName !== undefined && kind !== 'schema')
    throw new TypeError('schemaName requires schema store location')
  if (config.databaseName !== undefined && kind !== 'database')
    throw new TypeError('databaseName requires database store location')
  const namespace =
    kind === 'schema'
      ? identifier(config.schemaName ?? 'zenlev')
      : kind === 'database'
        ? identifier(config.databaseName ?? 'zenlev')
        : undefined
  const migrationName = identifier(
    config.tableName ?? (kind === 'table' ? 'zenlev_migrations' : 'migrations'),
  )
  const makeTable = (name: string): PhysicalTable => {
    identifier(name)
    return { name, namespace, identifier: sql.id(...(namespace ? [namespace, name] : [name])) }
  }
  const migrations = makeTable(migrationName)
  const lock = makeTable(
    config.lockTableName ?? (kind === 'table' ? 'zenlev_lock' : 'migration_lock'),
  )
  const resolutions = makeTable(migrationName + '_resolutions')
  const audit = makeTable(migrationName + '_audit')
  const tables = [migrations, resolutions, lock, audit]
  if (new Set(tables.map((table) => table.name)).size !== tables.length) {
    throw new TypeError('Store table names must be distinct')
  }
  return { kind, namespace, migrations, resolutions, lock, audit, tables }
}

function requireAudit(audit: StoreAudit): void {
  if (typeof audit.actor !== 'string' || audit.actor.trim() === '')
    throw new TypeError('An audit actor is required')
}

function requireHash(hash: string): void {
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64}|[a-f0-9]{128})$/.test(hash)) {
    throw new TypeError('Expected a hexadecimal migration hash')
  }
}

function requireDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0)
    throw new TypeError('Migration duration must be a safe nonnegative integer')
}

function metadata(migration: MigrationIdentity): MigrationMeta {
  const { filePath: _filePath, hash: _hash, ...meta } = migration
  return meta
}

export function createStore(
  adapter: DatabaseAdapter<any, any, any>,
  config: StoreConfig = {},
  runtime: StoreRuntime = {},
) {
  const names = location(adapter.dialect, config)
  const timestamp = () => (runtime.now ?? (() => new Date()))().toISOString()
  const newOwner = runtime.ownerId ?? randomUUID
  const root = adapter.root
  const mutationRoot = () => {
    if (root.kysely.isTransaction)
      throw new Error('A transaction client cannot own migration store mutations')
  }

  async function exists(table: PhysicalTable, session: DatabaseSession = root): Promise<boolean> {
    const query =
      adapter.dialect === 'sqlite'
        ? sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table.name}`
        : adapter.dialect === 'postgresql'
          ? sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${table.namespace === undefined ? sql`current_schema()` : table.namespace} AND table_name = ${table.name}`
          : sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${table.namespace === undefined ? sql`DATABASE()` : table.namespace} AND table_name = ${table.name}`
    return (await query.execute(session.physical)).rows.length > 0
  }

  async function lockRow(session: DatabaseSession = root, forUpdate = false): Promise<LockRow> {
    const suffix = forUpdate && adapter.dialect !== 'sqlite' ? sql.raw(' FOR UPDATE') : sql.raw('')
    const row = (
      await sql<LockRow>`SELECT owner, acquired_at, version FROM ${names.lock.identifier} WHERE lock_id = ${lockId}${suffix}`.execute(
        session.physical,
      )
    ).rows[0]
    if (!row || row.version !== version)
      throw new Error('Unsupported or incomplete Zenlev ledger version')
    return row
  }

  async function initialize(): Promise<void> {
    mutationRoot()
    if (await exists(names.lock)) await lockRow()
    if (names.namespace !== undefined) {
      const namespace = sql.id(names.namespace)
      if (names.kind === 'schema') {
        await adapter.transaction(async ({ physical }) => {
          const searchPath = sql<{
            path: string
          }>`SELECT pg_catalog.current_schemas(false)::text AS path`
          const before = (await searchPath.execute(physical)).rows[0]!.path
          await sql`CREATE SCHEMA IF NOT EXISTS ${namespace}`.execute(physical)
          const after = (await searchPath.execute(physical)).rows[0]!.path
          if (before !== after) {
            throw new Error(
              'Creating the Zenlev ledger would change the PostgreSQL search path. Set an explicit application search_path or choose a different store.schemaName.',
            )
          }
        })
      } else {
        await sql`CREATE DATABASE IF NOT EXISTS ${namespace}`.execute(root.physical)
      }
    }
    await sql`CREATE TABLE IF NOT EXISTS ${names.lock.identifier} (lock_id VARCHAR(64) PRIMARY KEY, owner VARCHAR(191), acquired_at TEXT, version INTEGER NOT NULL)`.execute(
      root.physical,
    )
    const metaType = adapter.dialect === 'mysql' ? sql`LONGTEXT` : sql`TEXT`
    await sql`CREATE TABLE IF NOT EXISTS ${names.migrations.identifier} (id VARCHAR(191) PRIMARY KEY, meta ${metaType} NOT NULL, hash VARCHAR(128) NOT NULL, status VARCHAR(20) NOT NULL, attempt_id VARCHAR(191), unresolved INTEGER NOT NULL, applied_at TEXT, rolled_back_at TEXT, duration_ms INTEGER NOT NULL DEFAULT 0)`.execute(
      root.physical,
    )
    await sql`CREATE TABLE IF NOT EXISTS ${names.resolutions.identifier} (migration_id VARCHAR(191) NOT NULL, hash VARCHAR(128) NOT NULL, accepted_at TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT, PRIMARY KEY (migration_id, hash))`.execute(
      root.physical,
    )
    await sql`CREATE TABLE IF NOT EXISTS ${names.audit.identifier} (id VARCHAR(64) PRIMARY KEY, action VARCHAR(40) NOT NULL, migration_id VARCHAR(191), actor TEXT NOT NULL, reason TEXT, evidence TEXT, recorded_at TEXT NOT NULL)`.execute(
      root.physical,
    )
    const insert =
      adapter.dialect === 'mysql'
        ? sql`INSERT IGNORE INTO ${names.lock.identifier} (lock_id, owner, acquired_at, version) VALUES (${lockId}, NULL, NULL, ${version})`
        : sql`INSERT INTO ${names.lock.identifier} (lock_id, owner, acquired_at, version) VALUES (${lockId}, NULL, NULL, ${version}) ON CONFLICT (lock_id) DO NOTHING`
    await insert.execute(root.physical)
    await lockRow()
  }

  async function assertOwner(session: DatabaseSession, owner: string): Promise<void> {
    if ((await lockRow(session, session.kysely.isTransaction)).owner !== owner)
      throw new Error('Migration lock ownership changed')
  }

  function atomic<T>(
    session: DatabaseSession,
    write: (transaction: DatabaseSession) => Promise<T>,
  ): Promise<T> {
    return session.kysely.isTransaction ? write(session) : adapter.transaction(write)
  }

  async function auditWrite(
    session: DatabaseSession,
    action: string,
    id: string | null,
    audit: StoreAudit,
    evidence: string | null = null,
  ): Promise<void> {
    requireAudit(audit)
    await sql`INSERT INTO ${names.audit.identifier} (id, action, migration_id, actor, reason, evidence, recorded_at) VALUES (${randomUUID()}, ${action}, ${id}, ${audit.actor}, ${audit.reason ?? null}, ${evidence}, ${timestamp()})`.execute(
      session.physical,
    )
  }

  async function row(id: string, session: DatabaseSession): Promise<LedgerRow> {
    const record = (
      await sql<LedgerRow>`SELECT * FROM ${names.migrations.identifier} WHERE id = ${id}`.execute(
        session.physical,
      )
    ).rows[0]
    if (!record) throw new Error('Unknown recorded migration: ' + id)
    return record
  }

  async function read(session: DatabaseSession = root): Promise<StoredMigration[]> {
    if (!(await exists(names.migrations, session))) return []
    await lockRow(session)
    const records =
      await sql<LedgerRow>`SELECT * FROM ${names.migrations.identifier} ORDER BY id`.execute(
        session.physical,
      )
    const accepted = await sql<{
      migration_id: string
      hash: string
    }>`SELECT migration_id, hash FROM ${names.resolutions.identifier} ORDER BY hash`.execute(
      session.physical,
    )
    return records.rows.map((record) => ({
      meta: JSON.parse(record.meta) as MigrationMeta,
      hash: record.hash,
      status: record.status,
      durationMs: record.duration_ms,
      acceptedHashes: accepted.rows
        .filter((entry) => entry.migration_id === record.id)
        .map((entry) => entry.hash),
      unresolvedAttempt: record.unresolved !== 0,
      ...(record.attempt_id === null ? {} : { attemptId: record.attempt_id }),
      ...(record.applied_at === null ? {} : { appliedAt: record.applied_at }),
      ...(record.rolled_back_at === null ? {} : { rolledBackAt: record.rolled_back_at }),
    }))
  }

  async function lockInfo(): Promise<StoreLock | undefined> {
    if (!(await exists(names.lock))) return undefined
    const lock = await lockRow()
    return { owner: lock.owner, acquiredAt: lock.acquired_at }
  }

  async function withLock<T>(run: (owner: string) => Promise<T>): Promise<T> {
    await initialize()
    const owner = newOwner()
    if (typeof owner !== 'string' || owner.trim() === '')
      throw new TypeError('Lock owner must be a nonempty string')
    const result =
      await sql`UPDATE ${names.lock.identifier} SET owner = ${owner}, acquired_at = ${timestamp()} WHERE lock_id = ${lockId} AND owner IS NULL AND version = ${version}`.execute(
        root.physical,
      )
    if (result.numAffectedRows !== 1n)
      throw new Error('Migration ledger is locked by another owner')
    const release = async () => {
      const released =
        await sql`UPDATE ${names.lock.identifier} SET owner = NULL, acquired_at = NULL WHERE lock_id = ${lockId} AND owner = ${owner}`.execute(
          root.physical,
        )
      if (released.numAffectedRows !== 1n)
        throw new Error('Migration lock ownership changed before release')
    }
    let value: T
    try {
      value = await run(owner)
    } catch (error) {
      try {
        await release()
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'Migration and lock release both failed')
      }
      throw error
    }
    await release()
    return value
  }

  async function accommodateBaseline(owner: string, migration: MigrationIdentity): Promise<void> {
    if (
      adapter.dialect !== 'mysql' ||
      Buffer.byteLength(JSON.stringify(metadata(migration))) <= 65_535
    ) {
      return
    }
    await assertOwner(root, owner)
    const { name, namespace } = names.migrations
    const schema = namespace ?? sql`DATABASE()`
    const { rows } = await sql<{ column_type: string }>`
      SELECT DATA_TYPE AS column_type FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = ${name} AND column_name = 'meta'
    `.execute(root.physical)
    if (rows[0]?.column_type !== 'longtext') {
      // Legacy MySQL stores use TEXT. Widen it outside the migration transaction.
      await sql`ALTER TABLE ${names.migrations.identifier} MODIFY COLUMN meta LONGTEXT NOT NULL`.execute(
        root.physical,
      )
    }
  }

  async function start(
    session: DatabaseSession,
    owner: string,
    migration: MigrationIdentity,
    attemptId: string,
  ): Promise<void> {
    await assertOwner(session, owner)
    requireHash(migration.hash)
    if (!attemptId || !migration.id) throw new TypeError('Migration and attempt IDs are required')
    const existing = (
      await sql<LedgerRow>`SELECT * FROM ${names.migrations.identifier} WHERE id = ${migration.id}`.execute(
        session.physical,
      )
    ).rows[0]
    if (existing && (existing.status !== 'pending' || existing.unresolved !== 0)) {
      throw new Error(
        'Migration is applied, rolled back, or requires attempt recovery: ' + migration.id,
      )
    }
    const meta = JSON.stringify(metadata(migration))
    if (existing) {
      await sql`UPDATE ${names.migrations.identifier} SET meta = ${meta}, hash = ${migration.hash}, status = ${'applying'}, attempt_id = ${attemptId}, unresolved = 1 WHERE id = ${migration.id}`.execute(
        session.physical,
      )
    } else {
      await sql`INSERT INTO ${names.migrations.identifier} (id, meta, hash, status, attempt_id, unresolved) VALUES (${migration.id}, ${meta}, ${migration.hash}, ${'applying'}, ${attemptId}, 1)`.execute(
        session.physical,
      )
    }
  }

  async function apply(
    session: DatabaseSession,
    owner: string,
    migration: MigrationIdentity,
    rolledBackIds: readonly string[] = [],
    durationMs = 0,
  ): Promise<void> {
    await assertOwner(session, owner)
    requireDuration(durationMs)
    const record = await row(migration.id, session)
    if (record.status !== 'applying' || record.hash !== migration.hash)
      throw new Error('Migration has no matching active attempt: ' + migration.id)
    for (const id of new Set(rolledBackIds)) {
      const reversed = await row(id, session)
      if (reversed.status !== 'applied') throw new Error('Rollback target is not applied: ' + id)
    }
    const at = timestamp()
    await sql`UPDATE ${names.migrations.identifier} SET status = ${'applied'}, unresolved = 0, applied_at = ${at}, duration_ms = ${durationMs} WHERE id = ${migration.id}`.execute(
      session.physical,
    )
    for (const id of new Set(rolledBackIds)) {
      await sql`UPDATE ${names.migrations.identifier} SET status = ${'rolled_back'}, rolled_back_at = ${at} WHERE id = ${id}`.execute(
        session.physical,
      )
    }
  }

  async function fail(
    session: DatabaseSession,
    owner: string,
    id: string,
    durationMs = 0,
  ): Promise<void> {
    await assertOwner(session, owner)
    requireDuration(durationMs)
    if ((await row(id, session)).status !== 'applying')
      throw new Error('Migration has no active attempt: ' + id)
    await sql`UPDATE ${names.migrations.identifier} SET status = ${'failed'}, unresolved = 1, duration_ms = ${durationMs} WHERE id = ${id}`.execute(
      session.physical,
    )
  }

  async function acceptHash(
    session: DatabaseSession,
    owner: string,
    id: string,
    hash: string,
    audit: StoreAudit,
  ): Promise<void> {
    await assertOwner(session, owner)
    await row(id, session)
    requireHash(hash)
    requireAudit(audit)
    const existing =
      await sql`SELECT hash FROM ${names.resolutions.identifier} WHERE migration_id = ${id} AND hash = ${hash}`.execute(
        session.physical,
      )
    if (existing.rows.length === 0) {
      await sql`INSERT INTO ${names.resolutions.identifier} (migration_id, hash, accepted_at, actor, reason) VALUES (${id}, ${hash}, ${timestamp()}, ${audit.actor}, ${audit.reason ?? null})`.execute(
        session.physical,
      )
    }
    await auditWrite(session, 'accept-hash', id, audit)
  }

  async function dropHash(
    session: DatabaseSession,
    owner: string,
    id: string,
    hash: string,
    audit: StoreAudit,
  ): Promise<void> {
    await assertOwner(session, owner)
    await row(id, session)
    requireHash(hash)
    requireAudit(audit)
    await sql`DELETE FROM ${names.resolutions.identifier} WHERE migration_id = ${id} AND hash = ${hash}`.execute(
      session.physical,
    )
    await auditWrite(session, 'drop-hash', id, audit)
  }

  async function recover(options: RecoveryOptions): Promise<void> {
    mutationRoot()
    requireAudit(options)
    if (!options.reason?.trim() || !options.evidence?.trim())
      throw new TypeError('Recovery requires a reason and inspected database evidence')
    if (options.action === 'release-lock') {
      if (!options.owner) throw new TypeError('Recovery requires the observed lock owner')
      await adapter.transaction(async (session) => {
        await assertOwner(session, options.owner)
        await auditWrite(session, 'release-lock', null, options, options.evidence)
        const result =
          await sql`UPDATE ${names.lock.identifier} SET owner = NULL, acquired_at = NULL WHERE lock_id = ${lockId} AND owner = ${options.owner}`.execute(
            session.physical,
          )
        if (result.numAffectedRows !== 1n)
          throw new Error('Observed lock owner changed during recovery')
      })
      return
    }
    await withLock((owner) =>
      adapter.transaction(async (session) => {
        await assertOwner(session, owner)
        const record = await row(options.id, session)
        if (
          !options.attemptId ||
          record.attempt_id !== options.attemptId ||
          record.unresolved === 0
        ) {
          throw new Error('Recovery requires the current unresolved attempt ID')
        }
        const meta = JSON.parse(record.meta) as MigrationMeta
        if (options.action === 'applied' && meta.rollback)
          throw new Error(
            'A rollback attempt requires explicit retry after database reconciliation',
          )
        await auditWrite(
          session,
          'recover-' + options.action,
          options.id,
          options,
          options.evidence,
        )
        const appliedAt = options.action === 'applied' ? timestamp() : null
        await sql`UPDATE ${names.migrations.identifier} SET status = ${options.action === 'applied' ? 'applied' : 'pending'}, unresolved = 0, applied_at = ${appliedAt} WHERE id = ${options.id}`.execute(
          session.physical,
        )
      }),
    )
  }

  return {
    tables: Object.freeze(
      names.tables.map((table) => ({ name: table.name, namespace: table.namespace })),
    ),
    read,
    lockInfo,
    withLock,
    assertOwner,
    accommodateBaseline,
    start: (
      session: DatabaseSession,
      owner: string,
      migration: MigrationIdentity,
      attemptId: string,
    ) => atomic(session, (transaction) => start(transaction, owner, migration, attemptId)),
    apply: (
      session: DatabaseSession,
      owner: string,
      migration: MigrationIdentity,
      rolledBackIds: readonly string[] = [],
      durationMs = 0,
    ) =>
      atomic(session, (transaction) =>
        apply(transaction, owner, migration, rolledBackIds, durationMs),
      ),
    fail: (session: DatabaseSession, owner: string, id: string, durationMs = 0) =>
      atomic(session, (transaction) => fail(transaction, owner, id, durationMs)),
    acceptHash: (
      session: DatabaseSession,
      owner: string,
      id: string,
      hash: string,
      audit: StoreAudit,
    ) => atomic(session, (transaction) => acceptHash(transaction, owner, id, hash, audit)),
    dropHash: (
      session: DatabaseSession,
      owner: string,
      id: string,
      hash: string,
      audit: StoreAudit,
    ) => atomic(session, (transaction) => dropHash(transaction, owner, id, hash, audit)),
    recover,
  }
}

export type MigrationStore = ReturnType<typeof createStore>
