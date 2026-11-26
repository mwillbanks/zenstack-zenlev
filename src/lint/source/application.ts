import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { parseSync, visitorKeys, type Node, type Program } from 'oxc-parser'
import type { LintGap, LintInput, LintNode, LintSource } from '../types'
import { sourceAt } from './tokens'
import {
  applicationMember,
  applicationName,
  applicationProperty,
  applicationValue,
  bindApplicationValue,
  knownApplicationModule,
  unknownValue,
  unresolvedQueryMember,
  type ApplicationScope,
  type ApplicationValue,
} from './application-values'

function children(node: Node): Node[] {
  const fields = node as unknown as Record<string, Node | Node[] | null>
  const result: Node[] = []
  for (const key of visitorKeys[node.type] ?? []) {
    const child = fields[key]
    if (Array.isArray(child)) result.push(...child.filter((value): value is Node => value != null))
    else if (child) result.push(child)
  }
  return result
}

function declarations(statement: Node): readonly Node[] {
  if (statement.type === 'ExportNamedDeclaration')
    return statement.declaration ? declarations(statement.declaration) : []
  if (statement.type === 'VariableDeclaration') return statement.declarations.map(({ id }) => id)
  if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
    return statement.id ? [statement.id] : []
  return []
}

function predeclare(body: readonly Node[], scope: ApplicationScope): void {
  for (const statement of body)
    for (const id of declarations(statement)) bindApplicationValue(id, undefined, scope)
}

function mergeAssignments(
  scope: ApplicationScope,
  evaluated: ApplicationScope,
  uncertain: boolean,
  shadowed?: ApplicationScope,
): void {
  for (const [name, previous] of scope) {
    const value = evaluated.get(name)
    if (!shadowed?.has(name) && value !== previous)
      scope.set(name, uncertain ? unknownValue : value)
  }
}

interface ParsedApplicationModule {
  readonly program: Program
  readonly text: string
  readonly fingerprint: string
  readonly errors: readonly { readonly message: string }[]
}

interface ApplicationModule extends ParsedApplicationModule {
  readonly path: string
  readonly imports: ReadonlyMap<string, ApplicationValue>
}

type ApplicationLintReader = (
  path: string,
  dialect: string | undefined,
  mode: 'zenstack' | 'standalone',
) => Promise<LintInput>

type ParsedModules = Map<string, Promise<ParsedApplicationModule>>

async function readParsedModule(
  path: string,
  cache: ParsedModules,
): Promise<ParsedApplicationModule> {
  let pending = cache.get(path)
  if (!pending) {
    pending = (async () => {
      const text = await Bun.file(path).text()
      const { program, errors } = parseSync(path, text, {
        sourceType: 'module',
        preserveParens: false,
      })
      return { text, program, errors, fingerprint: createHash('sha256').update(text).digest('hex') }
    })()
    if (cache.size >= 64) cache.delete(cache.keys().next().value!)
    cache.set(path, pending)
  }
  return pending
}

/** Share bounded parsed source snapshots within one lint invocation. */
export function createApplicationLintReader(): ApplicationLintReader {
  const parsed: ParsedModules = new Map()
  return (path, dialect, mode) => readApplication(path, dialect, mode, parsed)
}

