import type {
  ApplyOptions,
  MigrationIdentity,
  MigrationMeta,
  MigrationStatus,
  Plan,
  PlanBlocker,
} from './types'

export interface RecordedMigration {
  readonly meta: MigrationMeta
  readonly hash: string
  readonly status: MigrationStatus
  readonly acceptedHashes?: readonly string[]
  /** Recovery explicitly clears this flag before an inspected attempt can be retried. */
  readonly unresolvedAttempt?: boolean
}

export interface GraphNode {
  readonly id: string
  readonly meta: MigrationMeta
  readonly status: MigrationStatus
  readonly local?: MigrationIdentity
  readonly record?: RecordedMigration
  readonly dependencies: readonly string[]
  readonly dependents: readonly string[]
  readonly supersededBy?: string
}

export interface MigrationGraph {
  /** Includes superseded history for inspection. */
  readonly nodes: ReadonlyMap<string, GraphNode>
  /** Effective nodes in stable dependency order. */
  readonly order: readonly string[]
  readonly replacements: ReadonlyMap<string, string>
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : Number(left > right)
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(lexical)
}

function validateMeta(meta: MigrationMeta): void {
  if (!meta.id || !meta.name || !meta.namespace || !Number.isFinite(Date.parse(meta.createdAt))) {
    throw new Error('Migration metadata requires an ID, name, namespace, and valid creation time')
  }
  if (meta.dependsOn?.includes(meta.id) || meta.supersedes?.includes(meta.id)) {
    throw new Error(`Migration ${meta.id} cannot reference itself`)
  }
}

function latest(left: MigrationMeta, right: MigrationMeta): MigrationMeta {
  const difference = Date.parse(left.createdAt) - Date.parse(right.createdAt)
  if (difference === 0) return lexical(left.id, right.id) > 0 ? left : right
  return difference > 0 ? left : right
}

/** Resolve a historical ID through all superseding replacements. */
export function resolveMigrationId(graph: MigrationGraph, id: string): string {
  if (!graph.nodes.has(id)) throw new Error(`Unknown migration: ${id}`)
  return graph.replacements.get(id) ?? id
}

function visitIds(
  nodes: ReadonlyMap<string, GraphNode>,
  start: Iterable<string>,
  direction: 'dependencies' | 'dependents',
): Set<string> {
  const found = new Set<string>()
  const pending = [...start]
  while (pending.length) {
    const id = pending.pop()!
    if (found.has(id)) continue
    found.add(id)
    pending.push(...nodes.get(id)![direction])
  }
  return found
}

/** Return effective transitive dependents, ordered for reverse execution. */
export function dependentMigrationIds(graph: MigrationGraph, id: string): readonly string[] {
  const target = resolveMigrationId(graph, id)
  const descendants = visitIds(graph.nodes, [target], 'dependents')
  return graph.order.filter((item) => item !== target && descendants.has(item)).reverse()
}

export function buildGraph(
  local: readonly MigrationIdentity[],
  history: readonly RecordedMigration[] = [],
): MigrationGraph {
  const definitions = new Map<string, MigrationIdentity>()
  const records = new Map<string, RecordedMigration>()
  for (const migration of local) {
    validateMeta(migration)
    if (definitions.has(migration.id)) throw new Error(`Duplicate migration: ${migration.id}`)
    definitions.set(migration.id, migration)
  }
  for (const record of history) {
    validateMeta(record.meta)
    if (records.has(record.meta.id)) throw new Error(`Duplicate history: ${record.meta.id}`)
    records.set(record.meta.id, record)
  }

  const ids = sorted([...definitions.keys(), ...records.keys()])
  const metadata = new Map(
    ids.map((id) => [id, definitions.get(id) ?? records.get(id)!.meta] as const),
  )
  const direct = new Map<string, string>()
  for (const [id, meta] of metadata) {
    const references = [
      ...(meta.dependsOn ?? []),
      ...(meta.supersedes ?? []),
      ...(meta.rollback ? [meta.rollback.target, ...meta.rollback.reversals] : []),
    ]
    for (const reference of references) {
      if (!metadata.has(reference)) {
        throw new Error(`Migration ${id} references missing migration ${reference}`)
      }
    }
    for (const target of meta.supersedes ?? []) {
      const previous = direct.get(target)
      const winner = previous ? latest(meta, metadata.get(previous)!) : meta
      direct.set(target, winner.id)
    }
  }

  const replacements = new Map<string, string>()
  for (const id of ids) {
    const path = new Set<string>([id])
    let replacement = id
    while (direct.has(replacement)) {
      replacement = direct.get(replacement)!
      if (path.has(replacement)) throw new Error(`Supersedes cycle involving ${replacement}`)
      path.add(replacement)
    }
    if (replacement !== id) replacements.set(id, replacement)
  }

  const nodes = new Map<string, GraphNode>()
  const dependents = new Map(ids.map((id) => [id, [] as string[]]))
  for (const id of ids) {
    const meta = metadata.get(id)!
    const localMigration = definitions.get(id)
    const record = records.get(id)
    const supersededBy = replacements.get(id)
    const dependencies = supersededBy
      ? []
      : sorted(
          (meta.dependsOn ?? []).map((dependency) => replacements.get(dependency) ?? dependency),
        )
    for (const dependency of dependencies) dependents.get(dependency)!.push(id)
    nodes.set(id, {
      id,
      meta,
      status: record?.status ?? 'pending',
      ...(localMigration ? { local: localMigration } : {}),
      ...(record ? { record } : {}),
      dependencies: Object.freeze(dependencies),
      dependents: [],
      ...(supersededBy ? { supersededBy } : {}),
    })
  }
  for (const [id, node] of nodes) {
    nodes.set(id, { ...node, dependents: Object.freeze(sorted(dependents.get(id)!)) })
  }

  const remaining = new Map(
    [...nodes.values()]
      .filter((node) => !node.supersededBy)
      .map((node) => [node.id, node.dependencies.length]),
  )
  const ready = sorted([...remaining].filter(([, count]) => count === 0).map(([id]) => id))
  const order: string[] = []
  while (ready.length) {
    const id = ready.shift()!
    order.push(id)
    for (const dependent of nodes.get(id)!.dependents) {
      const count = remaining.get(dependent)! - 1
      remaining.set(dependent, count)
      if (count === 0) {
        ready.push(dependent)
        ready.sort(lexical)
      }
    }
  }
  if (order.length !== remaining.size)
    throw new Error('Migration dependency graph contains a cycle')
  return { nodes, replacements, order: Object.freeze(order) }
}

