import type { Dialect } from '../../types'
import type { ColumnDefault, SchemaColumn, SchemaForeignKey, SchemaIndex } from '../model'

export function key(item: { readonly name: string; readonly namespace?: string }): string {
  return item.namespace ? item.namespace + '.' + item.name : item.name
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function physicalType(type: string, dialect: Dialect): string {
  const normalized = type.toLowerCase().replace(/\s+/g, ' ').trim()
  if (dialect === 'mysql')
    return normalized.replace(/^integer\b/, 'int').replace(/^(boolean|bool)$/, 'tinyint(1)')
  if (dialect === 'postgresql')
    return normalized.replace(/^decimal\b/, 'numeric').replace(/ without time zone$/, '')
  return normalized
}

export function comparableDefault(
  column: SchemaColumn,
  dialect: Dialect,
): ColumnDefault | undefined {
  const value = column.default
  if (dialect === 'mysql' && value?.kind === 'sql') {
    const timestamp = /^current_timestamp(?:\((\d+)\))?$/i.exec(value.sql.trim())
    if (timestamp) {
      const precision = timestamp[1] ?? /^(?:datetime|timestamp)\((\d+)\)$/i.exec(column.type)?.[1]
      return { kind: 'sql', sql: 'CURRENT_TIMESTAMP' + (precision ? '(' + precision + ')' : '') }
    }
  }
  if (dialect === 'mysql' && value?.kind === 'literal' && typeof value.value === 'boolean')
    return { kind: 'literal', value: value.value ? 1 : 0 }
  return value
}

export function enumKey(column: SchemaColumn): string | undefined {
  return column.enumName
    ? (column.enumNamespace ? column.enumNamespace + '.' : '') + column.enumName
    : undefined
}

export function foreignSignature(fk: SchemaForeignKey): string {
  return JSON.stringify([
    fk.columns,
    fk.targetNamespace ?? '',
    fk.targetTable,
    fk.targetColumns,
    fk.onDelete ?? 'NoAction',
    fk.onUpdate ?? 'NoAction',
  ])
}

export function indexSignature(index: SchemaIndex): string {
  return JSON.stringify([index.columns, index.unique])
}