async function readApplication(
  path: string,
  dialect: string | undefined,
  mode: 'zenstack' | 'standalone',
  parsed: ParsedModules,
): Promise<LintInput> {
  const modules = new Map<string, ApplicationValue>()
  const input: { nodes: LintNode[]; gaps: LintGap[] } = { nodes: [], gaps: [] }

  async function readModule(
    filePath: string,
    parents: ReadonlySet<string>,
    primary: boolean,
  ): Promise<ApplicationModule | undefined> {
    let source: ParsedApplicationModule
    try {
      source = await readParsedModule(filePath, parsed)
    } catch (error) {
      if (primary) throw error
      return
    }
    const { program, errors } = source
    if (errors.length) {
      if (!primary) return
      throw new SyntaxError(
        'Invalid application source: ' + errors.map((error) => error.message).join('\n'),
      )
    }
    const imports = new Map<string, ApplicationValue>()
    for (const statement of program.body) {
      if (
        statement.type !== 'ImportDeclaration' &&
        statement.type !== 'ExportAllDeclaration' &&
        statement.type !== 'ExportNamedDeclaration'
      )
        continue
      if (!statement.source) continue
      const specifier = statement.source.value
      let module = knownApplicationModule(specifier)
      if (!module && specifier.startsWith('.')) {
        let target: string | undefined
        try {
          target = Bun.resolveSync(specifier, dirname(filePath))
        } catch {
          /* Unresolved provenance is reported at query use. */
        }
        if (target && !parents.has(target) && parents.size < 12 && modules.size < 64) {
          module = modules.get(target)
          if (!module) {
            modules.set(target, unknownValue)
            const dependency = await readModule(target, new Set([...parents, target]), false)
            module = dependency ? inspect(dependency, false) : unknownValue
            modules.set(target, module)
          }
        }
      }
      imports.set(specifier, module ?? unknownValue)
    }
    return { ...source, path: filePath, imports }
  }

  function inspect(module: ApplicationModule, primary: boolean): ApplicationValue {
    const scope: ApplicationScope = new Map()
    const exports = new Map<string, ApplicationValue>()
    const fingerprint = module.fingerprint
    const base: LintSource = { path: module.path, line: 1, column: 1, fingerprint }
    const location = (node: Node) => sourceAt(base, module.text, node.start, node.end)
    const seen = new Set<string>()
    function emit(node: Node, type: string, name: string, command?: string): void {
      if (!primary) return
      const end = type === 'direct-kysely' && command === 'low-level' ? '' : node.end
      const key = node.start + ':' + end + ':' + type
      if (seen.has(key)) return
      seen.add(key)
      input.nodes.push({
        kind: 'application-query',
        name,
        type,
        command,
        dialect,
        origin: 'application',
        action: 'call',
        source: location(node),
        identity: name,
      })
    }
    function gap(node: Node, message: string): void {
      if (primary) input.gaps.push({ message, source: location(node) })
    }
    function effects(node: Node, value: ApplicationValue | undefined, name: string): void {
      if (value?.query) emit(node, value.query, name)
      if (
        value?.direct &&
        (value.direct === 'low-level' ||
          value.query === 'query-builder' ||
          node.type === 'NewExpression')
      )
        emit(node, 'direct-kysely', name, value.direct === 'low-level' ? 'low-level' : mode)
    }
    function destructureEffects(pattern: Node, value: ApplicationValue | undefined): void {
      if (!value) return
      if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) {
          if (property.type !== 'Property') continue
          const name =
            property.computed && property.key.type !== 'Literal'
              ? undefined
              : applicationName(property.key)
          if (name === undefined)
            gap(property, 'Dynamic database member access requires manual review.')
          else {
            const member = applicationProperty(value, name)
            effects(property, member, name)
            destructureEffects(property.value, member)
          }
        }
      } else if (pattern.type === 'ArrayPattern') {
        for (const [index, element] of pattern.elements.entries())
          if (element) destructureEffects(element, applicationProperty(value, String(index)))
      } else if (pattern.type === 'AssignmentPattern') destructureEffects(pattern.left, value)
    }
    function visitFunction(
      node: Node,
      parent: ApplicationScope,
      transaction?: ApplicationValue,
    ): void {
      if (
        node.type !== 'ArrowFunctionExpression' &&
        node.type !== 'FunctionExpression' &&
        node.type !== 'FunctionDeclaration'
      )
        return
      const local = new Map(parent)
      if ('id' in node && node.id) local.set(node.id.name, undefined)
      for (const parameter of node.params) bindApplicationValue(parameter, undefined, local)
      if (transaction && node.params[0]) bindApplicationValue(node.params[0], transaction, local)
      if (node.body) visit(node.body, local)
    }
    function visit(node: Node, local: ApplicationScope): void {
      if (
        node.type.startsWith('TS') &&
        ![
          'TSAsExpression',
          'TSSatisfiesExpression',
          'TSNonNullExpression',
          'TSTypeAssertion',
        ].includes(node.type)
      )
        return
      if (node.type === 'ImportDeclaration') return
      if (
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression' ||
        node.type === 'FunctionDeclaration'
      ) {
        visitFunction(node, local)
        return
      }
      if (node.type === 'BlockStatement') {
        const block = new Map(local)
        const shadowed: ApplicationScope = new Map()
        predeclare(node.body, block)
        predeclare(node.body, shadowed)
        for (const statement of node.body) visit(statement, block)
        mergeAssignments(local, block, false, shadowed)
        return
      }
      if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
        visit(node.test, local)
        const consequent = new Map(local)
        const alternate = new Map(local)
        visit(node.consequent, consequent)
        if (node.alternate) visit(node.alternate, alternate)
        mergeAssignments(local, consequent, true)
        mergeAssignments(local, alternate, true)
        return
      }
      if (node.type === 'TryStatement') {
        for (const child of children(node)) {
          const branch = new Map(local)
          visit(child, branch)
          mergeAssignments(local, branch, true)
        }
        return
      }
      if (node.type === 'CatchClause') {
        const caught = new Map(local)
        if (node.param) bindApplicationValue(node.param, undefined, caught)
        visit(node.body, caught)
        const shadowed: ApplicationScope = new Map()
        if (node.param) bindApplicationValue(node.param, undefined, shadowed)
        mergeAssignments(local, caught, true, shadowed)
        return
      }
      if (
        node.type === 'ForStatement' ||
        node.type === 'ForInStatement' ||
        node.type === 'ForOfStatement' ||
        node.type === 'WhileStatement' ||
        node.type === 'DoWhileStatement'
      ) {
        const loop = new Map(local)
        const shadowed: ApplicationScope = new Map()
        const declaration =
          node.type === 'ForStatement'
            ? node.init
            : node.type === 'ForInStatement' || node.type === 'ForOfStatement'
              ? node.left
              : undefined
        if (declaration?.type === 'VariableDeclaration') {
          predeclare([declaration], loop)
          predeclare([declaration], shadowed)
        }
        for (const child of children(node)) visit(child, loop)
        mergeAssignments(local, loop, true, shadowed)
        return
      }
      if (node.type === 'VariableDeclarator') {
        if (node.init) visit(node.init, local)
        const value = applicationValue(node.init, local)
        if (node.init?.type === 'Identifier' && value?.direct === 'low-level')
          effects(node.init, value, node.init.name)
        bindApplicationValue(node.id, value, local)
        destructureEffects(node.id, value)
        return
      }
      if (node.type === 'AssignmentExpression') {
        visit(node.right, local)
        const value = applicationValue(node.right, local)
        if (node.right.type === 'Identifier' && value?.direct === 'low-level')
          effects(node.right, value, node.right.name)
        const previous = applicationValue(node.left, local)
        destructureEffects(node.left, value)
        bindApplicationValue(node.left, value ?? (previous ? unknownValue : undefined), local)
        return
      }
      if (node.type === 'MemberExpression') {
        visit(node.object, local)
        const object = applicationValue(node.object, local)
        const name = applicationMember(node)
        if (name) {
          effects(node, applicationProperty(object, name), name)
          if (object?.kind === 'unknown' && unresolvedQueryMember(name))
            gap(
              node,
              'Query client provenance cannot be resolved statically; review this application query.',
            )
        } else if (object && object.kind !== 'unknown')
          gap(node, 'Dynamic database member access requires manual review.')
        if (node.computed) visit(node.property, local)
        return
      }
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        visit(node.callee, local)
        const callee = applicationValue(node.callee, local)
        if (
          node.type === 'CallExpression' &&
          node.callee.type === 'MemberExpression' &&
          applicationMember(node.callee) === 'executeQuery' &&
          applicationValue(node.callee.object, local)?.kind === 'builder'
        ) {
          const argument = node.arguments[0]
          const value = applicationValue(argument, local)
          if (argument?.type === 'ObjectExpression') emit(node, 'raw', 'executeQuery')
          else if (value?.kind !== 'builder' && value?.kind !== 'sql')
            gap(node, 'Compiled query provenance requires manual review.')
        }
        if (node.type === 'NewExpression')
          effects(node, callee?.result, applicationName(node.callee) ?? 'constructor')
        if (node.callee.type !== 'MemberExpression' && callee?.query)
          effects(node, callee, applicationName(node.callee) ?? 'query')
        for (const argument of node.arguments) {
          if (
            callee?.transaction &&
            (argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression')
          )
            visitFunction(argument, local, callee.result)
          else {
            const argumentValue = applicationValue(argument, local)
            if (
              (!callee || callee.kind === 'unknown') &&
              argumentValue &&
              ['client', 'builder', 'delegate', 'driver', 'sql', 'schema'].includes(
                argumentValue.kind,
              )
            )
              gap(argument, 'Database value passed to an unresolved helper requires manual review.')
            visit(argument, local)
          }
        }
        return
      }
      if (node.type === 'TaggedTemplateExpression') {
        visit(node.tag, local)
        const tag = applicationValue(node.tag, local)
        if (tag?.kind === 'sql') emit(node, 'raw', 'sql')
        for (const expression of node.quasi.expressions) visit(expression, local)
        return
      }
      if (node.type === 'ImportExpression')
        gap(node, 'Dynamic application imports require manual review of query provenance.')
      for (const child of children(node)) visit(child, local)
    }
    predeclare(module.program.body, scope)
    for (const statement of module.program.body) {
      if (statement.type !== 'ImportDeclaration') continue
      const imported = module.imports.get(statement.source.value)
      for (const binding of statement.specifiers) {
        const name =
          binding.type === 'ImportNamespaceSpecifier'
            ? undefined
            : binding.type === 'ImportDefaultSpecifier'
              ? 'default'
              : applicationName(binding.imported)
        const value = name === undefined ? imported : applicationProperty(imported, name)
        scope.set(binding.local.name, value)
      }
    }
    for (const statement of module.program.body) visit(statement, scope)
    for (const statement of module.program.body) {
      if (statement.type === 'ExportDefaultDeclaration') {
        exports.set('default', applicationValue(statement.declaration, scope) ?? unknownValue)
      } else if (statement.type === 'ExportAllDeclaration') {
        const imported = module.imports.get(statement.source.value)
        for (const [name, value] of imported?.members ?? [])
          if (name !== 'default') exports.set(name, value)
      } else if (statement.type === 'ExportNamedDeclaration') {
        for (const declaration of declarations(statement))
          if (declaration.type === 'Identifier')
            exports.set(declaration.name, scope.get(declaration.name) ?? unknownValue)
        const imported = statement.source && module.imports.get(statement.source.value)
        for (const binding of statement.specifiers) {
          const name = applicationName(binding.exported)
          const localName = applicationName(binding.local)
          if (name && localName)
            exports.set(
              name,
              (imported ? applicationProperty(imported, localName) : scope.get(localName)) ??
                unknownValue,
            )
        }
      }
    }
    return { kind: 'module', members: exports }
  }

  const absolutePath = resolve(path)
  const module = await readModule(absolutePath, new Set([absolutePath]), true)
  if (module) inspect(module, true)
  return { ...input, capabilities: ['application-source'] }
}
