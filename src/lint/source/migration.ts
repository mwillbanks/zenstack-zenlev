import {
  hashMigrationContent,
  readRegularMigrationFile,
  type HashSettings,
} from '../../migrate/files'
import type { LintInput, LintNode, LintGap, LintSource } from '../types'
import { readKyselyBuilder, staticString } from './kysely'
import { parseSqlLintInput } from './sql'
import { sourceAt } from './tokens'

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
  const ts = await import('typescript-ast')
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const parseDiagnostics = Reflect.get(
    tree,
    'parseDiagnostics',
  ) as readonly import('typescript-ast').Diagnostic[]
  if (parseDiagnostics.length)
    throw new SyntaxError(
      'Invalid migration TypeScript: ' +
        parseDiagnostics
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
          .join('\n'),
    )
  const inspected = new Set<string>()
  const nodes: LintNode[] = []
  const gaps: LintGap[] = []
  const sqlAliases = new Set<string>()
  const queries: { sql: string; source: LintSource; portable?: boolean; anchor?: boolean }[] = []
  const location = (node: import('typescript-ast').Node) =>
    sourceAt({ path, line: 1, column: 1, fingerprint }, text, node.getStart(tree), node.end)
  const literalQuery = (sql: string, node: import('typescript-ast').Node) => {
    const exact = node.getText(tree).slice(1, -1) === sql
    const source = exact
      ? sourceAt(
          { path, line: 1, column: 1, fingerprint },
          text,
          node.getStart(tree) + 1,
          node.end - 1,
        )
      : location(node)
    queries.push({ sql, source, anchor: !exact })
  }
  for (const statement of tree.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'kysely'
    ) {
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'sql')
            sqlAliases.add(element.name.text)
        }
    }
  }
  const gap = (node: import('typescript-ast').Node, message: string) =>
    gaps.push({ message, source: location(node) })
  const isSql = (node: import('typescript-ast').Expression) =>
    ts.isIdentifier(node) && sqlAliases.has(node.text)
  const builder = readKyselyBuilder(ts, dialect, isSql, gap, (sql, expression) => {
    queries.push({ sql, source: location(expression), portable: true, anchor: true })
  })
  const visit = (node: import('typescript-ast').Node) => {
    if (ts.isTaggedTemplateExpression(node) && isSql(node.tag)) {
      if (ts.isNoSubstitutionTemplateLiteral(node.template))
        literalQuery(node.template.text, node.template)
      else {
        let sql = node.template.head.text
        let dynamic = false
        for (const span of node.template.templateSpans) {
          const valuePosition = /(?:=|<>|!=|<=|>=|<|>|\bVALUES\s*\(|,|\bIN\s*\()\s*$/i.test(
            sql.trimEnd(),
          )
          let expression = span.expression
          while (ts.isParenthesizedExpression(expression)) expression = expression.expression
          let fragment: string | undefined
          if (
            ts.isTaggedTemplateExpression(expression) &&
            isSql(expression.tag) &&
            ts.isNoSubstitutionTemplateLiteral(expression.template)
          )
            fragment = expression.template.text
          else if (
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression) &&
            expression.expression.name.text === 'raw' &&
            isSql(expression.expression.expression)
          )
            fragment = staticString(ts, expression.arguments[0])
          if (fragment !== undefined) sql += fragment + span.literal.text
          else {
            if (
              !valuePosition ||
              ts.isCallExpression(expression) ||
              ts.isTaggedTemplateExpression(expression)
            )
              dynamic = true
            sql += 'NULL' + span.literal.text
          }
        }
        if (dynamic) gap(node, 'Dynamic SQL structure cannot be analyzed.')
        else queries.push({ sql, source: location(node), anchor: true })
      }
      return
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (method === 'raw' && isSql(node.expression.expression)) {
        const sql = staticString(ts, node.arguments[0])
        if (sql === undefined) gap(node, 'Dynamic SQL text cannot be analyzed.')
        else literalQuery(sql, node.arguments[0]!)
        return
      }
      if (
        method === 'execute' &&
        ts.isCallExpression(node.expression.expression) &&
        builder(node.expression.expression)
      )
        return
      if (method === 'execute') {
        const receiver = node.expression.expression
        const knownTag = ts.isTaggedTemplateExpression(receiver) && isSql(receiver.tag)
        const knownRaw =
          ts.isCallExpression(receiver) &&
          ts.isPropertyAccessExpression(receiver.expression) &&
          receiver.expression.name.text === 'raw' &&
          isSql(receiver.expression.expression)
        if (!knownTag && !knownRaw)
          gap(node, 'Executed query is outside supported static analysis.')
      }
    }
    if (
      ts.isCallExpression(node) &&
      !(
        ts.isPropertyAccessExpression(node.expression) &&
        ['execute', 'raw'].includes(node.expression.name.text)
      )
    )
      gap(node, 'Migration call may contain database effects outside static analysis.')
    ts.forEachChild(node, visit)
  }
  const inspectInitialization = (node: import('typescript-ast').Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      gap(node, 'Top-level migration initialization may execute before lint enforcement.')
      return
    }
    ts.forEachChild(node, inspectInitialization)
  }
  for (const statement of tree.statements) {
    if (
      !ts.isFunctionDeclaration(statement) &&
      !ts.isVariableStatement(statement) &&
      !ts.isImportDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isEmptyStatement(statement) &&
      !ts.isExportDeclaration(statement)
    )
      gap(statement, 'Top-level migration code may execute before lint enforcement.')
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      directions.includes(statement.name.text as 'up' | 'down') &&
      statement.body
    ) {
      inspected.add(statement.name.text)
      visit(statement.body)
    }
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          directions.includes(declaration.name.text as 'up' | 'down') &&
          declaration.initializer
        ) {
          if (
            ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer)
          ) {
            inspected.add(declaration.name.text)
            visit(declaration.initializer)
          } else
            gap(declaration.initializer, 'Migration handler implementation cannot be inspected.')
        } else if (declaration.initializer) inspectInitialization(declaration.initializer)
      }
  }
  for (const statement of tree.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const exported of statement.exportClause.elements) {
        if (
          directions.includes(exported.name.text as 'up' | 'down') &&
          !inspected.has(exported.name.text)
        )
          gap(exported, 'Re-exported migration handler cannot be inspected: ' + exported.name.text)
      }
    } else if (
      statement.moduleSpecifier &&
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
