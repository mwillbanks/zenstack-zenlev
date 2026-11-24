import type { CallExpression, Node } from 'oxc-parser'

export function staticString(node: Node | null | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined
}

export function memberName(node: Node | null | undefined): string | undefined {
  if (node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier')
    return node.property.name
}

export function chainOf(expression: Node) {
  const calls: CallExpression[] = []
  let root = expression
  while (root.type === 'CallExpression' && root.callee.type === 'MemberExpression') {
    calls.unshift(root)
    root = root.callee.object
  }
  return { calls, root }
}

export function methodOf(call: CallExpression): string {
  return memberName(call.callee) ?? '<computed>'
}

export function strings(array: Node | undefined): string[] | undefined {
  if (
    array?.type === 'ArrayExpression' &&
    array.elements.every((element) => staticString(element) !== undefined)
  )
    return array.elements.map((element) => staticString(element)!)
}

export function qualified(name: string, schema?: string) {
  const parts = name.split('.')
  return {
    name: parts.at(-1)!,
    schema: parts.length > 1 ? parts.slice(0, -1).join('.') : schema,
  }
}

export function modifierCalls(
  callback: Node | undefined,
  gap: (node: Node, message: string) => void,
): readonly CallExpression[] {
  if (!callback) return []
  if (
    callback.type === 'ArrowFunctionExpression' &&
    callback.body.type !== 'BlockStatement' &&
    callback.params[0]?.type === 'Identifier'
  ) {
    const { calls, root } = chainOf(callback.body)
    if (root.type === 'Identifier' && root.name === callback.params[0].name) return calls
  }
  gap(callback, 'Kysely modifier callback requires manual review.')
  return []
}
