import type { Node } from 'oxc-parser'
import { identity } from '../../../identity'
import type { LintGap, LintNode, LintSource } from '../../types'
import { extractExpressionCalls } from '../query'
import { identifier, keyword, tokenize, words } from '../tokens'
import { memberName, staticString } from './ast'

export interface BuilderContext {
  readonly dialect: string | undefined
  readonly schema: string | undefined
  readonly table: string
  readonly source: LintSource
  readonly nodes: LintNode[]
  readonly gaps: LintGap[]
  readonly isSql: (node: Node) => boolean
  readonly gap: (node: Node, message: string) => void
}

export function emit(
  context: BuilderContext,
  kind: string,
  name: string,
  values: Partial<LintNode> = {},
): LintNode {
  const node: LintNode = {
    kind,
    name,
    dialect: context.dialect,
    schema: context.schema,
    table: context.table,
    identity: identity(context.schema, context.table, name),
    source: context.source,
    origin: 'migration',
    action: 'create',
    spelling: name,
    ...(context.dialect ? { quoted: true } : {}),
    explicit: true,
    ...values,
  }
  context.nodes.push(node)
  return node
}

export function constraint(
  context: BuilderContext,
  kind: string,
  name: string | undefined,
  columns: readonly string[],
  extra: Partial<LintNode> = {},
): LintNode {
  return emit(context, kind, name ?? '', {
    columns,
    ...(kind === 'unique' ? { unique: true } : {}),
    generated: name === undefined,
    explicit: name !== undefined,
    identity: identity(
      context.schema,
      context.table,
      name ??
        [
          kind,
          ...columns,
          context.source.path,
          context.source.line,
          context.source.column,
          context.nodes.length,
        ].join(':'),
    ),
    ...extra,
  })
}

export function expression(value: Node | undefined, context: BuilderContext): string | undefined {
  if (value?.type === 'Literal') {
    if (typeof value.value === 'string') return "'" + value.value.replaceAll("'", "''") + "'"
    if (typeof value.value === 'number') return String(value.value)
    if (typeof value.value === 'boolean') return value.value ? 'TRUE' : 'FALSE'
    if (value.value === null) return 'NULL'
  }
  if (
    value?.type === 'UnaryExpression' &&
    (value.operator === '-' || value.operator === '+') &&
    value.argument.type === 'Literal' &&
    typeof value.argument.value === 'number'
  ) {
    const number = value.operator === '-' ? -value.argument.value : value.argument.value
    return words(tokenize(String(number), context.dialect ?? ''))
  }
  let text: string | undefined
  if (value?.type === 'TaggedTemplateExpression' && context.isSql(value.tag))
    text = staticString(value.quasi)
  if (
    value?.type === 'CallExpression' &&
    value.callee.type === 'MemberExpression' &&
    memberName(value.callee) === 'raw' &&
    context.isSql(value.callee.object)
  )
    text = staticString(value.arguments[0])
  if (text === undefined) return
  if (!context.dialect) {
    context.gap(value!, 'SQL expression analysis requires a supported dialect.')
    return text
  }
  const tokens = tokenize(text, context.dialect)
  const gaps: LintGap[] = []
  extractExpressionCalls(
    text,
    tokens,
    context.source,
    (kind, item, extra) =>
      emit(context, kind, item.name, {
        schema: item.schema,
        table: undefined,
        identity: identity(item.schema, item.name),
        quoted: item.token.quoted,
        spelling: item.token.text,
        ...extra,
      }),
    gaps,
  )
  context.gaps.push(...gaps.map((gap) => ({ ...gap, source: context.source })))
  return words(tokens)
}

export function sequentialDefault(value: string | undefined, dialect: string | undefined): boolean {
  if (dialect !== 'postgresql' || !value) return false
  const tokens = tokenize(value, dialect)
  return tokens.some((token, index) => {
    if (keyword(tokens[index - 1], '.')) return false
    const target = identifier(tokens, index)
    return (
      target?.name === 'nextval' &&
      (!target.schema || target.schema === 'pg_catalog') &&
      keyword(tokens[target.end], '(')
    )
  })
}
