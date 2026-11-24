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

export function readKyselyBuilder(
  dialect: string | undefined,
  isSql: (node: Node) => boolean,
  gap: (node: Node, message: string) => void,
  addQuery: (sql: string, expression: CallExpression) => void,
) {
  return (expression: CallExpression): boolean => {
    const chainOf = (expression: Node) => {
      const calls: CallExpression[] = []
      let root = expression
      while (root.type === 'CallExpression' && root.callee.type === 'MemberExpression') {
        calls.unshift(root)
        root = root.callee.object
      }
      return { calls, root }
    }
    const { calls: chain, root } = chainOf(expression)
    const methodOf = (call: CallExpression) => memberName(call.callee) ?? '<computed>'
    let schema: string | undefined
    if (chain[0] && methodOf(chain[0]) === 'withSchema') {
      schema = staticString(chain[0].arguments[0])
      if (!schema) {
        gap(chain[0], 'Dynamic Kysely schema cannot be analyzed.')
        return true
      }
      chain.shift()
    }
    const first = chain[0]
    if (!first) return false
    const method = methodOf(first)
    if (!['createTable', 'dropTable', 'createIndex', 'dropIndex'].includes(method)) return false
    if (memberName(root) !== 'schema') return false
    const objectName = staticString(first.arguments[0])
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
    const strings = (array: Node | undefined) =>
      array?.type === 'ArrayExpression' &&
      array.elements.every((element) => staticString(element) !== undefined)
        ? array.elements.map((element) => staticString(element)!)
        : undefined
    const sqlValue = (value: Node | undefined): string | undefined => {
      if (value?.type === 'Literal') {
        if (typeof value.value === 'string') return "'" + value.value.replaceAll("'", "''") + "'"
        if (typeof value.value === 'number') return String(value.value)
        if (typeof value.value === 'boolean') return value.value ? 'TRUE' : 'FALSE'
        if (value.value === null) return 'NULL'
      }
      if (value?.type === 'TaggedTemplateExpression' && isSql(value.tag))
        return staticString(value.quasi)
      if (
        value?.type === 'CallExpression' &&
        value.callee.type === 'MemberExpression' &&
        memberName(value.callee) === 'raw' &&
        isSql(value.callee.object)
      )
        return staticString(value.arguments[0])
    }
    const modifiers = (callback: Node | undefined): CallExpression[] => {
      if (!callback) return []
      if (callback.type !== 'ArrowFunctionExpression' || callback.body.type === 'BlockStatement') {
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
          const column = staticString(call.arguments[0])
          const type = staticString(call.arguments[1])
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
              const target = staticString(modifier.arguments[0])?.split('.')
              if (!target || target.length < 2)
                gap(modifier, 'Dynamic Kysely reference cannot be analyzed.')
              else {
                const field = target.pop()!
                definition +=
                  ' REFERENCES ' + target.map(quote).join('.') + '(' + quote(field) + ')'
              }
            } else if (['onDelete', 'onUpdate'].includes(name)) {
              const action = staticString(modifier.arguments[0])
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
          const constraint = staticString(call.arguments[0])
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
            const target = staticString(call.arguments[2])
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
          const constraint = staticString(call.arguments[0])
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
      const table = target && staticString(target.arguments[0])
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
      let incomplete = false
      for (const call of chain.slice(1)) {
        const name = methodOf(call)
        if (name === 'on') target = staticString(call.arguments[0])
        else if (name === 'column') {
          const column = staticString(call.arguments[0])
          if (column) (columns ??= []).push(column)
        } else if (name === 'columns') columns = strings(call.arguments[0])
        else if (name === 'unique') unique = true
        else if (name !== 'ifNotExists') {
          incomplete = true
          gap(call, 'Kysely index modifier is outside static analysis: ' + name)
        }
      }
      if (incomplete) return true
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
