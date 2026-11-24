import { identity } from '../identity'
import type { LintNode } from './types'

/** Resolve tableless index drops against earlier operations and any live catalog. */
export function resolveIndexDrops(
  nodes: readonly LintNode[],
  catalog: readonly LintNode[],
): readonly LintNode[] {
  const indexes = new Map<string, LintNode>()
  for (const node of catalog)
    if (node.kind === 'index') indexes.set(identity(node.schema, node.name), node)

  return nodes.map((node) => {
    if (node.kind === 'table' && node.action === 'drop') {
      for (const [key, index] of indexes)
        if (index.schema === node.schema && index.table === node.name) indexes.delete(key)
    }
    if (node.kind !== 'index') return node

    const key = identity(node.schema, node.name)
    if (node.action !== 'drop') {
      indexes.set(key, node)
      return node
    }

    // PostgreSQL and SQLite can identify an index without naming its table.
    const table = node.table ?? indexes.get(key)?.table
    indexes.delete(key)
    return table ? { ...node, table, identity: identity(node.schema, table, node.name) } : node
  })
}
