import type { Node } from 'oxc-parser'

export interface ApplicationValue {
  readonly kind:
    | 'client'
    | 'builder'
    | 'delegate'
    | 'schema'
    | 'sql'
    | 'driver'
    | 'method'
    | 'constructor'
    | 'module'
    | 'unknown'
  readonly result?: ApplicationValue | undefined
  readonly members?: ReadonlyMap<string, ApplicationValue> | undefined
  readonly query?: 'query-builder' | 'query-api' | 'raw' | 'schema-change' | undefined
  readonly direct?: 'kysely' | 'low-level' | undefined
  readonly transaction?: boolean | undefined
}

export type ApplicationScope = Map<string, ApplicationValue | undefined>

export const unknownValue: ApplicationValue = { kind: 'unknown' }
const client: ApplicationValue = { kind: 'client' }
const builder: ApplicationValue = { kind: 'builder' }
const directBuilder: ApplicationValue = { kind: 'builder', direct: 'kysely' }
const driver: ApplicationValue = { kind: 'driver' }
const queryMethods = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
])
const builderMethods = new Set([
  'selectFrom',
  'insertInto',
  'updateTable',
  'deleteFrom',
  'mergeInto',
  'replaceInto',
  'with',
  'withRecursive',
])
const rawMethods = new Set(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'])
const driverMethods = new Set([
  'query',
  'execute',
  'prepare',
  'exec',
  'run',
  'all',
  'get',
  'unsafe',
])

export function applicationName(node: Node): string | undefined {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
}

export function applicationMember(node: Node): string | undefined {
  if (node.type !== 'MemberExpression') return
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string')
    return node.property.value
}

export function knownApplicationModule(name: string): ApplicationValue | undefined {
  if (name === 'kysely')
    return {
      kind: 'module',
      members: new Map([
        ['Kysely', { kind: 'constructor', result: directBuilder }],
        ['Transaction', { kind: 'constructor', result: directBuilder }],
        ['sql', { kind: 'sql' }],
        ['CompiledQuery', { kind: 'sql' }],
      ]),
    }
  if (name === 'bun')
    return {
      kind: 'module',
      members: new Map([
        ['SQL', { kind: 'constructor', result: { kind: 'sql' } }],
        ['sql', { kind: 'sql' }],
      ]),
    }
  if (name === '@zenstackhq/orm')
    return {
      kind: 'module',
      members: new Map([['ZenStackClient', { kind: 'constructor', result: client }]]),
    }
  if (
    [
      'pg',
      'mysql2',
      'mysql2/promise',
      'bun:sqlite',
      'better-sqlite3',
      'sqlite3',
      'node:sqlite',
      'postgres',
    ].includes(name)
  ) {
    const members = new Map<string, ApplicationValue>([
      ['Client', { kind: 'constructor', result: driver }],
      ['Pool', { kind: 'constructor', result: driver }],
      ['Database', { kind: 'constructor', result: driver }],
      ['DatabaseSync', { kind: 'constructor', result: driver }],
      ['createConnection', { kind: 'method', result: driver }],
      ['createPool', { kind: 'method', result: driver }],
    ])
    const module: ApplicationValue = { kind: 'module', members }
    members.set(
      'default',
      name === 'postgres'
        ? { kind: 'method', result: { kind: 'sql' } }
        : name === 'better-sqlite3'
          ? { kind: 'constructor', result: driver }
          : module,
    )
    return module
  }
}

export function applicationProperty(
  value: ApplicationValue | undefined,
  name: string,
): ApplicationValue | undefined {
  if (!value) return
  if (value.kind === 'module') return value.members?.get(name) ?? unknownValue
  if (value.kind === 'unknown') return value
  if (value.kind === 'client') {
    if (name === '$qb') return builder
    if (name === '$qbRaw') return { kind: 'builder', direct: 'low-level', query: 'query-builder' }
    if (rawMethods.has(name)) return { kind: 'method', query: 'raw' }
    if (name === '$transaction') return { kind: 'method', result: client, transaction: true }
    if (['$setAuth', '$use', '$unuse'].includes(name)) return { kind: 'method', result: client }
    if (!name.startsWith('$')) return { kind: 'delegate' }
  }
  if (value.kind === 'delegate' && queryMethods.has(name))
    return { kind: 'method', query: 'query-api' }
  if (value.kind === 'builder') {
    if (name === 'schema') return { kind: 'schema', query: 'schema-change', direct: value.direct }
    if (name === 'transaction')
      return { kind: 'method', result: { ...value, transaction: true }, direct: value.direct }
    return {
      kind: 'method',
      result: { ...value, query: undefined },
      query: builderMethods.has(name) ? 'query-builder' : undefined,
      direct: value.direct,
      transaction: value.transaction,
    }
  }
  if (value.kind === 'schema') return { kind: 'method', result: value, direct: value.direct }
  if (value.kind === 'sql') return { kind: 'method', query: 'raw', result: { kind: 'sql' } }
  if (value.kind === 'driver') {
    if (driverMethods.has(name)) return { kind: 'method', query: 'raw', result: driver }
    if (['connect', 'promise', 'getConnection'].includes(name))
      return { kind: 'method', result: driver }
  }
}

export function applicationValue(
  node: Node | null | undefined,
  scope: ApplicationScope,
): ApplicationValue | undefined {
  if (!node) return
  if (node.type === 'Identifier') return scope.get(node.name)
  if (node.type === 'ArrayExpression') {
    const members = new Map<string, ApplicationValue>()
    for (const [index, element] of node.elements.entries()) {
      const value = applicationValue(element, scope)
      if (value) members.set(String(index), value)
    }
    if (members.size) return { kind: 'module', members }
  }
  if (node.type === 'MemberExpression') {
    const name = applicationMember(node)
    return name === undefined
      ? undefined
      : applicationProperty(applicationValue(node.object, scope), name)
  }
  if (node.type === 'NewExpression' || node.type === 'CallExpression') {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      !scope.has('require')
    ) {
      const source = node.arguments[0]
      if (source?.type === 'Literal' && typeof source.value === 'string')
        return knownApplicationModule(source.value) ?? unknownValue
      return unknownValue
    }
    const callee = applicationValue(node.callee, scope)
    if (callee?.kind === 'unknown') return unknownValue
    return callee?.result
  }
  if (node.type === 'AwaitExpression') return applicationValue(node.argument, scope)
  if (
    node.type === 'ChainExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion'
  )
    return applicationValue(node.expression, scope)
  if (node.type === 'TSTypeAnnotation') return applicationValue(node.typeAnnotation, scope)
  if (node.type === 'TSTypeReference') return applicationValue(node.typeName, scope)?.result
  if (node.type === 'TSQualifiedName')
    return applicationProperty(applicationValue(node.left, scope), node.right.name)
}

export function bindApplicationValue(
  pattern: Node,
  value: ApplicationValue | undefined,
  scope: ApplicationScope,
): void {
  if (pattern.type === 'Identifier') {
    const annotation = pattern.typeAnnotation
      ? applicationValue(pattern.typeAnnotation, scope)
      : undefined
    scope.set(pattern.name, value ?? annotation)
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') bindApplicationValue(property.argument, undefined, scope)
      else {
        const name =
          property.computed && property.key.type !== 'Literal'
            ? undefined
            : applicationName(property.key)
        bindApplicationValue(
          property.value,
          name === undefined ? undefined : applicationProperty(value, name),
          scope,
        )
      }
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const [index, element] of pattern.elements.entries())
      if (element) bindApplicationValue(element, applicationProperty(value, String(index)), scope)
  } else if (pattern.type === 'AssignmentPattern') bindApplicationValue(pattern.left, value, scope)
  else if (pattern.type === 'RestElement') bindApplicationValue(pattern.argument, undefined, scope)
}

export function unresolvedQueryMember(name: string): boolean {
  return (
    queryMethods.has(name) ||
    builderMethods.has(name) ||
    rawMethods.has(name) ||
    ['$qb', '$qbRaw', 'executeQuery'].includes(name)
  )
}
