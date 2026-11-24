import { identity } from '../../identity'
import type { LintNode, LintRule, LintRuleContext } from '../types'

export type Options = Record<string, unknown>

function options(context: LintRuleContext): Options {
  const value = context.options[0]
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Lint rule options must be an object')
  }
  return value as Options
}

export function strings(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('Lint rule lists must contain strings')
  }
  return value as readonly string[]
}

export function text(value: unknown, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new TypeError('Lint rule values must be strings')
  return value
}

export function matches(value: string, pattern: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp('^' + expression + '$').test(value)
}

export function qualified(node: LintNode): string {
  return identity(node.schema, ...(node.table === undefined ? [] : [node.table]), node.name)
}

export function tableIdentity(node: LintNode): string {
  const table = node.kind === 'table' || node.kind === 'view' ? node.name : node.table
  return table === undefined ? '' : identity(node.schema, table)
}

export function selected(node: LintNode, config: Options): boolean {
  const kinds = strings(config.kinds)
  const include = strings(config.include)
  const exclude = strings(config.exclude)
  const name = node.identity ?? qualified(node)
  return (
    (kinds.length === 0 || kinds.includes(node.kind)) &&
    (include.length === 0 || include.some((pattern) => matches(name, pattern))) &&
    !exclude.some((pattern) => matches(name, pattern))
  )
}

export function sameTable(left: LintNode, right: LintNode): boolean {
  return tableIdentity(left) === tableIdentity(right)
}

function activeNodes(context: LintRuleContext): readonly LintNode[] {
  const active = new Map<string, LintNode>()
  for (const node of context.nodes) {
    const table = tableIdentity(node)
    if (node.kind === 'table' && node.action === 'drop') {
      for (const [key, previous] of active) {
        if (tableIdentity(previous) === table) active.delete(key)
      }
      continue
    }
    const key = JSON.stringify([
      node.kind,
      node.identity ?? [node.schema, node.table, node.name, node.signature],
      !node.identity && !node.name
        ? [node.columns, node.targetTable, node.targetColumns, node.source]
        : undefined,
    ])
    if (node.action === 'drop') active.delete(key)
    else {
      const previous = active.get(key)
      active.set(
        key,
        previous && (node.action === 'alter' || node.kind === 'rls')
          ? {
              ...previous,
              ...Object.fromEntries(
                Object.entries(node).filter(([, value]) => value !== undefined),
              ),
            }
          : node,
      )
    }
  }
  return [...active.values()]
}

export function defineRule(
  description: string,
  create: (context: LintRuleContext, config: Options) => ReturnType<LintRule['create']>,
): LintRule {
  return {
    meta: {
      description,
      messages: { violation: '{{message}}' },
    },
    create(context) {
      let anchor: LintNode | undefined
      const visitors = create(
        {
          ...context,
          nodes: activeNodes(context),
          report: (finding) => context.report({ ...finding, anchor: finding.anchor ?? anchor }),
          gap: (message, node) => context.gap(message, node, anchor),
        },
        options(context),
      )
      return Object.fromEntries(
        Object.entries(visitors).map(([kind, visit]) => [
          kind,
          (node: LintNode) => {
            anchor = node
            try {
              visit(node)
            } finally {
              anchor = undefined
            }
          },
        ]),
      )
    },
  }
}

export function defineTableRule(
  description: string,
  create: (context: LintRuleContext, config: Options) => ReturnType<LintRule['create']>,
): LintRule {
  return defineRule(description, (context, config) => {
    const visit = create(context, config).table!
    const checked = new Set<string>()
    return {
      '*': (node) => {
        if (node.kind === 'table' && node.action === 'drop') return
        const identity = tableIdentity(node)
        if (!identity || checked.has(identity)) return
        const table = context.nodes.find(
          (candidate) => candidate.kind === 'table' && tableIdentity(candidate) === identity,
        )
        if (!table) return
        checked.add(identity)
        visit({ ...table, ...(node.source ? { source: node.source } : {}) })
      },
    }
  })
}

export function report(context: LintRuleContext, node: LintNode, message: string): void {
  context.report({ node, messageId: 'violation', data: { message } })
}

export function record(value: unknown): Options {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Lint rule mappings must be objects')
  }
  return value as Options
}

export const stringList = { type: 'array', items: { type: 'string' }, uniqueItems: true }
export const stringValue = { type: 'string' }
export const booleanValue = { type: 'boolean' }

export function configuredRule(
  rule: LintRule,
  properties: Readonly<Record<string, object>>,
): LintRule {
  return {
    ...rule,
    meta: {
      ...rule.meta,
      schema: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            include: stringList,
            exclude: stringList,
            kinds: stringList,
            ...properties,
          },
        },
      ],
    },
  }
}

export function isTrue(expression: string | null | undefined): boolean {
  if (typeof expression !== 'string') return false
  const bool = String.raw`(?:pg_catalog\s*\.\s*)?(?:bool|boolean)`
  const suffix = new RegExp(String.raw`\s*::\s*${bool}$`, 'i')
  const cast = new RegExp(String.raw`^cast\s*\((.+)\s+as\s+${bool}\s*\)$`, 'is')
  let value = expression.trim()
  for (;;) {
    if (/^true$/i.test(value)) return true
    const stripped =
      value.startsWith('(') && value.endsWith(')')
        ? value.slice(1, -1)
        : (cast.exec(value)?.[1] ?? value.replace(suffix, ''))
    if (stripped === value) return false
    value = stripped.trim()
  }
}
