import { unlink } from 'node:fs/promises'
import type { CommandContext } from './engine'
import { buildGraph, type GraphNode } from './graph'
import {
  authorMigration,
  discoverMigrations,
  verifyMigrationFile,
  type AuthorMigrationInput,
} from './migrations'
import { createStore } from './store'
import type { MigrationIdentity, MigrationStatus } from './types'

export type CreateOptions = Omit<
  AuthorMigrationInput,
  'hashing' | 'upBody' | 'downBody' | 'rollback' | 'baseline'
> & {
  readonly empty?: boolean
  readonly fromSchema?: string
  readonly toDb?: boolean
  readonly dropMissingTables?: 'apply' | 'skip'
  readonly confirmDrops?: (
    tables: readonly string[],
  ) => readonly string[] | Promise<readonly string[]>
}

export interface StatusOptions {
  readonly namespace?: readonly string[]
  readonly mismatchedOnly?: boolean
  readonly showResolved?: boolean
}

export interface StatusEntry {
  readonly id: string
  readonly name: string
  readonly namespace: string
  readonly status: MigrationStatus | 'superseded' | 'mismatched' | 'resolved'
  readonly supersededBy?: string
  readonly hash?: string
  readonly appliedHash?: string
}

export interface TreeOptions {
  readonly namespace?: readonly string[]
  readonly format?: 'text' | 'mermaid'
  readonly showSupersedes?: boolean
}

export interface RemoveOptions {
  readonly id?: readonly string[]
  readonly namespace?: string
  readonly all?: boolean
  readonly dryRun?: boolean
  readonly force?: boolean
  readonly confirm?: (migrations: readonly MigrationIdentity[]) => boolean | Promise<boolean>
}

function storeFor(context: CommandContext) {
  return context.adapter && createStore(context.adapter, context.config.store)
}

async function snapshot(context: CommandContext) {
  const [local, records] = await Promise.all([
    discoverMigrations(context.config.migrationsDir, context.config.hashing),
    storeFor(context)?.read() ?? [],
  ])
  await context.plugins.storeRead(
    records.map(({ meta, hash, status }) => ({
      id: meta.id,
      namespace: meta.namespace,
      hash,
      status,
    })),
  )
  return { local, records, graph: buildGraph(local, records) }
}

function selected(node: GraphNode, namespaces?: readonly string[]): boolean {
  return namespaces === undefined || namespaces.includes(node.meta.namespace)
}

function statusOf(node: GraphNode): StatusEntry['status'] {
  if (
    node.status === 'applied' &&
    node.local &&
    node.record &&
    node.local.hash !== node.record.hash
  ) {
    return node.record.acceptedHashes?.includes(node.local.hash) ? 'resolved' : 'mismatched'
  }
  return node.supersededBy !== undefined && node.status === 'pending' ? 'superseded' : node.status
}

export async function status(
  context: CommandContext,
  options: StatusOptions,
): Promise<StatusEntry[]> {
  const { graph } = await snapshot(context)
  return [...graph.nodes.values()]
    .filter((node) => selected(node, options.namespace))
    .map((node) => {
      const state = statusOf(node)
      return {
        id: node.id,
        name: node.meta.name,
        namespace: node.meta.namespace,
        status: state === 'resolved' && !options.showResolved ? node.status : state,
        ...(node.local ? { hash: node.local.hash } : {}),
        ...(node.record ? { appliedHash: node.record.hash } : {}),
        ...(node.supersededBy ? { supersededBy: node.supersededBy } : {}),
      }
    })
    .filter((entry) => !options.mismatchedOnly || entry.status === 'mismatched')
}

function mermaid(
  nodes: readonly GraphNode[],
  visible: ReadonlySet<string>,
  supersedes: boolean,
): string {
  const lines = ['flowchart TD']
  for (const node of nodes) {
    lines.push(
      '  m_' +
        node.id +
        '[' +
        JSON.stringify(node.id + ' ' + node.meta.name + ' (' + statusOf(node) + ')') +
        ']',
    )
    for (const predecessor of node.dependencies) {
      if (visible.has(predecessor)) lines.push('  m_' + predecessor + ' --> m_' + node.id)
    }
    if (supersedes && node.supersededBy && visible.has(node.supersededBy)) {
      lines.push('  m_' + node.supersededBy + ' -. supersedes .-> m_' + node.id)
    }
  }
  return lines.join('\n')
}

