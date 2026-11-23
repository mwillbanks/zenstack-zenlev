import { sql } from 'kysely'
import type { SchemaDiagnostic, SchemaForeignKey, SchemaIndex, SchemaTable } from '../model'
import {
  actionValue,
  column,
  diagnostic,
  fetch,
  groups,
  literalDefault,
  type Catalog,
  type LiveTable,
} from '../catalog/shared'

export async function sqliteTable(
  db: Catalog,
  table: LiveTable,
  unsupported: SchemaDiagnostic[],
): Promise<SchemaTable> {
  const fields = await fetch<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
    hidden: number
  }>(
    db,
    sql`
    SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(${table.name}) ORDER BY cid
  `,
  )
  const primaryKey = fields
    .filter(({ pk }) => pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map(({ name }) => name)
  const columns = fields
    .filter(({ hidden }) => hidden === 0)
    .map((field) =>
      column(
        field.name,
        field.type || 'blob',
        field.notnull === 0 && field.pk === 0,
        field.pk > 0 && /\bAUTOINCREMENT\b/i.test(table.definition ?? ''),
        literalDefault(field.dflt_value),
      ),
    )
  if (fields.some(({ hidden }) => hidden !== 0))
    unsupported.push(diagnostic(table, 'has hidden or generated columns'))
  if (
    /\b(?:CHECK\s*\(|COLLATE\s+|WITHOUT ROWID|CREATE\s+VIRTUAL\s+TABLE)\b/i.test(
      table.definition ?? '',
    )
  ) {
    unsupported.push(
      diagnostic(table, 'has SQLite constraints or storage features outside the diff model'),
    )
  }
  const indices = await fetch<{ name: string; unique: number; origin: string; partial: number }>(
    db,
    sql`
    SELECT name, "unique", origin, partial FROM pragma_index_list(${table.name}) WHERE origin <> 'pk' ORDER BY name
  `,
  )
  const indexes: SchemaIndex[] = []
  for (const index of indices) {
    const keys = await fetch<{ name: string | null; collation: string; descending: number }>(
      db,
      sql`
      SELECT name, coll AS collation, "desc" AS descending FROM pragma_index_xinfo(${index.name}) WHERE "key" = 1 ORDER BY seqno
    `,
    )
    if (
      index.partial ||
      keys.some((key) => key.name === null || key.collation !== 'BINARY' || key.descending)
    ) {
      unsupported.push(
        diagnostic(table, 'has an expression, partial, ordered, or collated index ' + index.name),
      )
      continue
    }
    indexes.push({
      ...(index.origin === 'u' ? {} : { name: index.name }),
      columns: keys.map((key) => key.name!),
      unique: index.unique === 1,
    })
  }
  const relations = await fetch<{
    id: number
    table: string
    from: string
    to: string | null
    on_update: string
    on_delete: string
  }>(
    db,
    sql`
    SELECT id, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(${table.name}) ORDER BY id, seq
  `,
  )
  const foreignKeys: SchemaForeignKey[] = []
  for (const parts of groups(relations, ({ id }) => String(id)).values()) {
    const first = parts[0]!
    const targetColumns: string[] = []
    for (const part of parts) if (part.to !== null) targetColumns.push(part.to)
    if (targetColumns.length !== parts.length) {
      unsupported.push(diagnostic(table, 'has an implicit SQLite foreign key target'))
      continue
    }
    foreignKeys.push({
      columns: parts.map((part) => part.from),
      targetTable: first.table,
      targetColumns,
      onDelete: actionValue(first.on_delete),
      onUpdate: actionValue(first.on_update),
    })
  }
  return {
    name: table.name,
    model: table.name,
    isView: table.isView,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
  }
}
