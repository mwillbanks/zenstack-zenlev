import { sql, type Kysely } from 'kysely'
import {
  rows,
  node,
  identity,
  grouped,
  columnCapabilities,
  keyCapabilities,
} from '../catalog/shared'
import type { LintInput, LintGap, LintNode } from '../types'

export async function mysql(
  db: Kysely<any>,
  namespaces: readonly string[] | undefined,
): Promise<LintInput> {
  const current = await rows(
    db,
    sql<{
      name: string | null
      case_mode: number
    }>`SELECT DATABASE() AS name, @@lower_case_table_names AS case_mode`,
  )
  const requested = namespaces ?? (current[0]?.name ? [current[0].name] : [])
  if (requested.length === 0) throw new Error('Live lint requires a selected MySQL database')
  const visible = await rows(
    db,
    sql<{
      name: string
    }>`SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`,
  )
  const caseInsensitive = current[0]?.case_mode === 1 || current[0]?.case_mode === 2
  const matches = (left: string, right: string) =>
    caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
  const selected = visible
    .filter((schema) => requested.some((name) => matches(schema.name, name)))
    .map((schema) => schema.name)
  const nodes: LintNode[] = selected.map((name) => node('mysql', 'schema', name))
  const gaps: LintGap[] = [
    {
      message:
        'MySQL INFORMATION_SCHEMA only exposes metadata visible to the current account. Audit completeness requires metadata privileges for every selected database.',
    },
  ]
  for (const name of requested)
    if (!selected.some((schema) => matches(schema, name)))
      gaps.push({ message: 'Configured MySQL database is absent or unavailable', identity: name })
  if (selected.length === 0) return { nodes, gaps, capabilities: ['schemas'] }
  const tables = await rows(
    db,
    sql<{ schema: string; name: string; kind: string }>`
    SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, TABLE_TYPE AS kind FROM information_schema.TABLES
    WHERE TABLE_SCHEMA IN (${sql.join(selected)}) ORDER BY TABLE_SCHEMA, TABLE_NAME
  `,
  )
  for (const table of tables)
    nodes.push(node('mysql', table.kind === 'VIEW' ? 'view' : 'table', table.name, table.schema))
  const fields = await rows(
    db,
    sql<{
      schema: string
      table: string
      name: string
      type: string
      nullable: string
      default_value: string | null
      extra: string
    }>`
    SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, COLUMN_NAME AS name, COLUMN_TYPE AS type,
      IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value, EXTRA AS extra
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${sql.join(selected)}) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
  `,
  )
  for (const field of fields)
    nodes.push({
      ...node('mysql', 'column', field.name, field.schema, field.table),
      type: field.type,
      nullable: field.nullable === 'YES',
      sequential: /auto_increment/i.test(field.extra),
      generated: /(?:VIRTUAL|STORED) GENERATED/i.test(field.extra),
      ...(field.default_value === null ? {} : { default: field.default_value }),
    })
  const keys = await rows(
    db,
    sql<{
      schema: string
      table: string
      name: string
      column: string
      target_schema: string | null
      target_table: string | null
      target_column: string | null
    }>`
    SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, CONSTRAINT_NAME AS name, COLUMN_NAME AS \`column\`,
      REFERENCED_TABLE_SCHEMA AS target_schema, REFERENCED_TABLE_NAME AS target_table, REFERENCED_COLUMN_NAME AS target_column
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA IN (${sql.join(selected)})
    ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION
  `,
  )
  for (const parts of grouped(keys, (key) => identity(key.schema, key.table, key.name))) {
    const first = parts[0]!
    const kind =
      first.name === 'PRIMARY' ? 'primary-key' : first.target_table ? 'foreign-key' : 'unique'
    nodes.push({
      ...node('mysql', kind, first.name, first.schema, first.table),
      columns: parts.map((part) => part.column),
      ...(first.target_table
        ? {
            targetTable: first.target_table,
            targetSchema: first.target_schema!,
            targetColumns: parts.map((part) => part.target_column!),
          }
        : {}),
    })
  }
  const indexes = await rows(
    db,
    sql<{
      schema: string
      table: string
      name: string
      column: string | null
      non_unique: number
      prefix: number | null
      index_type: string
      visible: string
    }>`
    SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, INDEX_NAME AS name, COLUMN_NAME AS \`column\`,
      NON_UNIQUE AS non_unique, SUB_PART AS prefix, INDEX_TYPE AS index_type, IS_VISIBLE AS visible
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN (${sql.join(selected)})
    ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
  `,
  )
  for (const parts of grouped(indexes, (index) =>
    identity(index.schema, index.table, index.name),
  )) {
    const first = parts[0]!
    nodes.push({
      ...node('mysql', 'index', first.name, first.schema, first.table),
      columns: parts.flatMap((part) => (part.column === null ? [] : [part.column])),
      unique: Number(first.non_unique) === 0,
      partial: parts.some(
        (part) =>
          part.column === null ||
          part.prefix !== null ||
          part.index_type !== 'BTREE' ||
          part.visible !== 'YES',
      ),
    })
  }
  const checks = await rows(
    db,
    sql<{ schema: string; table: string; name: string; expression: string }>`
    SELECT t.CONSTRAINT_SCHEMA AS \`schema\`, t.TABLE_NAME AS \`table\`, t.CONSTRAINT_NAME AS name, c.CHECK_CLAUSE AS expression
    FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
      ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
    WHERE t.CONSTRAINT_SCHEMA IN (${sql.join(selected)}) AND t.CONSTRAINT_TYPE = 'CHECK'
    ORDER BY t.CONSTRAINT_SCHEMA, t.TABLE_NAME, t.CONSTRAINT_NAME
  `,
  )
  for (const check of checks)
    nodes.push({
      ...node('mysql', 'check', check.name, check.schema, check.table),
      check: check.expression,
    })
  const routines = await rows(
    db,
    sql<{
      schema: string
      name: string
      kind: string
      security: string
      definition: string | null
    }>`
    SELECT ROUTINE_SCHEMA AS \`schema\`, ROUTINE_NAME AS name, ROUTINE_TYPE AS kind, SECURITY_TYPE AS security, ROUTINE_DEFINITION AS definition
    FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN (${sql.join(selected)}) ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME
  `,
  )
  for (const routine of routines) {
    nodes.push({
      ...node(
        'mysql',
        routine.kind === 'PROCEDURE' ? 'procedure' : 'function',
        routine.name,
        routine.schema,
      ),
      security: routine.security.toLowerCase(),
      language: 'sql',
    })
    if (routine.definition === null)
      gaps.push({
        message: 'Routine definition is unavailable to the current account',
        identity: identity(routine.schema, routine.name),
      })
  }
  const views = await rows(
    db,
    sql<{ schema: string; name: string; security: string; definition: string | null }>`
    SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, SECURITY_TYPE AS security, VIEW_DEFINITION AS definition
    FROM information_schema.VIEWS WHERE TABLE_SCHEMA IN (${sql.join(selected)}) ORDER BY TABLE_SCHEMA, TABLE_NAME
  `,
  )
  for (const view of views) {
    const index = nodes.findIndex(
      (entry) => entry.kind === 'view' && entry.schema === view.schema && entry.name === view.name,
    )
    if (index >= 0) nodes[index] = { ...nodes[index]!, security: view.security.toLowerCase() }
    if (!view.definition)
      gaps.push({
        message: 'View definition is unavailable to the current account',
        identity: identity(view.schema, view.name),
      })
  }
  const triggers = await rows(
    db,
    sql<{ schema: string; table: string; name: string }>`
    SELECT TRIGGER_SCHEMA AS \`schema\`, EVENT_OBJECT_TABLE AS \`table\`, TRIGGER_NAME AS name
    FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN (${sql.join(selected)}) ORDER BY TRIGGER_SCHEMA, EVENT_OBJECT_TABLE, TRIGGER_NAME
  `,
  )
  for (const trigger of triggers)
    nodes.push({
      ...node('mysql', 'trigger', trigger.name, trigger.schema, trigger.table),
      security: 'definer',
    })
  const events = await rows(
    db,
    sql<{ schema: string; name: string }>`
    SELECT EVENT_SCHEMA AS \`schema\`, EVENT_NAME AS name FROM information_schema.EVENTS
    WHERE EVENT_SCHEMA IN (${sql.join(selected)}) ORDER BY EVENT_SCHEMA, EVENT_NAME
  `,
  )
  for (const event of events)
    nodes.push({ ...node('mysql', 'event', event.name, event.schema), security: 'definer' })
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
      'events',
      ...columnCapabilities,
      ...keyCapabilities,
      'routine:security',
      'view:security',
      'trigger:security',
      'event:security',
    ],
  }
}
