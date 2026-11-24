import { randomUUID } from 'node:crypto'
import type { CommandContext } from '../engine'
import type { PlannedMigrationHandler } from '../plugins'
import { baselineMode, buildGraph, planMigrations, type MigrationGraph } from './graph'
import { discoverMigrations, verifyMigrationFile, type LoadedMigration } from './files'
import { createStore, type MigrationStore, type RecoveryOptions } from './store'
import { activeDependentIds, assertReversibleHistory, verifyReversals } from './rollback'
import { operationWarnings } from '../warnings'
import type {
  ApplyOptions,
  ApplyResult,
  DatabaseSession,
  MigrationCtx,
  MigrationIdentity,
  MigrationResult,
  Plan,
  Reporter,
  Warning,
} from '../types'

export function database(context: CommandContext) {
  const adapter = context.adapter
  if (!adapter) throw new Error('Configure a ZenStack client or a Kysely adapter for this command')
  return adapter
}

interface ExecutionOptions {
  readonly report?: Reporter
  readonly now?: () => number
}

function summaryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function elapsed(now: () => number, start: number): number {
  return Math.max(0, Math.round(now() - start))
}

function validateReplacement(original: Plan, proposal: Plan, graph: MigrationGraph): Plan {
  if (proposal.transactional !== original.transactional || !Array.isArray(proposal.migrations)) {
    throw new Error('Plugin plan cannot change transaction mode or omit migration selection')
  }
  const eligible = new Map(original.migrations.map((migration) => [migration.id, migration]))
  const ordered = new Set<string>()
  const migrations = proposal.migrations.map(({ id }) => {
    const originalMigration = eligible.get(id)
    if (!originalMigration || ordered.has(id))
      throw new Error('Plugin plan selected an ineligible or duplicate migration: ' + id)
    if (graph.nodes.get(id)!.dependencies.some((dep) => eligible.has(dep) && !ordered.has(dep))) {
      throw new Error('Plugin plan omitted or reordered a pending prerequisite for ' + id)
    }
    ordered.add(id)
    return originalMigration
  })
  return {
    ...original,
    migrations,
    namespaces: [...new Set(migrations.map(({ namespace }) => namespace))].sort(),
    warnings: [
      ...original.warnings,
      ...proposal.warnings.filter(
        (warning) =>
          !original.warnings.some(
            (previous) => JSON.stringify(previous) === JSON.stringify(warning),
          ),
      ),
    ],
  }
}

