import type { Kysely, RawBuilder } from 'kysely'
import type { ColumnDefault, ReferentialAction, SchemaColumn, SchemaDiagnostic } from '../model'

export type Catalog = Kysely<any>
export type TableName = { readonly name: string; readonly namespace?: string | undefined }
export type LiveTable = TableName & {
  readonly isView: boolean
  readonly isForeign?: boolean
  readonly key: string
  readonly definition?: string
}

export function tableKey(table: TableName): string {
  return table.namespace ? table.namespace + '.' + table.name : table.name
}

export async function fetch<RowType>(
  db: Catalog,
  statement: RawBuilder<RowType>,
): Promise<RowType[]> {
  return (await statement.execute(db)).rows
}

export function literalDefault(value: string | null): ColumnDefault | undefined {
  if (value === null) return undefined
  const normalized = value.trim().replace(/^\((.*)\)$/s, '$1')
  const castless = normalized.replace(/::(?:[\w." ]+)(?:\[\])?$/, '')
  const quoted = /^'(.*)'$/s.exec(castless)
  if (quoted) return { kind: 'literal', value: quoted[1]!.replaceAll("''", "'") }
  if (/^(true|false)$/i.test(castless))
    return { kind: 'literal', value: castless.toLowerCase() === 'true' }
  if (/^null$/i.test(castless)) return { kind: 'literal', value: null }
  const hexadecimal = /^([+-]?)(0x[0-9a-f]{1,16})$/i.exec(castless)
  if (hexadecimal) {
    const integer = Number(BigInt.asIntN(64, BigInt(hexadecimal[2]!)))
    if (!Number.isSafeInteger(integer)) return { kind: 'sql', sql: normalized }
    return { kind: 'literal', value: hexadecimal[1] === '-' ? -integer : integer }
  }
  if (/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(castless) && Number.isFinite(Number(castless))) {
    return { kind: 'literal', value: Number(castless) }
  }
  return { kind: 'sql', sql: normalized }
}

export function actionValue(value: string | null): ReferentialAction {
  switch (value?.toUpperCase()) {
    case 'C':
    case 'CASCADE':
      return 'Cascade'
    case 'R':
    case 'RESTRICT':
      return 'Restrict'
    case 'N':
    case 'SET NULL':
      return 'SetNull'
    case 'D':
    case 'SET DEFAULT':
      return 'SetDefault'
    default:
      return 'NoAction'
  }
}

export function column(
  name: string,
  type: string,
  nullable: boolean,
  autoIncrement: boolean,
  defaultValue: ColumnDefault | undefined,
  array = false,
  enumName?: string,
): SchemaColumn {
  return {
    name,
    field: name,
    type,
    nullable,
    autoIncrement,
    array,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(enumName === undefined ? {} : { enumName }),
  }
}

export function groups<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const group = result.get(id) ?? []
    group.push(row)
    result.set(id, group)
  }
  return result
}

export function diagnostic(table: LiveTable, detail: string): SchemaDiagnostic {
  return {
    code: 'UNSUPPORTED_CATALOG_OBJECT',
    message: tableKey(table) + ' ' + detail + '; use a manual migration',
    source: { path: '<database>', line: 0, column: 0 },
  }
}
