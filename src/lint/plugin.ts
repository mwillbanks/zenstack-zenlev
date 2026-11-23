import { createHash } from 'node:crypto'
import { definePlugin, type WritePlan, type WriteProject } from '../plugins'
import { readLintCatalog } from './live'
import { createLintRunner } from './runner'
import { parseSqlLintInput, readMigrationLintInputs } from './source'
import type { LintInput, LintNode } from './types'

async function plannedInputs(
  plan: WritePlan,
  project: WriteProject,
): Promise<readonly LintInput[]> {
  const { config, adapter } = project
  if (plan.command === 'migrate apply') {
    const inputs: LintInput[] = []
    for (const { migration, direction } of plan.handlers) {
      inputs.push(
        await readMigrationLintInputs(migration.filePath, adapter.dialect, [direction], {
          hash: migration.hash,
          ...(config.hashing ? { hashing: config.hashing } : {}),
        }),
      )
    }
    return inputs
  }
  const inputs: LintInput[] = []
  for (const [index, statement] of plan.statements.entries()) {
    inputs.push(
      await parseSqlLintInput(statement, adapter.dialect, {
        path: '<db push>',
        line: index + 1,
        column: 1,
        fingerprint: createHash('sha256').update(statement).digest('hex'),
      }),
    )
  }
  const schema = plan.zmodel
  if (!schema || !plan.affected.length) return inputs
  const affected = new Set(plan.affected)
  const tables = new Set(
    plan.desired.tables
      .filter(({ name, namespace }) => affected.has(namespace ? namespace + '.' + name : name))
      .map(({ name }) => name),
  )
  const nodes = schema.nodes.filter((node) => {
    if (!node.table) return false
    const qualified = node.schema ? node.schema + '.' + node.table : node.table
    return affected.has(qualified) || (adapter.dialect === 'mysql' && tables.has(node.table))
  })
  const gaps = []
  for (const gap of schema.gaps) {
    const { identity } = gap
    if (
      identity &&
      (affected.has(identity) || (adapter.dialect === 'mysql' && tables.has(identity)))
    )
      gaps.push(gap)
  }
  inputs.push({ nodes, gaps, capabilities: schema.capabilities })
  return inputs
}

function resolveWriteNamespaces(
  nodes: readonly LintNode[],
  catalog: LintInput,
): readonly LintNode[] {
  const schema = catalog.defaultSchema
  if (!schema) return nodes
  return nodes.map((node) => {
    if (
      node.schema ||
      ['schema', 'extension', 'event-trigger', 'anonymous-block'].includes(node.kind)
    )
      return node
    return {
      ...node,
      schema,
      identity: node.identity ? schema + '.' + node.identity : undefined,
      targetSchema: node.targetSchema ?? (node.targetTable ? schema : undefined),
    }
  })
}

export function lintPlugin() {
  return definePlugin({
    name: 'zenlev-lint',
    setup(api) {
      api.onBeforeWrite(async (_context, plan, project) => {
        const { config, adapter } = project
        const lint = config.lint ?? {}
        const run = await createLintRunner(lint, config.cwd, config.lintPluginBase)
        const inputs = await plannedInputs(plan, project)
        const nodes = inputs.flatMap((input) => input.nodes)
        const gaps = inputs.flatMap((input) => input.gaps)
        const capabilities = inputs.flatMap((input) => input.capabilities ?? [])
        if (!nodes.length && !gaps.length) return
        const catalog = nodes.length
          ? await readLintCatalog(adapter, lint, config.store).catch((): LintInput => ({
              nodes: [],
              gaps: [{ message: 'Live catalog evidence is unavailable for this write plan' }],
            }))
          : { nodes: [], gaps: [] }
        const result = await run([
          {
            nodes: resolveWriteNamespaces(nodes, catalog),
            gaps: [...gaps, ...catalog.gaps],
            capabilities: [...capabilities, ...(catalog.capabilities ?? [])],
            context: catalog.nodes,
          },
        ])
        return [
          ...result.diagnostics,
          ...result.coverage.gaps.map((gap) => ({
            ...gap,
            ruleId: 'zenlev/coverage',
            severity: 'warn' as const,
          })),
        ]
      })
    },
  })
}
