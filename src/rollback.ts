import type { CommandContext } from './engine'
import { buildGraph, type MigrationGraph } from './graph'
import {
  authorMigration,
  discoverMigrations,
  verifyMigrationFile,
  type HashSettings,
  type LoadedMigration,
} from './migrations'
import { createStore } from './store'
import type { MigrationIdentity, Warning } from './types'

export interface RollbackOptions {
  readonly id: string
  readonly mode: 'cascade' | 'compensate'
  readonly namespace?: string
  readonly name?: string
  readonly dryRun?: boolean
  readonly format?: boolean
}

export interface RollbackResult {
  readonly reversals: readonly string[]
  readonly warnings: readonly Warning[]
  readonly migration?: MigrationIdentity
}

export function activeDependentIds(graph: MigrationGraph, target: string): string[] {
  // Stored dependencies represent the effective prerequisites when each migration ran.
  const active = [...graph.nodes.values()].filter(({ record }) => record?.status === 'applied')
  const children = new Map<string, string[]>()
  for (const node of active) {
    for (const parent of node.record?.meta.dependsOn ?? []) {
      const existing = children.get(parent) ?? []
      existing.push(node.id)
      children.set(parent, existing)
    }
  }
  const visiting = new Set<string>()
  const seen = new Set<string>()
  const result: string[] = []
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Cyclic applied migration history at ' + id)
    if (seen.has(id)) return
    visiting.add(id)
    for (const child of (children.get(id) ?? []).sort()) visit(child)
    visiting.delete(id)
    seen.add(id)
    if (id !== target) result.push(id)
  }
  visit(target)
  return result
}

export function assertReversibleHistory(graph: MigrationGraph, target: string): void {
  const archived = [...graph.nodes.values()].some(
    ({ record }) =>
      record?.status === 'applied' &&
      record.meta.baseline &&
      record.meta.supersedes?.includes(target),
  )
  if (graph.nodes.get(target)?.meta.baseline || archived) {
    throw new Error('A baseline and its archived history require a forward migration')
  }
}

export async function verifyReversals(
  graph: MigrationGraph,
  local: ReadonlyMap<string, LoadedMigration>,
  reversals: readonly string[],
  hashing?: HashSettings,
): Promise<LoadedMigration[]> {
  const result: LoadedMigration[] = []
  for (const id of reversals) {
    const record = graph.nodes.get(id)?.record
    if (record?.status !== 'applied') continue
    const migration = local.get(id)
    if (!migration?.down) throw new Error('Active migration has no local down handler: ' + id)
    if (migration.hash !== record.hash && !record.acceptedHashes?.includes(migration.hash)) {
      throw new Error('Down handler hash does not match applied migration: ' + id)
    }
    await verifyMigrationFile(migration, hashing)
    result.push(migration)
  }
  return result
}

export async function rollback(
  context: CommandContext,
  options: RollbackOptions,
): Promise<RollbackResult> {
  if (options.mode !== 'cascade' && options.mode !== 'compensate') {
    throw new Error('Choose either --cascade or --compensate')
  }
  const adapter = context.adapter
  if (!adapter) throw new Error('Configure a database to generate a rollback')
  const store = createStore(adapter, context.config.store)
  const generate = async (): Promise<RollbackResult> => {
    const history = await store.read()
    const files = await discoverMigrations(context.config.migrationsDir, context.config.hashing)
    const graph = buildGraph(files, history)
    const active = graph.nodes.get(options.id)
    if (active?.record?.status !== 'applied') {
      throw new Error('Target migration must be actively applied: ' + options.id)
    }
    assertReversibleHistory(graph, options.id)
    const dependents = activeDependentIds(graph, options.id)
    const reversals = [...(options.mode === 'cascade' ? dependents : []), options.id]
    await verifyReversals(
      graph,
      new Map(files.map((file) => [file.id, file])),
      reversals,
      context.config.hashing,
    )
    const warnings: Warning[] = []
    if (options.mode === 'compensate' && dependents.length > 0) {
      warnings.push({
        code: 'ACTIVE_DEPENDENTS',
        message: 'Compensation leaves active dependents: ' + dependents.join(', '),
        migrationId: options.id,
      })
    }
    if (options.dryRun) return { reversals, warnings }
    const migration = await authorMigration(context.config.migrationsDir, {
      name: options.name ?? 'rollback_' + active.meta.name,
      namespace: options.namespace ?? active.meta.namespace,
      supersedes: reversals,
      rollback: { mode: options.mode, target: options.id, reversals },
      warnings,
      upBody: '// Zenlev verifies and invokes the down handlers listed in meta.rollback.',
      ...(options.format === undefined ? {} : { format: options.format }),
      ...(context.config.hashing ? { hashing: context.config.hashing } : {}),
    })
    return { reversals, warnings, migration }
  }
  return options.dryRun ? generate() : store.withLock(generate)
}
