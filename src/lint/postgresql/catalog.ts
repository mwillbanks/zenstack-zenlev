import { sql, type Kysely } from 'kysely'
import { rows, node, identity, columnCapabilities, keyCapabilities } from '../catalog/shared'
import type { LintInput, LintGap, LintNode } from '../types'

export async function postgres(
  db: Kysely<any>,
  namespaces: readonly string[] | undefined,
): Promise<LintInput> {
  const schemas = await rows(
    db,
    sql<{ name: string }>`
    SELECT nspname AS name FROM pg_catalog.pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname
  `,
  )
  const selected = schemas
    .map(({ name }) => name)
    .filter((name) => namespaces === undefined || namespaces.includes(name))
  const nodes: LintNode[] = selected.map((name) => node('postgresql', 'schema', name))
  const gaps: LintGap[] = []
  if (namespaces) {
    for (const name of namespaces) {
      if (!selected.includes(name))
        gaps.push({ message: 'Configured schema is absent or unavailable', identity: name })
    }
  }
  if (selected.length === 0) return { nodes, gaps, capabilities: ['schemas'] }
  const tables = await rows(
    db,
    sql<{
      oid: string
      schema: string
      name: string
      kind: string
      enabled: boolean
      forced: boolean
      options: string[] | null
    }>`
    SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind,
      c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, c.reloptions AS options
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN (${sql.join(selected)}) AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY n.nspname, c.relname
  `,
  )
  for (const table of tables) {
    const kind =
      table.kind === 'v'
        ? 'view'
        : table.kind === 'm'
          ? 'materialized-view'
          : table.kind === 'S'
            ? 'sequence'
            : 'table'
    const options = table.options ?? []
    nodes.push({
      ...node('postgresql', kind, table.name, table.schema),
      ...(kind === 'view'
        ? { security: options.includes('security_invoker=true') ? 'invoker' : 'definer' }
        : {}),
    })
    if (kind === 'table')
      nodes.push({
        ...node('postgresql', 'rls', table.name, table.schema, table.name),
        enabled: table.enabled,
        forced: table.forced,
      })
  }
  const tableOids = tables
    .filter(({ kind }) => ['r', 'p', 'v', 'm'].includes(kind))
    .map(({ oid }) => oid)
  const byOid = new Map(tables.map((table) => [table.oid, table]))
  if (tableOids.length > 0) {
    const fields = await rows(
      db,
      sql<{
        oid: string
        name: string
        type: string
        nullable: boolean
        default_value: string | null
        sequential: boolean
        generated: boolean
      }>`
      SELECT a.attrelid::text AS oid, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
        NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
        (a.attidentity <> '' OR COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid) ~ '^nextval\\(', false)) AS sequential,
        a.attgenerated <> '' AS generated
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid::text IN (${sql.join(tableOids)}) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum
    `,
    )
    for (const field of fields) {
      const table = byOid.get(field.oid)!
      nodes.push({
        ...node('postgresql', 'column', field.name, table.schema, table.name),
        type: field.type,
        nullable: field.nullable,
        sequential: field.sequential,
        generated: field.generated,
        ...(field.default_value === null ? {} : { default: field.default_value }),
      })
    }
    const constraints = await rows(
      db,
      sql<{
        oid: string
        name: string
        kind: string
        columns: string[]
        target_table: string | null
        target_schema: string | null
        target_columns: string[]
        expression: string | null
      }>`
      SELECT c.conrelid::text AS oid, c.conname AS name, c.contype AS kind,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
        t.relname AS target_table, n.nspname AS target_schema,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_columns,
        pg_catalog.pg_get_expr(c.conbin, c.conrelid) AS expression
      FROM pg_catalog.pg_constraint c LEFT JOIN pg_catalog.pg_class t ON t.oid = c.confrelid
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE c.conrelid::text IN (${sql.join(tableOids)}) AND c.contype IN ('p', 'u', 'f', 'c', 'x')
      ORDER BY c.conrelid, c.conname
    `,
    )
    for (const constraint of constraints) {
      const table = byOid.get(constraint.oid)!
      const kind =
        constraint.kind === 'p'
          ? 'primary-key'
          : constraint.kind === 'u'
            ? 'unique'
            : constraint.kind === 'f'
              ? 'foreign-key'
              : constraint.kind === 'x'
                ? 'exclusion'
                : 'check'
      nodes.push({
        ...node('postgresql', kind, constraint.name, table.schema, table.name),
        columns: constraint.columns,
        ...(constraint.target_table === null ? {} : { targetTable: constraint.target_table }),
        ...(constraint.target_schema === null ? {} : { targetSchema: constraint.target_schema }),
        ...(constraint.kind === 'f' ? { targetColumns: constraint.target_columns } : {}),
        ...(constraint.expression === null ? {} : { check: constraint.expression }),
      })
    }
    const indexes = await rows(
      db,
      sql<{ oid: string; name: string; unique: boolean; partial: boolean; columns: string[] }>`
      SELECT i.indrelid::text AS oid, c.relname AS name, i.indisunique AS "unique",
        (i.indpred IS NOT NULL OR i.indexprs IS NOT NULL OR NOT i.indisvalid OR NOT i.indisready OR am.amname <> 'btree') AS partial,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
          WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid = c.relam
      WHERE i.indrelid::text IN (${sql.join(tableOids)}) ORDER BY i.indrelid, c.relname
    `,
    )
    for (const index of indexes) {
      const table = byOid.get(index.oid)!
      nodes.push({
        ...node('postgresql', 'index', index.name, table.schema, table.name),
        columns: index.columns,
        unique: index.unique,
        partial: index.partial,
      })
    }
    const policies = await rows(
      db,
      sql<{
        schema: string
        table: string
        name: string
        permissive: string
        roles: string[]
        command: string
        using: string | null
        check: string | null
      }>`
      SELECT schemaname AS schema, tablename AS "table", policyname AS name, permissive, roles::text[] AS roles,
        cmd AS command, qual AS "using", with_check AS "check"
      FROM pg_catalog.pg_policies WHERE schemaname IN (${sql.join(selected)}) ORDER BY schemaname, tablename, policyname
    `,
    )
    for (const policy of policies.filter((policy) =>
      tables.some((table) => table.schema === policy.schema && table.name === policy.table),
    ))
      nodes.push({
        ...node('postgresql', 'policy', policy.name, policy.schema, policy.table),
        permissive: policy.permissive === 'PERMISSIVE',
        roles: policy.roles,
        command: policy.command,
        using: policy.using,
        check: policy.check,
      })
  }
  const routines = await rows(
    db,
    sql<{
      schema: string
      name: string
      signature: string
      kind: string
      language: string
      security: boolean
      settings: string[] | null
    }>`
    SELECT n.nspname AS schema, p.proname AS name, pg_catalog.oidvectortypes(p.proargtypes) AS signature,
      p.prokind AS kind, l.lanname AS language, p.prosecdef AS security, p.proconfig AS settings
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname IN (${sql.join(selected)}) AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    ORDER BY n.nspname, p.proname, signature
  `,
  )
  for (const routine of routines) {
    const searchPath = routine.settings?.find((setting) => setting.startsWith('search_path='))
    nodes.push({
      ...node(
        'postgresql',
        routine.kind === 'p' ? 'procedure' : 'function',
        routine.name,
        routine.schema,
      ),
      identity: identity(routine.schema, routine.name) + '(' + routine.signature + ')',
      signature: routine.signature,
      language: routine.language,
      security: routine.security ? 'definer' : 'invoker',
      searchPath:
        searchPath === undefined
          ? []
          : searchPath
              .slice('search_path='.length)
              .split(',')
              .map((entry) => entry.trim()),
    })
  }
  const triggers = await rows(
    db,
    sql<{ schema: string; table: string; name: string }>`
    SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS name FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN (${sql.join(selected)}) AND NOT t.tgisinternal AND t.tgparentid = 0
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_trigger'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    ORDER BY n.nspname, c.relname, t.tgname
  `,
  )
  for (const trigger of triggers.filter((trigger) =>
    tables.some((table) => table.schema === trigger.schema && table.name === trigger.table),
  ))
    nodes.push(node('postgresql', 'trigger', trigger.name, trigger.schema, trigger.table))
  const eventTriggers = await rows(
    db,
    sql<{ name: string }>`
    SELECT t.evtname AS name FROM pg_catalog.pg_event_trigger t
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_event_trigger'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    ORDER BY t.evtname
  `,
  )
  for (const trigger of eventTriggers) nodes.push(node('postgresql', 'event-trigger', trigger.name))
  const extensions = await rows(
    db,
    sql<{ name: string; schema: string }>`
    SELECT e.extname AS name, n.nspname AS schema FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    WHERE n.nspname IN (${sql.join(selected)}) ORDER BY e.extname
  `,
  )
  for (const extension of extensions)
    nodes.push(node('postgresql', 'extension', extension.name, extension.schema))
  const enums = await rows(
    db,
    sql<{ schema: string; name: string; values: string[] }>`
    SELECT n.nspname AS schema, t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname IN (${sql.join(selected)})
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    GROUP BY n.nspname, t.typname ORDER BY n.nspname, t.typname
  `,
  )
  for (const entry of enums) {
    nodes.push(node('postgresql', 'enum', entry.name, entry.schema))
    for (const value of entry.values)
      nodes.push(node('postgresql', 'enum-value', value, entry.schema, entry.name))
  }
  return {
    nodes,
    gaps,
    capabilities: [
      'schemas',
      'tables',
      'columns',
      'constraints',
      'indexes',
      'functions',
      'procedures',
      'views',
      'triggers',
      'event-triggers',
      'sequences',
      'extensions',
      'rls',
      'policies',
      'enums',
      'materialized-views',
      ...columnCapabilities,
      ...keyCapabilities,
      'index:partial',
      'routine:signature',
      'routine:language',
      'routine:security',
      'routine:search-path',
      'view:security',
      'rls:enabled',
      'rls:forced',
      'policy:command',
      'policy:roles',
      'policy:using',
      'policy:with-check',
    ],
  }
}
