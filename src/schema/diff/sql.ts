import { createHash } from 'node:crypto'
import {
  sql,
  type ColumnDefinitionBuilder,
  type CompiledQuery,
  type Kysely,
  type RawBuilder,
} from 'kysely'
import type { Dialect } from '../../types'
import type { SqlStatement } from '../diff'
import type {
  ColumnDefault,
  ReferentialAction,
  SchemaColumn,
  SchemaEnum,
  SchemaForeignKey,
  SchemaIndex,
  SchemaTable,
} from '../model'
import { comparableDefault, enumKey, key } from './comparison'

export function constraint(table: SchemaTable, kind: string, columns: readonly string[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([key(table), kind, columns]))
    .digest('hex')
    .slice(0, 12)
  return 'zenlev_' + kind + '_' + digest
}

export function qualified(table: { readonly name: string; readonly namespace?: string }) {
  return sql.id(...(table.namespace ? [table.namespace, table.name] : [table.name]))
}

export function tableSchema(db: Kysely<any>, table: SchemaTable) {
  return table.namespace ? db.schema.withSchema(table.namespace) : db.schema
}

export function statement(query: CompiledQuery): SqlStatement {
  return { sql: query.sql, parameters: query.parameters }
}

export function defaultValue(value: ColumnDefault, dialect: Dialect): RawBuilder<unknown> {
  if (value.kind === 'literal') return sql.lit(value.value)
  const expression = value.sql.trim()
  const supported =
    /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(expression) ||
    (dialect === 'postgresql' &&
      /^(CURRENT_TIMESTAMP\(\d+\)|now\(\)|gen_random_uuid\(\)|uuid_generate_v4\(\))$/i.test(
        expression,
      )) ||
    (dialect === 'mysql' && /^(CURRENT_TIMESTAMP\(\d+\)|now\(\)|uuid\(\))$/i.test(expression))
  if (!supported) {
    throw new Error('Unsupported default expression requires a manual migration')
  }
  return sql.raw(
    dialect === 'mysql' && /^(CURRENT_DATE|CURRENT_TIME|uuid\(\))$/i.test(expression)
      ? '(' + expression + ')'
      : expression,
  )
}

export function renderType(
  column: SchemaColumn,
  dialect: Dialect,
  enums: readonly SchemaEnum[],
): RawBuilder<unknown> {
  if (column.enumName) {
    const definition = enums.find(
      (item) =>
        key(item) === enumKey(column) || (!column.enumNamespace && item.name === column.enumName),
    )
    if (!definition) throw new Error('Missing enum definition: ' + column.enumName)
    if (dialect === 'postgresql')
      return column.array ? sql`${qualified(definition)}[]` : qualified(definition)
    if (dialect === 'mysql')
      return sql`enum(${sql.join(definition.values.map((value) => sql.lit(value)))})`
  }
  const validTypes =
    /^(?:text|varchar|char|tinytext|mediumtext|longtext|uuid|citext|xml|inet|boolean|integer|int|smallint|bigint|tinyint|mediumint|real|double precision|double|float|decimal|numeric|money|date|time|timetz|timestamp|timestamptz|datetime|year|json|jsonb|bytea|binary|varbinary|blob|tinyblob|mediumblob|longblob|bit|varbit|oid)(?: unsigned)?(?:\(\d+(?:\s*,\s*\d+)?\))?(?:\[\])?$/i
  if (!validTypes.test(column.type)) {
    throw new Error('Unsupported column type requires a manual migration: ' + column.type)
  }
  return sql.raw(column.type + (column.array && !column.type.endsWith('[]') ? '[]' : ''))
}

export function renderColumn(column: SchemaColumn, inlinePrimary: boolean, dialect: Dialect) {
  return (builder: ColumnDefinitionBuilder) => {
    let next = builder
    if (inlinePrimary) next = next.primaryKey()
    if (column.autoIncrement)
      next = dialect === 'postgresql' ? next.generatedByDefaultAsIdentity() : next.autoIncrement()
    if (!column.nullable) next = next.notNull()
    if (column.default)
      next = next.defaultTo(
        defaultValue(comparableDefault(column, dialect) ?? column.default, dialect),
      )
    return next
  }
}

export const actions: Record<
  ReferentialAction,
  'cascade' | 'restrict' | 'no action' | 'set null' | 'set default'
> = {
  Cascade: 'cascade',
  Restrict: 'restrict',
  NoAction: 'no action',
  SetNull: 'set null',
  SetDefault: 'set default',
}

export function foreignTarget(fk: SchemaForeignKey): string {
  return fk.targetNamespace ? fk.targetNamespace + '.' + fk.targetTable : fk.targetTable
}

export function foreignName(table: SchemaTable, fk: SchemaForeignKey): string {
  return fk.name ?? constraint(table, 'fk', fk.columns)
}

export function indexName(table: SchemaTable, index: SchemaIndex): string {
  return index.name ?? constraint(table, index.unique ? 'unique' : 'index', index.columns)
}
