import type { Node } from 'oxc-parser'
import {
  hashMigrationContent,
  readRegularMigrationFile,
  type HashSettings,
} from '../../migrate/files'
import type { LintInput, LintNode, LintGap, LintSource } from '../types'
import { memberName, readKyselyBuilder, staticString } from './kysely'
import { parseSqlLintInput } from './sql'
import { sourceAt } from './tokens'

const inertStatements = new Set([
  'ImportDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'EmptyStatement',
  'ExportAllDeclaration',
])

function nameOf(node: Node): string | undefined {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
}

function parameterDecorators(node: Node): readonly Node[] {
  if ('decorators' in node && Array.isArray(node.decorators)) return node.decorators
  return []
}

export async function readMigrationLintInputs(
  path: string,
  dialect: string | undefined,
  directions: readonly ('up' | 'down')[],
  expected?: { hash: string; hashing?: HashSettings },
): Promise<LintInput> {
  const bytes = await readRegularMigrationFile(path)
  const fingerprint = hashMigrationContent(bytes, {
    algorithm: 'sha256',
    normalizeLineEndings: false,
  })
  if (expected && hashMigrationContent(bytes, expected.hashing) !== expected.hash)
    throw new Error('Migration hash changed before lint: ' + path)
  const text = bytes.toString('utf8')
  const { parseSync, visitorKeys } = await import('oxc-parser')
  const { program, errors } = parseSync(path, text, {
    lang: 'ts',
    sourceType: 'module',
    preserveParens: false,
  })
  if (errors.length)
    throw new SyntaxError(
      'Invalid migration TypeScript: ' + errors.map((error) => error.message).join('\n'),
    )

  const inspected = new Set<string>()
  const nodes: LintNode[] = []
  const gaps: LintGap[] = []
  const sqlAliases = new Set<string>()
  const queries: { sql: string; source: LintSource; portable?: boolean; anchor?: boolean }[] = []
  const location = (node: Node) =>
    sourceAt({ path, line: 1, column: 1, fingerprint }, text, node.start, node.end)
  const literalQuery = (sql: string, node: Node) => {
    const exact = text.slice(node.start + 1, node.end - 1) === sql
    const source = exact
      ? sourceAt({ path, line: 1, column: 1, fingerprint }, text, node.start + 1, node.end - 1)
      : location(node)
    queries.push({ sql, source, anchor: !exact })
  }
  const children = (node: Node, callback: (child: Node) => void) => {
    const fields = node as unknown as Record<string, Node | Node[] | null>
    for (const key of visitorKeys[node.type] ?? []) {
      const child = fields[key]
      if (Array.isArray(child)) {
        for (const element of child) if (element) callback(element)
      } else if (child) callback(child)
    }
  }
  for (const statement of program.body) {
    if (
      statement.type === 'ImportDeclaration' &&
      statement.importKind !== 'type' &&
      statement.source.value === 'kysely'
    ) {
      for (const binding of statement.specifiers)
        if (
          binding.type === 'ImportSpecifier' &&
          binding.importKind !== 'type' &&
          nameOf(binding.imported) === 'sql'
        )
          sqlAliases.add(binding.local.name)
    }
  }
  const gap = (node: Node, message: string) => gaps.push({ message, source: location(node) })
  const inspectDynamicImports = (node: Node): void => {
    if (node.type === 'ImportExpression')
      gap(node, 'Dynamically imported migration module cannot be inspected.')
    else children(node, inspectDynamicImports)
  }
  const isSql = (node: Node) => node.type === 'Identifier' && sqlAliases.has(node.name)
  const isRawSql = (node: Node) =>
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    memberName(node.callee) === 'raw' &&
    isSql(node.callee.object)
  const builder = readKyselyBuilder(dialect, isSql, gap, (sql, expression) => {
    queries.push({ sql, source: location(expression), portable: true, anchor: true })
  })
  const visit = (node: Node) => {
    if (node.type === 'TaggedTemplateExpression' && isSql(node.tag)) {
      const literal = staticString(node.quasi)
      if (literal !== undefined) literalQuery(literal, node.quasi)
      else {
        let sql = node.quasi.quasis[0]?.value.cooked ?? ''
        let dynamic = node.quasi.quasis.some(({ value }) => value.cooked == null)
        for (const [index, expression] of node.quasi.expressions.entries()) {
          inspectDynamicImports(expression)
          const valuePosition = /(?:=|<>|!=|<=|>=|<|>|\bVALUES\s*\(|,|\bIN\s*\()\s*$/i.test(
            sql.trimEnd(),
          )
          const fragment =
            expression.type === 'TaggedTemplateExpression' && isSql(expression.tag)
              ? staticString(expression.quasi)
              : expression.type === 'CallExpression' && isRawSql(expression)
                ? staticString(expression.arguments[0])
                : undefined
          if (
            fragment === undefined &&
            (!valuePosition ||
              expression.type === 'CallExpression' ||
              expression.type === 'TaggedTemplateExpression')
          )
            dynamic = true
          sql += (fragment ?? 'NULL') + (node.quasi.quasis[index + 1]?.value.cooked ?? '')
        }
        if (dynamic) gap(node, 'Dynamic SQL structure cannot be analyzed.')
        else queries.push({ sql, source: location(node), anchor: true })
      }
      return
    }
    if (node.type === 'ImportExpression') {
      inspectDynamicImports(node)
      return
    }
    if (node.type === 'CallExpression') {
      if (isRawSql(node)) {
        const argument = node.arguments[0]
        const sql = staticString(argument)
        if (sql === undefined) gap(node, 'Dynamic SQL text cannot be analyzed.')
        else literalQuery(sql, argument!)
        return
      }
      if (node.callee.type === 'MemberExpression' && memberName(node.callee) === 'execute') {
        const receiver = node.callee.object
        if (receiver.type === 'CallExpression' && builder(receiver)) return
        const knownTag = receiver.type === 'TaggedTemplateExpression' && isSql(receiver.tag)
        if (!knownTag && !isRawSql(receiver))
          gap(node, 'Executed query is outside supported static analysis.')
      } else if (memberName(node.callee) !== 'raw') {
        gap(node, 'Migration call may contain database effects outside static analysis.')
      }
    }
    children(node, visit)
  }
  const inspectInitialization = (node: Node): void => {
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') return
    if (
      node.type === 'MethodDefinition' ||
      node.type === 'PropertyDefinition' ||
      node.type === 'AccessorProperty'
    ) {
      if (node.computed) inspectInitialization(node.key)
      for (const decorator of node.decorators) inspectInitialization(decorator)
      if (node.type === 'MethodDefinition') {
        for (const parameter of node.value.params)
          for (const decorator of parameterDecorators(parameter)) inspectInitialization(decorator)
      } else if (node.static && node.value) inspectInitialization(node.value)
      return
    }
    if (
      node.type === 'Decorator' ||
      node.type === 'ImportExpression' ||
      node.type === 'CallExpression' ||
      node.type === 'NewExpression' ||
      node.type === 'TaggedTemplateExpression' ||
      node.type === 'AwaitExpression'
    ) {
      gap(node, 'Top-level migration initialization may execute before lint enforcement.')
      return
    }
    children(node, inspectInitialization)
  }
  const isDirection = (name: string | undefined) =>
    directions.some((direction) => direction === name)
  for (const outer of program.body) {
    const statement = outer.type === 'ExportNamedDeclaration' ? outer.declaration : outer
    if (!statement) continue
    if (statement.type === 'FunctionDeclaration') {
      const name = statement.id?.name
      if (name && isDirection(name) && statement.body) {
        inspected.add(name)
        for (const parameter of statement.params) visit(parameter)
        visit(statement.body)
      }
    } else if (statement.type === 'VariableDeclaration') {
      for (const { id, init } of statement.declarations) {
        if (!init) continue
        if (id.type === 'Identifier' && isDirection(id.name)) {
          if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
            inspected.add(id.name)
            visit(init)
          } else gap(init, 'Migration handler implementation cannot be inspected.')
        } else inspectInitialization(init)
      }
    } else if (!inertStatements.has(statement.type))
      gap(statement, 'Top-level migration code may execute before lint enforcement.')
  }
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type') {
      for (const specifier of statement.specifiers) {
        const name = nameOf(specifier.exported)
        if (name && specifier.exportKind !== 'type' && isDirection(name) && !inspected.has(name))
          gap(specifier, 'Re-exported migration handler cannot be inspected: ' + name)
      }
    } else if (
      statement.type === 'ExportAllDeclaration' &&
      statement.exportKind !== 'type' &&
      directions.some((direction) => !inspected.has(direction))
    )
      gap(statement, 'Re-exported migration handlers require manual review.')
  }
  for (const query of queries) {
    const input = await parseSqlLintInput(
      query.sql,
      dialect ?? (query.portable ? 'postgresql' : undefined),
      query.source,
    )
    nodes.push(
      ...input.nodes.map((node) => ({
        ...node,
        ...(dialect ? {} : { dialect: undefined }),
        ...(query.anchor ? { source: query.source } : {}),
        origin: 'migration' as const,
      })),
    )
    gaps.push(...input.gaps.map((gap) => (query.anchor ? { ...gap, source: query.source } : gap)))
  }
  return { nodes, gaps, capabilities: ['migration-source'] }
}
