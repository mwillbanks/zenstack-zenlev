import { sql } from 'kysely'
import type { SchemaDiagnostic, SchemaIndex, SchemaTable } from '../model'
import {
  actionValue,
  column,
  diagnostic,
  fetch,
  literalDefault,
  type Catalog,
  type LiveTable,
} from '../catalog/shared'

interface PgConstraint {
  name: string
  kind: string
  columns: string[]
  target: string | null
  target_namespace: string | null
  target_columns: string[] | null
  on_delete: string
  on_update: string
  is_deferrable: boolean
}

export async function postgresTable(
  db: Catalog,
  table: LiveTable,
  unsupported: SchemaDiagnostic[],
): Promise<SchemaTable> {
  const fields = await fetch<{
    name: string
    type: string
    db_type: string
    enum_type: boolean
    type_namespace: string
    notnull: boolean
    identity: string
    generated: string
    default_value: string | null
  }>(
    db,
    sql`
    SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
      base.typname AS db_type, base.typtype = 'e' AS enum_type, type_namespace.nspname AS type_namespace, a.attnotnull AS notnull, a.attidentity AS identity,
      a.attgenerated AS generated, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    JOIN pg_catalog.pg_type base ON base.oid = CASE WHEN t.typelem <> 0 THEN t.typelem ELSE t.oid END
    JOIN pg_catalog.pg_namespace type_namespace ON type_namespace.oid = base.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ${table.key}::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
  `,
  )
  const columns = fields.map((field) => {
    const auto = Boolean(field.identity) || Boolean(field.default_value?.startsWith('nextval('))
    const array = field.type.endsWith('[]')
    const result = column(
      field.name,
      array ? field.type.slice(0, -2) : field.type,
      !field.notnull,
      auto,
      auto ? undefined : literalDefault(field.default_value),
      array,
      field.enum_type ? field.db_type : undefined,
    )
    return field.enum_type ? { ...result, enumNamespace: field.type_namespace } : result
  })
  if (fields.some(({ generated }) => generated !== ''))
    unsupported.push(diagnostic(table, 'has generated columns'))
  const constraints = await fetch<PgConstraint>(
    db,
    sql`
    SELECT c.conname AS name, c.contype AS kind, c.condeferrable AS is_deferrable,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
      r.relname AS target, n.nspname AS target_namespace,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS target_columns,
      c.confdeltype AS on_delete, c.confupdtype AS on_update
    FROM pg_catalog.pg_constraint c LEFT JOIN pg_catalog.pg_class r ON r.oid = c.confrelid
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conrelid = ${table.key}::oid ORDER BY c.conname
  `,
  )
  if (
    constraints.some(
      ({ kind, is_deferrable }) => !['p', 'u', 'f', 'n'].includes(kind) || is_deferrable,
    )
  ) {
    unsupported.push(diagnostic(table, 'has custom or deferrable PostgreSQL constraints'))
  }
  const primary = constraints.find(({ kind }) => kind === 'p')
  const foreignKeys = constraints
    .filter((constraint) => constraint.kind === 'f')
    .map((fk) => ({
      name: fk.name,
      columns: fk.columns,
      targetTable: fk.target!,
      targetColumns: fk.target_columns!,
      ...(fk.target_namespace ? { targetNamespace: fk.target_namespace } : {}),
      onDelete: actionValue(fk.on_delete),
      onUpdate: actionValue(fk.on_update),
    }))
  const indexes: SchemaIndex[] = constraints
    .filter(({ kind }) => kind === 'u')
    .map(({ name, columns }) => ({ name, columns, unique: true, constraint: true }))
  const extra = await fetch<{
    name: string
    is_unique: boolean
    complex: boolean
    columns: string[]
  }>(
    db,
    sql`
    SELECT c.relname AS name, i.indisunique AS is_unique,
      (NOT i.indisvalid OR NOT i.indisready OR i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR i.indnatts <> i.indnkeyatts OR am.amname <> 'btree'
        OR EXISTS (SELECT 1 FROM unnest(i.indoption::smallint[]) flag WHERE flag <> 0)) AS complex,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid = c.relam
    WHERE i.indrelid = ${table.key}::oid AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid = i.indexrelid AND con.contype IN ('p','u','x')
    ) ORDER BY c.relname
  `,
  )
  for (const index of extra) {
    if (index.complex) unsupported.push(diagnostic(table, 'has an unsupported index ' + index.name))
    else indexes.push({ name: index.name, columns: index.columns, unique: index.is_unique })
  }
  return {
    name: table.name,
    ...(table.namespace ? { namespace: table.namespace } : {}),
    model: table.name,
    isView: table.isView,
    columns,
    primaryKey: primary?.columns ?? [],
    ...(primary ? { primaryKeyName: primary.name } : {}),
    indexes,
    foreignKeys,
  }
}