function isApplied(node: GraphNode): boolean {
  return node.status === 'applied'
}

function hasUnresolvedAttempt(node: GraphNode): boolean {
  return (
    node.record?.unresolvedAttempt === true ||
    ((node.status === 'applying' || node.status === 'failed') &&
      node.record?.unresolvedAttempt !== false)
  )
}

export function planMigrations(
  graph: MigrationGraph,
  options: ApplyOptions = {},
  transactional: boolean = true,
): Plan {
  if (transactional && options.continueOnFailure && !options.noTransaction) {
    throw new Error('--continue-on-failure requires --no-transaction on transactional dialects')
  }
  const from = options.from
    ? visitIds(graph.nodes, [resolveMigrationId(graph, options.from)], 'dependents')
    : undefined
  const to = options.to
    ? visitIds(graph.nodes, [resolveMigrationId(graph, options.to)], 'dependencies')
    : undefined
  const only = options.only
    ? new Set(options.only.map((id) => resolveMigrationId(graph, id)))
    : undefined
  const selected = graph.order.filter((id) => {
    const node = graph.nodes.get(id)!
    return (
      (!from || from.has(id)) &&
      (!to || to.has(id)) &&
      (!only || only.has(id)) &&
      (!options.namespace || options.namespace.includes(node.meta.namespace)) &&
      (!options.tags || options.tags.some((tag) => node.meta.tags?.includes(tag)))
    )
  })
  const candidates = selected.filter((id) => {
    const status = graph.nodes.get(id)!.status
    return status !== 'applied' && status !== 'rolled_back'
  })
  const candidateSet = new Set(candidates)
  const relevant = visitIds(graph.nodes, selected, 'dependencies')
  for (const [historical, replacement] of graph.replacements) {
    if (relevant.has(replacement)) relevant.add(historical)
  }
  const blockers: PlanBlocker[] = []
  for (const id of sorted(relevant)) {
    const node = graph.nodes.get(id)!
    if (hasUnresolvedAttempt(node)) {
      blockers.push({
        migrationId: id,
        code: 'UNRESOLVED_ATTEMPT',
        message: `Migration ${id} has an unresolved execution attempt`,
      })
    }
    if (
      node.local &&
      node.record &&
      node.record.status !== 'pending' &&
      node.local.hash !== node.record.hash &&
      !node.record.acceptedHashes?.includes(node.local.hash)
    ) {
      blockers.push({
        migrationId: id,
        code: 'HASH_MISMATCH',
        message: `Migration ${id} differs from its recorded hash`,
      })
    }
  }
  for (const id of candidates) {
    const node = graph.nodes.get(id)!
    if (!node.local) {
      blockers.push({
        migrationId: id,
        code: 'PENDING_PREREQUISITE',
        message: `Migration ${id} has no local executable definition`,
      })
    }
    for (const dependency of node.dependencies) {
      if (!isApplied(graph.nodes.get(dependency)!) && !candidateSet.has(dependency)) {
        blockers.push({
          migrationId: id,
          code: 'PENDING_PREREQUISITE',
          message: `Migration ${id} requires pending migration ${dependency} outside the selected scope`,
        })
      }
    }
  }
  const migrations = candidates
    .map((id) => graph.nodes.get(id)!.local)
    .filter((migration): migration is MigrationIdentity => migration !== undefined)
  const useTransaction = transactional && !options.noTransaction
  const warnings = migrations.flatMap((migration) => migration.warnings ?? [])
  if (!useTransaction && migrations.length) {
    warnings.push({
      code: 'REDUCED_TRANSACTION_SAFETY',
      message: 'Migration changes can commit before the complete plan succeeds',
    })
  }
  return {
    migrations,
    namespaces: sorted(migrations.map((migration) => migration.namespace)),
    warnings,
    transactional: useTransaction,
    blockers,
  }
}
