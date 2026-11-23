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
import { parseSqlLintInput } from '../source/sql'

export async function sqlite(
  db: Kysely<any>,
  namespaces: readonly string[] | undefined,
): Promise<LintInput> {
  const databases = await rows(db, sql<{ name: string }>`PRAGMA database_list`)
  const selected = databases
    .map(({ name }) => name)
    .filter((name) => (namespaces === undefined ? name === 'main' : namespaces.includes(name)))
  const nodes: LintNode[] = []
  const gaps: LintGap[] = []
  for (const schema of selected) {
    nodes.push(node('sqlite', 'schema', schema))
    const entries = await rows(
      db,
      sql<{ name: string; table: string; type: string; definition: string | null }>`
      SELECT name, tbl_name AS "table", type, sql AS definition FROM ${sql.id(schema, 'sqlite_schema')}
      WHERE name NOT GLOB 'sqlite_*' AND type IN ('table', 'view', 'trigger', 'index') ORDER BY type, name
    `,
    )
    for (const entry of entries) {
      if (entry.type === 'index') continue
      nodes.push(
        node(
          'sqlite',
          entry.type,
          entry.name,
          schema,
          entry.type === 'trigger' ? entry.table : undefined,
        ),
      )
      if (entry.type !== 'table') continue
      const parsed = entry.definition
        ? await parseSqlLintInput(entry.definition, 'sqlite', {
            path: '<catalog>',
            line: 1,
            column: 1,
          })
        : { nodes: [], gaps: [] }
      const fields = await rows(
        db,
        sql<{
          name: string
          type: string
          nullable: number
          default_value: string | null
          pk: number
          hidden: number
        }>`
        SELECT name, type, "notnull" AS nullable, dflt_value AS default_value, pk, hidden
        FROM pragma_table_xinfo(${entry.name}, ${schema}) ORDER BY cid
      `,
      )
      const pk = fields.filter((field) => field.pk > 0).sort((a, b) => a.pk - b.pk)
      const indexes = await rows(
        db,
        sql<{ name: string; unique: number; origin: string; partial: number }>`
        SELECT name, "unique", origin, partial FROM pragma_index_list(${entry.name}, ${schema}) ORDER BY name
      `,
      )
      const rowid =
        !/\bWITHOUT\s+ROWID\b/i.test(entry.definition ?? '') &&
        pk.length === 1 &&
        pk[0]!.type.toUpperCase() === 'INTEGER' &&
        !indexes.some((index) => index.origin === 'pk')
      for (const field of fields)
        nodes.push({
          ...node('sqlite', 'column', field.name, schema, entry.name),
          type: field.type,
          nullable: field.nullable === 0 && field.pk === 0,
          sequential: rowid && field.pk === 1,
          generated: field.hidden !== 0,
          ...(field.default_value === null ? {} : { default: field.default_value }),
        })
      if (pk.length > 0) {
        const declared = parsed.nodes.find(
          (candidate) => candidate.kind === 'primary-key' && candidate.generated === false,
        )
        nodes.push({
          ...node('sqlite', 'primary-key', declared?.name ?? 'PRIMARY', schema, entry.name),
          columns: pk.map((field) => field.name),
          generated: declared === undefined,
          explicit: declared !== undefined,
        })
      }
      for (const index of indexes) {
        const keys = await rows(
          db,
          sql<{ name: string | null }>`
          SELECT name FROM pragma_index_xinfo(${index.name}, ${schema}) WHERE "key" = 1 ORDER BY seqno
        `,
        )
        nodes.push({
          ...node('sqlite', 'index', index.name, schema, entry.name),
          columns: keys.flatMap((key) => (key.name === null ? [] : [key.name])),
          unique: index.unique === 1,
          partial: index.partial === 1 || keys.some((key) => key.name === null),
          generated: index.origin !== 'c',
        })
      }
      const links = await rows(
        db,
        sql<{ id: number; target: string; from_column: string; to_column: string | null }>`
        SELECT id, "table" AS target, "from" AS from_column, "to" AS to_column
        FROM pragma_foreign_key_list(${entry.name}, ${schema}) ORDER BY id, seq
      `,
      )
      for (const parts of grouped(links, (link) => String(link.id))) {
        const first = parts[0]!
        const columns = parts.map((part) => part.from_column)
        const declared = parsed.nodes.find(
          (candidate) =>
            candidate.kind === 'foreign-key' &&
            candidate.generated === false &&
            candidate.columns?.join('\0') === columns.join('\0') &&
            candidate.targetTable === first.target,
        )
        nodes.push({
          ...node('sqlite', 'foreign-key', declared?.name ?? 'fk_' + first.id, schema, entry.name),
          columns,
          targetTable: first.target,
          targetSchema: schema,
          ...(parts.some((part) => part.to_column === null)
            ? {}
            : { targetColumns: parts.map((part) => part.to_column!) }),
          generated: declared === undefined,
          explicit: declared !== undefined,
        })
      }
      for (const constraint of parsed.nodes.filter(
        (candidate) => candidate.kind === 'check' || candidate.kind === 'unique',
      )) {
        const { source: _source, ...evidence } = constraint
        nodes.push({
          ...evidence,
          origin: 'catalog',
          schema,
          table: entry.name,
          identity: identity(schema, entry.name, constraint.name),
        })
      }
      gaps.push(
        ...parsed.gaps.map((gap) => ({
          message: gap.message,
          identity: identity(schema, entry.name),
        })),
      )
    }
  }
  if (namespaces)
    for (const name of namespaces) {
      if (!selected.includes(name))
        gaps.push({
          message: 'Configured SQLite database is absent or unavailable',
          identity: name,
        })
    }
  return {
    nodes,
    gaps,
    capabilities: [
      'schemas',
      'tables',
      'columns',
      'primary-keys',
      'foreign-keys',
      'indexes',
      'views',
      'triggers',
      'constraints',
      ...columnCapabilities,
      ...keyCapabilities,
      'index:partial',
      'constraint:explicit-name',
    ],
  }
}
