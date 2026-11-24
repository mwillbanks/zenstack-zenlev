import type { LintInput, LintNode } from '../../lint/types'
import { identity } from '../../identity'
import type { SchemaOperation, SqlStatement } from '../diff'
import type { SchemaColumn, SchemaEnum, SchemaForeignKey, SchemaIndex, SchemaTable } from '../model'
import type { Dialect } from '../../types'
import type { Kysely } from 'kysely'
import { tokenize, typeName, words } from '../../lint/source/tokens'
import { comparableDefault, physicalType } from './comparison'
import { constraint, defaultValue, foreignName, indexName, renderType } from './sql'

const evidence = new WeakMap<SqlStatement, LintInput>()

/** Keep internal analysis out of the public change-set representation. */
export function readStatementEvidence(operation: SchemaOperation): readonly LintInput[] {
  return operation.up.map((statement) => {
    const input = evidence.get(statement)
    if (!input) throw new Error('Missing generated statement evidence: ' + operation.id)
    return input
  })
}

export function recordStatementEvidence(
  statement: SqlStatement,
  nodes: readonly LintNode[],
): SqlStatement {
  evidence.set(statement, {
    nodes,
    gaps: [],
    capabilities: ['sql-objects', 'sql-columns', 'sql-constraints'],
  })
  return statement
}

export function schemaEvidence(dialect: Dialect, enums: readonly SchemaEnum[], db: Kysely<any>) {
  const base = (
    kind: string,
    name: string,
    action: LintNode['action'],
    table?: SchemaTable,
    values: Partial<LintNode> = {},
  ): LintNode => ({
    kind,
    name,
    dialect,
    action,
    origin: 'sql',
    ...(table?.namespace ? { schema: table.namespace } : {}),
    ...(table ? { table: table.name } : {}),
    identity: identity(table?.namespace, ...(table && kind !== 'table' ? [table.name] : []), name),
    spelling: name,
    quoted: true,
    explicit: true,
    ...values,
  })
  const tableNode = (table: SchemaTable, action: LintNode['action']) =>
    base('table', table.name, action, table)
  const column = (
    table: SchemaTable,
    value: SchemaColumn,
    action: 'create' | 'alter',
  ): LintNode => {
    const valueDefault = comparableDefault(value, dialect) ?? value.default
    const defaultSql = valueDefault
      ? words(tokenize(defaultValue(valueDefault, dialect).compile(db).sql, dialect))
      : undefined
    const type = typeName(tokenize(renderType(value, dialect, enums).compile(db).sql, dialect))
    const rowid =
      dialect === 'sqlite' &&
      physicalType(value.type, dialect) === 'integer' &&
      table.primaryKey.length === 1 &&
      table.primaryKey[0] === value.name
    return base('column', value.name, action, table, {
      type,
      nullable:
        rowid || (dialect !== 'sqlite' && table.primaryKey.includes(value.name))
          ? false
          : value.nullable,
      sequential: value.autoIncrement || rowid,
      default: defaultSql,
    })
  }
  const foreign = (
    table: SchemaTable,
    value: SchemaForeignKey,
    action: LintNode['action'],
  ): LintNode =>
    base('foreign-key', foreignName(table, value), action, table, {
      columns: value.columns,
      targetTable: value.targetTable,
      targetSchema: value.targetNamespace,
      targetColumns: value.targetColumns,
      generated: false,
    })
  const index = (
    table: SchemaTable,
    value: SchemaIndex,
    action: 'create' | 'drop',
  ): readonly LintNode[] => {
    const asConstraint = dialect === 'postgresql' && value.constraint
    return [
      ...(asConstraint ? [tableNode(table, 'alter')] : []),
      base(
        asConstraint ? 'unique' : 'index',
        indexName(table, value),
        asConstraint && action === 'create' ? 'alter' : action,
        table,
        {
          columns: value.columns,
          unique: value.unique,
          generated: false,
          partial: false,
        },
      ),
      ...(action === 'drop' && value.unique && (asConstraint || dialect === 'mysql')
        ? [
            base(asConstraint ? 'index' : 'unique', indexName(table, value), 'drop', table, {
              columns: value.columns,
              unique: true,
              generated: false,
            }),
          ]
        : []),
    ]
  }
  return {
    table: tableNode,
    namespace: (name: string) => base('schema', name, 'create'),
    enum: (value: SchemaEnum, action: 'create' | 'drop') =>
      base('enum', value.name, action, undefined, {
        schema: value.namespace,
        identity: identity(value.namespace, value.name),
      }),
    column,
    alterColumn: (table: SchemaTable, name: string, changes: Partial<LintNode>) => [
      tableNode(table, 'alter'),
      base('column', name, 'alter', table, changes),
    ],
    dropColumn: (table: SchemaTable, name: string) => [
      tableNode(table, 'alter'),
      base('column', name, 'drop', table),
    ],
    foreign: (table: SchemaTable, value: SchemaForeignKey, action: 'alter' | 'drop') => [
      tableNode(table, 'alter'),
      foreign(table, value, action),
    ],
    index,
    createTable: (table: SchemaTable): readonly LintNode[] => {
      const inlinePrimary =
        dialect === 'sqlite' &&
        table.primaryKey.length === 1 &&
        table.columns.some((item) => item.name === table.primaryKey[0] && item.autoIncrement)
      return [
        tableNode(table, 'create'),
        ...table.columns.map((item) => column(table, item, 'create')),
        ...(table.primaryKey.length
          ? [
              base(
                'primary-key',
                inlinePrimary
                  ? ''
                  : (table.primaryKeyName ?? constraint(table, 'pk', [...table.primaryKey])),
                'create',
                table,
                {
                  columns: table.primaryKey,
                  generated: inlinePrimary,
                  explicit: !inlinePrimary,
                },
              ),
            ]
          : []),
        ...(dialect === 'sqlite'
          ? table.foreignKeys.map((item) => foreign(table, item, 'create'))
          : []),
      ]
    },
  }
}