function treeText(
  nodes: readonly GraphNode[],
  graph: ReadonlyMap<string, GraphNode>,
  visible: ReadonlySet<string>,
  supersedes: boolean,
): string {
  const roots = nodes.filter((node) => node.dependencies.every((id) => !visible.has(id)))
  const stack = roots.toReversed().map((node) => ({ node, depth: 0 }))
  const seen = new Set<string>()
  const lines: string[] = []
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!
    const prefix = depth === 0 ? '' : '  '.repeat(depth - 1) + '└─ '
    if (seen.has(node.id)) {
      lines.push(prefix + node.id + ' (see above)')
      continue
    }
    seen.add(node.id)
    const replacement = supersedes && node.supersededBy ? ' → ' + node.supersededBy : ''
    lines.push(prefix + node.id + ' ' + node.meta.name + ' [' + statusOf(node) + ']' + replacement)
    for (const id of node.dependents.toReversed()) {
      const child = graph.get(id)
      if (child && visible.has(id)) stack.push({ node: child, depth: depth + 1 })
    }
  }
  return lines.join('\n')
}

export async function tree(context: CommandContext, options: TreeOptions): Promise<string> {
  const { graph } = await snapshot(context)
  const nodes = [...graph.nodes.values()].filter((node) => selected(node, options.namespace))
  const visible = new Set(nodes.map(({ id }) => id))
  return options.format === 'mermaid'
    ? mermaid(nodes, visible, options.showSupersedes ?? false)
    : treeText(nodes, graph.nodes, visible, options.showSupersedes ?? false)
}

export async function prepareAuthoring(
  context: CommandContext,
  options: Pick<CreateOptions, 'dependsOn' | 'supersedes'>,
): Promise<(identity: MigrationIdentity) => void> {
  const { graph, local, records } = await snapshot(context)
  for (const id of [...(options.dependsOn ?? []), ...(options.supersedes ?? [])]) {
    if (!graph.nodes.has(id)) throw new Error('Unknown migration: ' + id)
  }
  return (identity) => {
    buildGraph([...local, identity], records)
  }
}

export async function create(
  context: CommandContext,
  options: CreateOptions,
): Promise<MigrationIdentity> {
  const make = async () => {
    const validate = await prepareAuthoring(context, options)
    return authorMigration(
      context.config.migrationsDir,
      {
        ...options,
        ...(context.config.hashing ? { hashing: context.config.hashing } : {}),
      },
      { validate },
    )
  }
  const store = storeFor(context)
  return store ? store.withLock(make) : make()
}

export async function remove(
  context: CommandContext,
  options: RemoveOptions,
): Promise<MigrationIdentity[]> {
  if (!options.all && !options.namespace && !options.id?.length) {
    throw new Error('Choose migration IDs, a namespace, or all pending migrations')
  }
  if (options.all && (options.namespace || options.id?.length)) {
    throw new Error('Use --all without IDs or a namespace')
  }
  const run = async () => {
    const { local, records, graph } = await snapshot(context)
    for (const id of options.id ?? []) {
      if (!local.some((item) => item.id === id)) throw new Error('No local migration: ' + id)
    }
    const matches = local.filter(
      (item) =>
        (!options.id?.length || options.id.includes(item.id)) &&
        (!options.namespace || item.namespace === options.namespace),
    )
    const candidates = matches.filter(({ id }) => !graph.nodes.get(id)?.record)
    if (options.id?.length && candidates.length < matches.length) {
      throw new Error('A recorded migration cannot be removed')
    }
    const ids = new Set(candidates.map(({ id }) => id))
    buildGraph(
      local.filter(({ id }) => !ids.has(id)),
      records,
    )
    const identities = candidates.map(({ up: _up, down: _down, ...identity }) => identity)
    if (options.dryRun || identities.length === 0) return identities
    if (!options.force && !(await options.confirm?.(identities))) {
      throw new Error('Migration removal requires confirmation or --force')
    }
    for (const identity of identities) {
      await verifyMigrationFile(identity, context.config.hashing)
    }
    const order = [...graph.order].reverse()
    const ranks = new Map(order.map((id, index) => [id, index]))
    identities.sort((a, b) => (ranks.get(a.id) ?? -1) - (ranks.get(b.id) ?? -1))
    for (const identity of identities) await unlink(identity.filePath)
    return identities
  }
  if (options.dryRun) return run()
  const store = storeFor(context)
  if (!store) throw new Error('Configure a database to verify that the migrations are unrecorded')
  return store.withLock(run)
}
