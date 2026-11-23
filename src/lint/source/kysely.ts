import type { CallExpression, Expression, Node } from 'typescript-ast'

export const staticString = (
  ts: typeof import('typescript-ast'),
  node: import('typescript-ast').Node | undefined,
): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined

export function readKyselyBuilder(
  ts: typeof import('typescript-ast'),
  dialect: string | undefined,
  isSql: (node: Expression) => boolean,
  gap: (node: Node, message: string) => void,
  addQuery: (sql: string, expression: CallExpression) => void,
) {
  return (expression: import('typescript-ast').CallExpression): boolean => {
    type Call = import('typescript-ast').CallExpression
    const chainOf = (expression: import('typescript-ast').Expression) => {
      const calls: Call[] = []
      let root = expression
      while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression)) {
        calls.unshift(root)
        root = root.expression.expression
      }
      return { calls, root }
    }
    const { calls: chain, root } = chainOf(expression)
    const methodOf = (call: Call) =>
      (call.expression as import('typescript-ast').PropertyAccessExpression).name.text
    let schema: string | undefined
    if (chain[0] && methodOf(chain[0]) === 'withSchema') {
      schema = staticString(ts, chain[0].arguments[0])
      if (!schema) {
        gap(chain[0], 'Dynamic Kysely schema cannot be analyzed.')
        return true
      }
      chain.shift()
    }
    const first = chain[0]
    if (!first || !ts.isPropertyAccessExpression(first.expression)) return false
    const method = methodOf(first)
    if (!['createTable', 'dropTable', 'createIndex', 'dropIndex'].includes(method)) return false
    if (!ts.isPropertyAccessExpression(root) || root.name.text !== 'schema') return false
    const objectName = staticString(ts, first.arguments[0])
    if (!objectName) {
      gap(first, 'Dynamic Kysely object identity cannot be analyzed.')
      return true
    }
    const quote = (name: string) =>
      dialect === 'mysql'
        ? String.fromCharCode(96) +
          name.replaceAll(String.fromCharCode(96), String.fromCharCode(96, 96)) +
          String.fromCharCode(96)
        : '"' + name.replaceAll('"', '""') + '"'
    const qualified = (name: string) =>
      (schema && !name.includes('.') ? [schema, name] : name.split('.')).map(quote).join('.')
    const strings = (array: import('typescript-ast').Node | undefined) =>
      array &&
      ts.isArrayLiteralExpression(array) &&
      array.elements.every((element) => staticString(ts, element) !== undefined)
        ? array.elements.map((element) => staticString(ts, element)!)
        : undefined
    const sqlValue = (
      value: import('typescript-ast').Expression | undefined,
    ): string | undefined => {
      if (!value) return
      if (ts.isStringLiteral(value)) return "'" + value.text.replaceAll("'", "''") + "'"
      if (ts.isNumericLiteral(value)) return value.text
      if (value.kind === ts.SyntaxKind.TrueKeyword) return 'TRUE'
      if (value.kind === ts.SyntaxKind.FalseKeyword) return 'FALSE'
      if (value.kind === ts.SyntaxKind.NullKeyword) return 'NULL'
      if (
        ts.isTaggedTemplateExpression(value) &&
        isSql(value.tag) &&
        ts.isNoSubstitutionTemplateLiteral(value.template)
      )
        return value.template.text
      if (
        ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        value.expression.name.text === 'raw' &&
        isSql(value.expression.expression)
      )
        return staticString(ts, value.arguments[0])
    }
    const modifiers = (callback: import('typescript-ast').Expression | undefined): Call[] => {
      if (!callback) return []
      if (
        (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
        ts.isBlock(callback.body)
      ) {
        gap(callback, 'Kysely modifier callback requires manual review.')
        return []
      }
      return chainOf(callback.body).calls
    }
    let query =
      method === 'dropTable'
        ? 'DROP TABLE ' + qualified(objectName)
        : method === 'dropIndex'
          ? 'DROP INDEX ' + qualified(objectName)
          : ''
    if (method === 'createTable') {
      const definitions: string[] = []
      for (const call of chain.slice(1)) {
        const name = methodOf(call)
        if (['ifNotExists', 'temporary'].includes(name)) continue
        if (name === 'addColumn') {
          const column = staticString(ts, call.arguments[0])
          const type = staticString(ts, call.arguments[1])
          if (!column || !type) {
            gap(call, 'Dynamic Kysely column definition cannot be analyzed.')
            continue
          }
          let definition =
            quote(column) + ' ' + (dialect === 'mysql' && type === 'integer' ? 'int' : type)
          for (const modifier of modifiers(call.arguments[2])) {
            const name = methodOf(modifier)
            if (name === 'primaryKey') definition += ' PRIMARY KEY'
            else if (name === 'notNull') definition += ' NOT NULL'
            else if (name === 'unique') definition += ' UNIQUE'
            else if (name === 'autoIncrement') {
              if (dialect === 'sqlite')
                definition = definition.replace(/\bPRIMARY KEY\b/, 'PRIMARY KEY AUTOINCREMENT')
              else
                definition +=
                  dialect === 'mysql' ? ' AUTO_INCREMENT' : ' GENERATED BY DEFAULT AS IDENTITY'
            } else if (name === 'defaultTo') {
              const value = sqlValue(modifier.arguments[0])
              if (value === undefined) gap(modifier, 'Dynamic Kysely default cannot be analyzed.')
              else definition += ' DEFAULT ' + value
            } else if (name === 'references') {
              const target = staticString(ts, modifier.arguments[0])?.split('.')
              if (!target || target.length < 2)
                gap(modifier, 'Dynamic Kysely reference cannot be analyzed.')
              else {
                const field = target.pop()!
                definition +=
                  ' REFERENCES ' + target.map(quote).join('.') + '(' + quote(field) + ')'
              }
            } else if (['onDelete', 'onUpdate'].includes(name)) {
              const action = staticString(ts, modifier.arguments[0])
              if (action)
                definition += (name === 'onDelete' ? ' ON DELETE ' : ' ON UPDATE ') + action
              else gap(modifier, 'Dynamic Kysely referential action cannot be analyzed.')
            } else gap(modifier, 'Kysely column modifier is outside static analysis: ' + name)
          }
          definitions.push(definition)
        } else if (
          ['addPrimaryKeyConstraint', 'addUniqueConstraint', 'addForeignKeyConstraint'].includes(
            name,
          )
        ) {
          const constraint = staticString(ts, call.arguments[0])
          const columns = strings(call.arguments[1])
          if (!constraint || !columns) {
            gap(call, 'Dynamic Kysely constraint cannot be analyzed.')
            continue
          }
          let definition =
            'CONSTRAINT ' +
            quote(constraint) +
            (name === 'addPrimaryKeyConstraint'
              ? ' PRIMARY KEY'
              : name === 'addUniqueConstraint'
                ? ' UNIQUE'
                : ' FOREIGN KEY') +
            ' (' +
            columns.map(quote).join(', ') +
            ')'
          if (name === 'addForeignKeyConstraint') {
            const target = staticString(ts, call.arguments[2])
            const targetColumns = strings(call.arguments[3])
            if (!target || !targetColumns) {
              gap(call, 'Dynamic Kysely foreign key target cannot be analyzed.')
              continue
            }
            definition +=
              ' REFERENCES ' + qualified(target) + '(' + targetColumns.map(quote).join(', ') + ')'
          }
          definitions.push(definition)
        } else if (name === 'addCheckConstraint') {
          const constraint = staticString(ts, call.arguments[0])
          const value = sqlValue(call.arguments[1])
          if (constraint && value !== undefined)
            definitions.push('CONSTRAINT ' + quote(constraint) + ' CHECK (' + value + ')')
          else gap(call, 'Dynamic Kysely check constraint cannot be analyzed.')
        } else gap(call, 'Kysely schema modifier is outside static analysis: ' + name)
      }
      query = 'CREATE TABLE ' + qualified(objectName) + ' (' + definitions.join(', ') + ')'
    }
    if (method === 'dropIndex' && dialect === 'mysql') {
      const target = chain.find((call) => methodOf(call) === 'on')
      const table = target && staticString(ts, target.arguments[0])
      if (table) query += ' ON ' + qualified(table)
      else {
        gap(first, 'MySQL DROP INDEX requires a statically known table.')
        return true
      }
    }
    if (method === 'createIndex') {
      let target: string | undefined
      let columns: string[] | undefined
      let unique = false
      for (const call of chain.slice(1)) {
        const name = methodOf(call)
        if (name === 'on') target = staticString(ts, call.arguments[0])
        else if (name === 'column') {
          const column = staticString(ts, call.arguments[0])
          if (column) (columns ??= []).push(column)
        } else if (name === 'columns') columns = strings(call.arguments[0])
        else if (name === 'unique') unique = true
        else if (name !== 'ifNotExists')
          gap(call, 'Kysely index modifier is outside static analysis: ' + name)
      }
      if (target && columns?.length)
        query =
          'CREATE ' +
          (unique ? 'UNIQUE ' : '') +
          'INDEX ' +
          qualified(objectName) +
          ' ON ' +
          qualified(target) +
          '(' +
          columns.map(quote).join(', ') +
          ')'
    }
    if (!query) {
      gap(first, 'Kysely schema definition requires manual review.')
      return true
    }
    addQuery(query, expression)
    return true
  }
}
