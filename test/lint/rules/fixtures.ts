import { builtinRules } from '../../../src/lint/rules'
import type { LintNode, LintReport, LintRuleContext } from '../../../src/lint/types'

export function node(kind: string, name: string, extra: Partial<LintNode> = {}): LintNode {
  return { kind, name, origin: 'sql', dialect: 'postgresql', schema: 'app', ...extra }
}

export function inspect(
  id: string,
  nodes: readonly LintNode[],
  options?: unknown,
  visited = nodes,
) {
  const reports: LintReport[] = []
  const gaps: string[] = []
  const context: LintRuleContext = {
    options: options === undefined ? [] : [options],
    nodes,
    capabilities: ['tables', 'columns', 'indexes', 'constraints', 'rls', 'policies'],
    report: (report) => reports.push(report),
    gap: (message) => gaps.push(message),
  }
  const visitors = builtinRules[id]!.create(context)
  for (const current of visited) {
    visitors[current.kind]?.(current)
    visitors['*']?.(current)
  }
  return { reports, gaps, messages: reports.map((report) => String(report.data?.message)) }
}

export const table = node('table', 'orders')
export const primary = node('primary-key', 'orders_pkey', { table: 'orders', columns: ['id'] })
export const id = node('column', 'id', {
  table: 'orders',
  type: 'uuid',
  nullable: false,
  sequential: false,
})
export const fk = node('foreign-key', 'fk_orders_customer_id', {
  table: 'orders',
  columns: ['customer_id'],
  targetTable: 'customers',
  targetColumns: ['id'],
})
export const index = node('index', 'idx_orders_customer_id', {
  table: 'orders',
  columns: ['customer_id'],
})
