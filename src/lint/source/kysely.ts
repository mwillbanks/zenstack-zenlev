import type { CallExpression, Node } from 'oxc-parser'
import { identity } from '../../identity'
import type { LintInput, LintSource } from '../types'
import { chainOf, memberName, methodOf, qualified, staticString, strings } from './kysely/ast'
import { emit, type BuilderContext } from './kysely/context'
import { readTable } from './kysely/table'

export { memberName, staticString } from './kysely/ast'

function orderedColumn(value: string | undefined): string | undefined {
  if (!value) return
  const [column, order] = value.split(' ')
  if (order !== undefined && !['asc', 'desc'].includes(order)) return
  return column
}

function readIndex(
  calls: readonly CallExpression[],
  context: BuilderContext,
  name: string,
  anchor: CallExpression,
): void {
  let target: string | undefined
  let columns: string[] | undefined
  let unique = false
  let incomplete = false
  for (const call of calls) {
    const method = methodOf(call)
    if (method === 'on') target = staticString(call.arguments[0])
    else if (method === 'column') {
      const column = orderedColumn(staticString(call.arguments[0]))
      if (column) (columns ??= []).push(column)
      else {
        incomplete = true
        context.gap(call, 'Dynamic Kysely index column cannot be analyzed.')
      }
    } else if (method === 'columns') {
      const values = strings(call.arguments[0])?.map(orderedColumn)
      if (values?.every((value) => value !== undefined)) (columns ??= []).push(...values)
      else {
        incomplete = true
        context.gap(call, 'Dynamic Kysely index column cannot be analyzed.')
      }
    } else if (method === 'unique') unique = true
    else if (method !== 'ifNotExists') {
      incomplete = true
      context.gap(call, 'Kysely index modifier is outside static analysis: ' + method)
    }
  }
  if (!target || !columns?.length || incomplete) {
    if (!incomplete) context.gap(anchor, 'Kysely schema definition requires manual review.')
    return
  }
  const table = qualified(target, context.schema)
  emit(context, 'index', name, {
    table: table.name,
    schema: table.schema,
    identity: identity(table.schema, table.name, name),
    columns,
    unique,
    partial: false,
  })
}

export function readKyselyBuilder(
  dialect: string | undefined,
  isSql: (node: Node) => boolean,
  gap: (node: Node, message: string) => void,
  location: (node: Node) => LintSource,
  addInput: (input: LintInput) => void,
) {
  return (expression: CallExpression): boolean => {
    const { calls: chain, root } = chainOf(expression)
    if (memberName(root) !== 'schema') return false
    let schema: string | undefined
    if (chain[0] && methodOf(chain[0]) === 'withSchema') {
      schema = staticString(chain.shift()!.arguments[0])
      if (!schema) {
        gap(expression, 'Dynamic Kysely schema cannot be analyzed.')
        return true
      }
    }
    const first = chain[0]
    if (!first) return false
    const method = methodOf(first)
    if (!['createTable', 'dropTable', 'createIndex', 'dropIndex'].includes(method)) return false
    const objectName = staticString(first.arguments[0])
    if (!objectName) {
      gap(first, 'Dynamic Kysely object identity cannot be analyzed.')
      return true
    }
    const target =
      method === 'createIndex' || method === 'dropIndex'
        ? { name: objectName, schema }
        : qualified(objectName, schema)
    const context: BuilderContext = {
      dialect,
      schema: target.schema,
      table: target.name,
      source: location(expression),
      nodes: [],
      gaps: [],
      isSql,
      gap,
    }
    if (method === 'createIndex') readIndex(chain.slice(1), context, target.name, first)
    else if (method === 'dropIndex') {
      const on = chain.find((call) => methodOf(call) === 'on')
      const tableName = on && staticString(on.arguments[0])
      if (dialect === 'mysql' && !tableName) {
        gap(first, 'MySQL DROP INDEX requires a statically known table.')
        return true
      }
      const table = tableName ? qualified(tableName, target.schema) : undefined
      emit(context, 'index', target.name, {
        table: table?.name,
        schema: table?.schema ?? target.schema,
        identity: identity(
          table?.schema ?? target.schema,
          ...[table?.name, target.name].filter((part): part is string => !!part),
        ),
        action: 'drop',
      })
    } else {
      emit(context, 'table', target.name, {
        table: undefined,
        identity: identity(target.schema, target.name),
        action: method === 'dropTable' ? 'drop' : 'create',
      })
      if (method === 'createTable') readTable(chain.slice(1), context)
    }
    addInput({ nodes: context.nodes, gaps: context.gaps })
    return true
  }
}
