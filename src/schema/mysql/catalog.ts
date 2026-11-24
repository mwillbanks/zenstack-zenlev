import { sql } from 'kysely'
import type { SchemaDiagnostic, SchemaIndex, SchemaTable } from '../model'
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

export async function mysqlTable(
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
        : [
              'char',
              'varchar',
              'text',
              'tinytext',
              'mediumtext',
              'longtext',
              'enum',
              'set',
              'date',
              'datetime',
              'timestamp',
              'time',
            ].includes(field.data_type) && !field.extra.includes('DEFAULT_GENERATED')
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
