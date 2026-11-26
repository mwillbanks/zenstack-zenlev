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
    | 'absent'
    | 'other'
  readonly result?: ApplicationValue | undefined
  readonly members?: ReadonlyMap<string, ApplicationValue> | undefined
  readonly complete?: boolean | undefined
  readonly iterable?: boolean | undefined
  readonly database?: boolean | undefined
  readonly query?: 'query-builder' | 'query-api' | 'raw' | 'schema-change' | undefined
  readonly direct?: 'kysely' | 'low-level' | undefined
  readonly transaction?: boolean | undefined
}

export type ApplicationScope = Map<string, ApplicationValue | undefined>

export const unknownValue: ApplicationValue = { kind: 'unknown' }
const absentValue: ApplicationValue = { kind: 'absent' }
const otherValue: ApplicationValue = { kind: 'other' }

export interface ApplicationBindingObserver {
  expression(node: Node, uncertain?: boolean): void
  property(node: Node, value: ApplicationValue | undefined, name: string | undefined): void
}
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

export function applicationDatabaseValue(value: ApplicationValue | undefined): boolean {
  const pending = value ? [value] : []
  const seen = new Set<ApplicationValue>()
  for (const current of pending) {
    if (seen.has(current)) continue
    seen.add(current)
    if (
      current.database ||
      ['client', 'builder', 'delegate', 'schema', 'sql', 'driver'].includes(current.kind)
    )
      return true
    if (current.result) pending.push(current.result)
    if (current.members) pending.push(...current.members.values())
  }
  return false
}

export function uncertainApplicationValue(
  ...values: readonly (ApplicationValue | undefined)[]
): ApplicationValue {
  return values.some(applicationDatabaseValue) ? { kind: 'unknown', database: true } : unknownValue
}

export function applicationIterationValue(
  value: ApplicationValue | undefined,
  keys: boolean,
): ApplicationValue | undefined {
  if (keys) return otherValue
  if (!value) return
  if (value?.iterable && value.complete) {
    const elements = [...(value.members?.values() ?? [])]
    const first = elements[0]
    if (first && elements.every((element) => element === first)) return first
    if (
      elements.length &&
      elements.every((element) => element.kind !== 'unknown' && !applicationDatabaseValue(element))
    )
      return otherValue
    return uncertainApplicationValue(...elements)
  }
  return uncertainApplicationValue(value)
}

export function applicationProperty(
  value: ApplicationValue | undefined,
  name: string,
): ApplicationValue | undefined {
  if (!value) return
  if (value.kind === 'module')
    return value.members?.get(name) ?? (value.complete ? absentValue : unknownValue)
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
  if (node.type === 'Identifier')
    return node.name === 'undefined' && !scope.has(node.name) ? absentValue : scope.get(node.name)
  if (node.type === 'Literal') return otherValue
  if (node.type === 'UnaryExpression' && node.operator === 'void') return absentValue
  if (node.type === 'ArrayExpression') {
    if (node.elements.some((element) => element?.type === 'SpreadElement'))
      return uncertainApplicationValue(
        ...node.elements.map((element) =>
          applicationValue(element?.type === 'SpreadElement' ? element.argument : element, scope),
        ),
      )
    const members = new Map<string, ApplicationValue>()
    for (const [index, element] of node.elements.entries())
      members.set(
        String(index),
        element ? (applicationValue(element, scope) ?? unknownValue) : absentValue,
      )
    return { kind: 'module', members, complete: true, iterable: true }
  }
  if (node.type === 'ObjectExpression') {
    const members = new Map<string, ApplicationValue>()
    let complete = true
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        const spread = applicationValue(property.argument, scope)
        if (
          spread?.kind === 'absent' ||
          (property.argument.type === 'Literal' && typeof property.argument.value !== 'string')
        )
          continue
        if (spread?.kind !== 'module' || !spread.complete) {
          complete = false
          for (const [name, value] of members)
            members.set(name, uncertainApplicationValue(value, spread))
        }
        for (const [name, value] of spread?.members ?? []) members.set(name, value)
        continue
      }
      const name =
        property.computed && property.key.type !== 'Literal'
          ? undefined
          : applicationName(property.key)
      if (name === undefined) {
        complete = false
        for (const [name, value] of members) members.set(name, uncertainApplicationValue(value))
      } else members.set(name, applicationValue(property.value, scope) ?? unknownValue)
    }
    return { kind: 'module', members, complete }
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
  observer?: ApplicationBindingObserver,
): void {
  if (pattern.type === 'Identifier') {
    const annotation = pattern.typeAnnotation
      ? applicationValue(pattern.typeAnnotation, scope)
      : undefined
    scope.set(pattern.name, value ?? annotation)
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type === 'RestElement')
        bindApplicationValue(property.argument, undefined, scope, observer)
      else {
        const name =
          property.computed && property.key.type !== 'Literal'
            ? undefined
            : applicationName(property.key)
        if (property.computed) observer?.expression(property.key)
        const member = name === undefined ? undefined : applicationProperty(value, name)
        observer?.property(property, value, name)
        bindApplicationValue(property.value, member, scope, observer)
      }
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const [index, element] of pattern.elements.entries())
      if (element)
        bindApplicationValue(element, applicationProperty(value, String(index)), scope, observer)
  } else if (pattern.type === 'AssignmentPattern') {
    let assigned = value
    if (value?.kind === 'absent') {
      observer?.expression(pattern.right)
      assigned = applicationValue(pattern.right, scope) ?? unknownValue
    } else if (!value || value.kind === 'unknown') {
      observer?.expression(pattern.right, true)
      assigned = uncertainApplicationValue(value, applicationValue(pattern.right, scope))
    }
    bindApplicationValue(pattern.left, assigned, scope, observer)
  } else if (pattern.type === 'RestElement')
    bindApplicationValue(pattern.argument, undefined, scope, observer)
}

export function unresolvedQueryMember(name: string): boolean {
  return (
    queryMethods.has(name) ||
    builderMethods.has(name) ||
    rawMethods.has(name) ||
    ['$qb', '$qbRaw', 'executeQuery'].includes(name)
  )
}