export async function apply(
  context: CommandContext,
  options: ApplyOptions,
  runtime: ExecutionOptions = {},
): Promise<ApplyResult> {
  const adapter = database(context)
  const store = createStore(adapter, context.config.store)
  const reporter = runtime.report ?? context.reporter
  const plugins = context.plugins
  const now = runtime.now ?? (() => performance.now())

  const readPlan = (session: DatabaseSession) =>
    reporter.span('zenlev.plan', async () => {
      const local = await discoverMigrations(context.config.migrationsDir, context.config.hashing)
      const history = await store.read(session)
      await plugins.storeRead(
        history.map(({ meta, hash, status }) => ({
          id: meta.id,
          namespace: meta.namespace,
          hash,
          status,
        })),
      )
      const graph = buildGraph(
        local.map(({ up: _up, down: _down, ...identity }) => identity),
        history,
      )
      const original = planMigrations(graph, options, adapter.transactionalDdl, adapter.dialect)
      const initial =
        adapter.dialect === 'mysql' && original.migrations.length > 0
          ? {
              ...original,
              warnings: original.warnings.map((warning) =>
                warning.code === 'REDUCED_TRANSACTION_SAFETY'
                  ? {
                      ...warning,
                      message: 'MySQL DDL may commit implicitly before the migration plan succeeds',
                    }
                  : warning,
              ),
            }
          : original
      const plan = await plugins.plan(initial, (proposal) =>
        validateReplacement(initial, proposal, graph),
      )
      return { local: new Map(local.map((migration) => [migration.id, migration])), graph, plan }
    })

  if (options.dryRun || options.planOnly) {
    const { plan } = await readPlan(adapter.root)
    return { plan, migrations: [], status: 'planned' }
  }

  return store.withLock(async (owner) => {
    const { graph, local, plan } = await readPlan(adapter.root)
    if (plan.blockers.length > 0) return { plan, migrations: [], status: 'failed' }
    const handlers: PlannedMigrationHandler[] = []
    if (plugins.hasBeforeWrite) {
      for (const identity of plan.migrations) {
        const migration = local.get(identity.id)!
        const reversals = await loadReversals(migration, graph, local, context)
        for (const reversal of reversals) {
          const { up: _up, down: _down, custom: _custom, ...reversalIdentity } = reversal
          handlers.push({ migration: reversalIdentity, direction: 'down' })
        }
        if (!migration.baseline || baselineMode(graph, migration) === 'bootstrap') {
          const { custom: _custom, ...writeIdentity } = identity
          handlers.push({ migration: writeIdentity, direction: 'up' })
        }
      }
    }
    const diagnostics = await plugins.beforeWrite(
      { command: 'migrate apply', handlers },
      { config: context.config, adapter },
    )
    const findings = diagnostics.length ? { diagnostics } : {}
    if (diagnostics.some(({ severity }) => severity === 'error'))
      return { plan, migrations: [], status: 'failed', ...findings }
    for (const warning of plan.warnings) {
      context.notifyWarning(warning)
      await plugins.warning(warning)
    }
    for (const migration of plan.migrations) {
      if (migration.baseline) await store.accommodateBaseline(owner, migration)
    }
    const results: MigrationResult[] = []
    const reversed: MigrationIdentity[] = []
    const failed = new Set<string>()
    const runtimeWarnings: Warning[] = []
    const notify = (warning: Warning) => {
      if (
        runtimeWarnings.some(
          (previous) =>
            previous.code === warning.code && previous.migrationId === warning.migrationId,
        )
      )
        return
      runtimeWarnings.push(warning)
      context.notifyWarning(warning)
    }
    const migrationContext = (
      session: DatabaseSession,
      migration: MigrationIdentity,
      detect: boolean,
    ): MigrationCtx => {
      const kysely = detect
        ? session.kysely.withPlugin(operationWarnings(migration.id, notify))
        : session.kysely
      return {
        env: context.env,
        db: { kysely, schema: kysely.schema, dialect: { name: adapter.dialect } },
        zenstack: { client: session.client },
        reporter,
        migration,
      }
    }
    const execute = async (session: DatabaseSession) => {
      for (const identity of plan.migrations) {
        const dependencies = graph.nodes.get(identity.id)!.dependencies
        if (dependencies.some((id) => failed.has(id))) {
          failed.add(identity.id)
          results.push({ id: identity.id, status: 'skipped', durationMs: 0 })
          continue
        }
        const migration = local.get(identity.id)!
        const executed = { ...identity, dependsOn: dependencies }
        const start = now()
        let attempted = false
        try {
          await verifyMigrationFile(migration, context.config.hashing)
          const reversals = await loadReversals(migration, graph, local, context)
          const scoped = migrationContext(session, identity, true)
          if (!(await plugins.beforeMigration(scoped))) {
            failed.add(identity.id)
            results.push({ id: identity.id, status: 'skipped', durationMs: elapsed(now, start) })
            continue
          }
          await verifyMigrationFile(migration, context.config.hashing)
          await store.start(session, owner, executed, randomUUID())
          attempted = true
          await reporter.span('zenlev.migration', async (span) => {
            span.setAttribute('zenlev.migration.id', migration.id)
            for (const reversal of reversals) {
              await reversal.down!(plugins.scope(migrationContext(session, reversal, true)))
            }
            if (!migration.baseline || baselineMode(graph, migration) === 'bootstrap') {
              await migration.up(plugins.scope(scoped))
            }
          })
          const durationMs = elapsed(now, start)
          await store.apply(
            session,
            owner,
            executed,
            reversals.map(({ id }) => id),
            durationMs,
          )
          reversed.push(...reversals.map(({ up: _up, down: _down, ...reversal }) => reversal))
          results.push({ id: identity.id, status: 'applied', durationMs })
        } catch (error) {
          const durationMs = elapsed(now, start)
          if (!plan.transactional && attempted)
            await store.fail(session, owner, identity.id, durationMs)
          failed.add(identity.id)
          await plugins.error(error)
          results.push({
            id: identity.id,
            status: 'failed',
            durationMs,
            error: summaryError(error),
          })
          if (plan.transactional) throw error
          if (!options.continueOnFailure) break
        }
      }
    }

    let rolledBack = false
    if (plan.transactional) {
      try {
        await adapter.transaction(execute)
      } catch (error) {
        if (failed.size === 0) throw error
        rolledBack = true
      }
    } else {
      await execute(adapter.root)
    }
    const migrations = rolledBack
      ? results.map((result) =>
          result.status === 'applied' ? { ...result, status: 'rolled_back' as const } : result,
        )
      : results
    const actual = new Map(migrations.map((result) => [result.id, result]))
    for (const identity of plan.migrations) {
      const result = actual.get(identity.id)
      if (result)
        await plugins.afterMigration(migrationContext(adapter.root, identity, false), result)
    }
    for (const warning of runtimeWarnings) await plugins.warning(warning)
    const applied = plan.migrations.filter(({ id }) => actual.get(id)?.status === 'applied')
    if (applied.length > 0) await plugins.storeWrite({ applied, rolledBack: reversed })
    return {
      plan: { ...plan, warnings: [...plan.warnings, ...runtimeWarnings] },
      migrations,
      status: rolledBack ? 'failed' : failed.size === 0 ? 'ok' : 'partial',
      ...findings,
    }
  })
}

