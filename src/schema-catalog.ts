import { sql, type Kysely, type RawBuilder } from 'kysely'
import type {
  ColumnDefault,
  ReferentialAction,
  SchemaColumn,
  SchemaDiagnostic,
  SchemaEnum,
  SchemaForeignKey,
  SchemaIndex,
  SchemaModel,
  SchemaTable,
} from './schema-model'

type Catalog = Kysely<any>
type TableName = { readonly name: string; readonly namespace?: string | undefined }
type LiveTable = TableName & {
  readonly isView: boolean
  readonly key: string
  readonly definition?: string
}

export function tableKey(table: TableName): string {
  return table.namespace ? table.namespace + '.' + table.name : table.name
}

async function fetch<RowType>(db: Catalog, statement: RawBuilder<RowType>): Promise<RowType[]> {
  return (await statement.execute(db)).rows
}

function literalDefault(value: string | null): ColumnDefault | undefined {
  if (value === null) return undefined
  const normalized = value.trim().replace(/^\((.*)\)$/s, '$1')
  const castless = normalized.replace(/::(?:[\w." ]+)(?:\[\])?$/, '')
  const quoted = /^'(.*)'$/s.exec(castless)
  if (quoted) return { kind: 'literal', value: quoted[1]!.replaceAll("''", "'") }
  if (/^(true|false)$/i.test(castless))
    return { kind: 'literal', value: castless.toLowerCase() === 'true' }
  if (/^null$/i.test(castless)) return { kind: 'literal', value: null }
  if (/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(castless) && Number.isFinite(Number(castless))) {
    return { kind: 'literal', value: Number(castless) }
  }
  return { kind: 'sql', sql: normalized }
}

function actionValue(value: string | null): ReferentialAction {
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

function column(
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

function groups<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const group = result.get(id) ?? []
    group.push(row)
    result.set(id, group)
  }
  return result
}

function diagnostic(table: LiveTable, detail: string): SchemaDiagnostic {
  return {
    code: 'UNSUPPORTED_CATALOG_OBJECT',
    message: tableKey(table) + ' ' + detail + '; use a manual migration',
    source: { path: '<database>', line: 0, column: 0 },
  }
}

async function sqliteTable(
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
    if (parts.some(({ to }) => to === null)) {
      unsupported.push(diagnostic(table, 'has an implicit SQLite foreign key target'))
      continue
    }
    foreignKeys.push({
      columns: parts.map((part) => part.from),
      targetTable: first.table,
      targetColumns: parts.map((part) => part.to!),
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

async function postgresTable(
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
      (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR i.indnatts <> i.indnkeyatts OR am.amname <> 'btree'
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

async function mysqlTable(
  db: Catalog,
  table: LiveTable,
  desired: SchemaTable | undefined,
  unsupported: SchemaDiagnostic[],
): Promise<SchemaTable> {
  const fields = await fetch<{
    name: string
    data_type: string
    type: string
    nullable: string
    extra: string
    default_value: string | null
  }>(
    db,
    sql`
    SELECT column_name AS name, data_type AS data_type, column_type AS type, is_nullable AS nullable, extra AS extra, column_default AS default_value
    FROM information_schema.columns
    WHERE table_schema = ${table.namespace} AND table_name = ${table.name} ORDER BY ordinal_position
  `,
  )
  const columns = fields.map((field) => {
    const expected = desired?.columns.find(({ name }) => name === field.name)
    const value =
      field.default_value === null
        ? undefined
        : ['char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum', 'set'].includes(
              field.data_type,
            ) && !field.extra.includes('DEFAULT_GENERATED')
          ? { kind: 'literal' as const, value: field.default_value }
          : literalDefault(field.default_value)
    return column(
      field.name,
      field.type,
      field.nullable === 'YES',
      field.extra.includes('auto_increment'),
      value,
      false,
      field.data_type === 'enum' ? expected?.enumName : undefined,
    )
  })
  if (fields.some(({ extra }) => /(?:VIRTUAL|STORED) GENERATED|on update/i.test(extra))) {
    unsupported.push(diagnostic(table, 'has generated columns or ON UPDATE actions'))
  }
  const indexRows = await fetch<{
    name: string
    non_unique: number
    column_name: string | null
    sub_part: number | null
    collation: string | null
    index_type: string
  }>(
    db,
    sql`
    SELECT index_name AS name, non_unique AS non_unique, column_name AS column_name, sub_part AS sub_part, collation AS collation, index_type AS index_type
    FROM information_schema.statistics WHERE table_schema = ${table.namespace} AND table_name = ${table.name}
    ORDER BY index_name, seq_in_index
  `,
  )
  const indexes: SchemaIndex[] = []
  let primaryKey: string[] = []
  for (const [name, keys] of groups(indexRows, (index) => index.name)) {
    if (
      keys.some(
        (key) =>
          !key.column_name ||
          key.sub_part !== null ||
          key.collation !== 'A' ||
          key.index_type !== 'BTREE',
      )
    ) {
      unsupported.push(diagnostic(table, 'has an unsupported index ' + name))
      continue
    }
    const names = keys.map(({ column_name }) => column_name!)
    if (name === 'PRIMARY') primaryKey = names
    else indexes.push({ name, columns: names, unique: Number(keys[0]!.non_unique) === 0 })
  }
  const links = await fetch<{
    name: string
    column_name: string
    target_schema: string
    target_table: string
    target_column: string
    update_rule: string
    delete_rule: string
  }>(
    db,
    sql`
    SELECT k.constraint_name AS name, k.column_name AS column_name, k.referenced_table_schema AS target_schema,
      k.referenced_table_name AS target_table, k.referenced_column_name AS target_column, r.update_rule AS update_rule, r.delete_rule AS delete_rule
    FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r
      ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name
    WHERE k.table_schema = ${table.namespace} AND k.table_name = ${table.name}
    ORDER BY k.constraint_name, k.ordinal_position
  `,
  )
  const foreignKeys = [...groups(links, ({ name }) => name)].map(([name, keys]) => ({
    name,
    columns: keys.map((key) => key.column_name),
    targetTable: keys[0]!.target_table,
    targetNamespace: keys[0]!.target_schema,
    targetColumns: keys.map((key) => key.target_column),
    onDelete: actionValue(keys[0]!.delete_rule),
    onUpdate: actionValue(keys[0]!.update_rule),
  }))
  return {
    name: table.name,
    ...(table.namespace ? { namespace: table.namespace } : {}),
    model: table.name,
    isView: table.isView,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
  }
}

export async function alignCatalogSchema(db: Catalog, desired: SchemaModel): Promise<SchemaModel> {
  if (desired.dialect === 'sqlite') return desired
  const current =
    desired.dialect === 'postgresql'
      ? await fetch<{ name: string }>(db, sql`SELECT current_schema() AS name`)
      : await fetch<{ name: string }>(db, sql`SELECT DATABASE() AS name`)
  const currentNamespace = current[0]?.name
  if (!currentNamespace) throw new Error('The configured connection has no default database schema')
  const namespaces = [
    ...new Set([
      ...desired.namespaces,
      ...desired.tables.map((table) => table.namespace ?? currentNamespace),
    ]),
  ].sort()
  if (namespaces.length === 0) namespaces.push(currentNamespace)
  const tables = desired.tables.map((table) => ({
    ...table,
    namespace: table.namespace ?? currentNamespace,
    foreignKeys: table.foreignKeys.map((key) => ({
      ...key,
      targetNamespace: key.targetNamespace ?? table.namespace ?? currentNamespace,
    })),
  }))
  const enums = desired.enums.map((entry) => ({
    ...entry,
    namespace: entry.namespace ?? currentNamespace,
  }))
  return { ...desired, namespaces, tables, enums }
}

export async function readCatalog(
  db: Catalog,
  schema: SchemaModel,
  excluded: readonly TableName[],
  excludeViews = true,
): Promise<SchemaModel> {
  const { dialect, namespaces } = schema
  const matches = (table: TableName) =>
    !excluded.some(
      (entry) =>
        entry.name === table.name &&
        (entry.namespace === undefined || entry.namespace === table.namespace),
    )
  let entries: LiveTable[]
  let enums: SchemaEnum[] = []
  if (dialect === 'sqlite') {
    entries = await fetch(
      db,
      sql`
      SELECT name, name AS key, type = 'view' AS isView, sql AS definition FROM sqlite_schema
      WHERE type IN ('table', 'view') AND name NOT GLOB 'sqlite_*' ORDER BY name
    `,
    )
  } else if (dialect === 'postgresql') {
    entries = await fetch(
      db,
      sql`
      SELECT c.relname AS name, n.nspname AS namespace, c.oid::text AS key, c.relkind IN ('v','m') AS "isView"
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (${sql.join(namespaces)}) AND c.relkind IN ('r','p','v','m')
      ORDER BY n.nspname, c.relname
    `,
    )
    enums = await fetch(
      db,
      sql`
      SELECT n.nspname AS namespace, t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
      FROM pg_catalog.pg_type t JOIN pg_catalog.pg_enum e ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname IN (${sql.join(namespaces)}) GROUP BY n.nspname, t.typname ORDER BY n.nspname, t.typname
    `,
    )
  } else {
    entries = await fetch(
      db,
      sql`
      SELECT table_name AS name, table_schema AS namespace, table_name AS \`key\`, table_type = 'VIEW' AS isView
      FROM information_schema.tables WHERE table_schema IN (${sql.join(namespaces)})
      ORDER BY table_schema, table_name
    `,
    )
    enums = [...schema.enums]
  }
  const selected = entries.filter((table) => matches(table) && (!excludeViews || !table.isView))
  const unsupported: SchemaDiagnostic[] = []
  const tables: SchemaTable[] = []
  for (const entry of selected) {
    const table = { ...entry, isView: Boolean(entry.isView) }
    if (table.isView) {
      unsupported.push(diagnostic(table, 'is a view'))
      continue
    }
    if (dialect === 'sqlite') tables.push(await sqliteTable(db, table, unsupported))
    else if (dialect === 'postgresql') tables.push(await postgresTable(db, table, unsupported))
    else
      tables.push(
        await mysqlTable(
          db,
          table,
          schema.tables.find((model) => tableKey(model) === tableKey(table)),
          unsupported,
        ),
      )
  }
  return { dialect, sourcePath: '<database>', namespaces, tables, enums, unsupported, warnings: [] }
}
