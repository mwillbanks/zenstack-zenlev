import { sql } from 'kysely'
import {
  diagnostic,
  fetch,
  tableKey,
  type Catalog,
  type LiveTable,
  type TableName,
} from './catalog/shared'
import type { SchemaDiagnostic, SchemaEnum, SchemaModel, SchemaTable } from './model'
import { mysqlTable } from './mysql/catalog'
import { postgresTable } from './postgresql/catalog'
import { sqliteTable } from './sqlite/catalog'

export { tableKey } from './catalog/shared'

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
  let liveNamespaces = [...namespaces]
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
    liveNamespaces = (
      await fetch<{ name: string }>(
        db,
        sql`SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname IN (${sql.join(namespaces)}) ORDER BY nspname`,
      )
    ).map(({ name }) => name)
    entries = await fetch(
      db,
      sql`
      SELECT c.relname AS name, n.nspname AS namespace, c.oid::text AS key, c.relkind IN ('v','m') AS "isView", c.relkind = 'f' AS "isForeign"
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (${sql.join(namespaces)}) AND c.relkind IN ('r','p','v','m','f')
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
    liveNamespaces = (
      await fetch<{ name: string }>(
        db,
        sql`SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name IN (${sql.join(namespaces)}) ORDER BY schema_name`,
      )
    ).map(({ name }) => name)
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
    if (table.isForeign) {
      unsupported.push(diagnostic(table, 'is a foreign table'))
      continue
    }
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
  return {
    dialect,
    sourcePath: '<database>',
    namespaces: liveNamespaces,
    tables,
    enums,
    unsupported,
    warnings: [],
  }
}
