import type { CallExpression } from 'oxc-parser'
import { constraint, emit, expression, sequentialDefault, type BuilderContext } from './context'
import { methodOf, modifierCalls, qualified, staticString, strings } from './ast'

function addColumn(call: CallExpression, context: BuilderContext): void {
  const name = staticString(call.arguments[0])
  const type = staticString(call.arguments[1])
  if (!name || !type) {
    context.gap(call, 'Dynamic Kysely column definition cannot be analyzed.')
    return
  }
  const column = emit(context, 'column', name, {
    type: context.dialect === 'mysql' && type === 'integer' ? 'int' : type,
    nullable: true,
    sequential:
      context.dialect === 'postgresql' || context.dialect === 'mysql'
        ? /^(?:smallserial|serial|bigserial|serial2|serial4|serial8)$/i.test(type)
        : undefined,
  })
  const uncertain = (node: Parameters<BuilderContext['gap']>[0], message: string) => {
    Object.assign(column, { partial: true, nullable: undefined })
    context.gap(node, message)
  }
  for (const modifier of modifierCalls(call.arguments[2], uncertain)) {
    const method = methodOf(modifier)
    if (method === 'primaryKey') constraint(context, 'primary-key', undefined, [name])
    else if (method === 'notNull') Object.assign(column, { nullable: false })
    else if (method === 'unique') constraint(context, 'unique', undefined, [name])
    else if (method === 'autoIncrement') Object.assign(column, { sequential: true })
    else if (method === 'defaultTo') {
      const value = expression(modifier.arguments[0], context)
      if (value === undefined) uncertain(modifier, 'Dynamic Kysely default cannot be analyzed.')
      else
        Object.assign(column, {
          default: value,
          ...(sequentialDefault(value, context.dialect) ? { sequential: true } : {}),
        })
    } else if (method === 'references') {
      const parts = staticString(modifier.arguments[0])?.split('.')
      if (!parts || parts.length < 2) {
        context.gap(modifier, 'Dynamic Kysely reference cannot be analyzed.')
        continue
      }
      const targetColumn = parts.pop()!
      const target = qualified(parts.join('.'), context.schema)
      constraint(context, 'foreign-key', undefined, [name], {
        targetSchema: target.schema,
        targetTable: target.name,
        targetColumns: [targetColumn],
      })
    } else if (['onDelete', 'onUpdate'].includes(method)) {
      if (!staticString(modifier.arguments[0]))
        context.gap(modifier, 'Dynamic Kysely referential action cannot be analyzed.')
    } else uncertain(modifier, 'Kysely column modifier is outside static analysis: ' + method)
  }
}

export function readTable(calls: readonly CallExpression[], initial: BuilderContext): void {
  const table = initial.nodes.find((node) => node.kind === 'table')!
  Object.assign(table, { checksKnown: true })
  const context: BuilderContext = {
    ...initial,
    gap(node, message) {
      Object.assign(table, { checksKnown: false, partial: true })
      initial.gap(node, message)
    },
  }
  for (const call of calls) {
    const method = methodOf(call)
    if (['ifNotExists', 'temporary'].includes(method)) continue
    if (method === 'addColumn') addColumn(call, context)
    else if (
      ['addPrimaryKeyConstraint', 'addUniqueConstraint', 'addForeignKeyConstraint'].includes(method)
    ) {
      const name = staticString(call.arguments[0])
      const columns = strings(call.arguments[1])
      if (!name || !columns) {
        context.gap(call, 'Dynamic Kysely constraint cannot be analyzed.')
        continue
      }
      const kind =
        method === 'addPrimaryKeyConstraint'
          ? 'primary-key'
          : method === 'addUniqueConstraint'
            ? 'unique'
            : 'foreign-key'
      if (kind === 'foreign-key') {
        const table = staticString(call.arguments[2])
        const targetColumns = strings(call.arguments[3])
        if (!table || !targetColumns) {
          context.gap(call, 'Dynamic Kysely foreign key target cannot be analyzed.')
          continue
        }
        const target = qualified(table, context.schema)
        constraint(context, kind, name, columns, {
          targetTable: target.name,
          targetSchema: target.schema,
          targetColumns,
        })
        for (const modifier of modifierCalls(call.arguments[4], context.gap)) {
          if (
            !['onDelete', 'onUpdate'].includes(methodOf(modifier)) ||
            !staticString(modifier.arguments[0])
          )
            context.gap(modifier, 'Kysely foreign key modifier requires manual review.')
        }
      } else constraint(context, kind, name, columns)
    } else if (method === 'addCheckConstraint') {
      const name = staticString(call.arguments[0])
      const value = expression(call.arguments[1], context)
      if (name && value !== undefined) constraint(context, 'check', name, [])
      else context.gap(call, 'Dynamic Kysely check constraint cannot be analyzed.')
    } else context.gap(call, 'Kysely schema modifier is outside static analysis: ' + method)
  }
  const primary = context.nodes.find((node) => node.kind === 'primary-key')
  for (const column of context.nodes.filter((node) => node.kind === 'column')) {
    if (!primary?.columns?.includes(column.name)) continue
    if (context.dialect === 'postgresql' || context.dialect === 'mysql')
      Object.assign(column, { nullable: false })
    if (context.dialect === 'sqlite' && table.partial && column.nullable !== false)
      Object.assign(column, { nullable: undefined })
    if (
      context.dialect === 'sqlite' &&
      !table.partial &&
      primary.columns.length === 1 &&
      column.type?.toLowerCase() === 'integer'
    )
      Object.assign(column, { sequential: true, nullable: false })
  }
}