async function loadReversals(
  migration: LoadedMigration,
  graph: MigrationGraph,
  local: ReadonlyMap<string, LoadedMigration>,
  context: CommandContext,
): Promise<LoadedMigration[]> {
  if (!migration.rollback) return []
  const { mode, target, reversals } = migration.rollback
  for (const id of reversals) assertReversibleHistory(graph, id)
  const active = activeDependentIds(graph, target)
  if (mode === 'cascade' && active.some((id) => !reversals.includes(id))) {
    throw new Error(
      'Rollback cascade omits active dependents: ' +
        active.filter((id) => !reversals.includes(id)).join(', '),
    )
  }
  if (mode === 'compensate' && (reversals.length !== 1 || reversals[0] !== target)) {
    throw new Error('Compensation must reverse only its target')
  }
  if (mode === 'compensate' && active.length > 0) {
    context.notifyWarning({
      code: 'ACTIVE_DEPENDENTS',
      migrationId: migration.id,
      message: 'Compensation leaves active dependents: ' + active.join(', '),
    })
  }
  return verifyReversals(
    graph,
    local,
    mode === 'cascade' ? [...active, target] : reversals,
    context.config.hashing,
  )
}

export interface ResolveOptions {
  readonly id: string
  readonly hash?: string
  readonly reason?: string
  readonly actor?: string
}

export interface ReshapeOptions extends ResolveOptions {
  readonly accept?: string
  readonly drop?: string
}

function audit(options: ResolveOptions) {
  return {
    actor: options.actor ?? process.env.USER ?? process.env.USERNAME ?? 'local-operator',
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  }
}

export async function resolveHash(context: CommandContext, options: ResolveOptions) {
  const adapter = database(context)
  const store = createStore(adapter, context.config.store)
  return store.withLock(async (owner) => {
    const local = await discoverMigrations(context.config.migrationsDir, context.config.hashing)
    const migration = local.find((item) => item.id === options.id)
    if (!migration)
      throw new Error('Cannot resolve a hash without a local migration: ' + options.id)
    if (options.hash !== undefined && options.hash !== migration.hash) {
      throw new Error('The supplied hash does not match the currently observed migration file')
    }
    await saveResolution(store, adapter.root, owner, migration, audit(options))
    return { id: migration.id, hash: migration.hash }
  })
}

async function saveResolution(
  store: MigrationStore,
  session: DatabaseSession,
  owner: string,
  migration: MigrationIdentity,
  info: ReturnType<typeof audit>,
): Promise<void> {
  await store.acceptHash(session, owner, migration.id, migration.hash, info)
}

export async function reshapeHash(context: CommandContext, options: ReshapeOptions) {
  if (Boolean(options.accept) === Boolean(options.drop)) {
    throw new Error('Choose exactly one accepted hash to add or drop')
  }
  const adapter = database(context)
  const store = createStore(adapter, context.config.store)
  return store.withLock(async (owner) => {
    if (options.accept) {
      await store.acceptHash(adapter.root, owner, options.id, options.accept, audit(options))
      return { id: options.id, added: options.accept }
    }
    await store.dropHash(adapter.root, owner, options.id, options.drop!, audit(options))
    return { id: options.id, removed: options.drop! }
  })
}

export async function recover(context: CommandContext, options: RecoveryOptions) {
  const adapter = database(context)
  await createStore(adapter, context.config.store).recover(options)
}
