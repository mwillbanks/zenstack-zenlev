import { sql, type CompiledQuery, type CreateTableBuilder, type Kysely } from 'kysely'
import type {
  SchemaColumn,
  SchemaEnum,
  SchemaForeignKey,
  SchemaIndex,
  SchemaModel,
  SchemaTable,
} from './model'
import type { Warning } from '../types'
import {
  key,
  compare,
  same,
  physicalType,
  comparableDefault,
  enumKey,
  foreignSignature,
  indexSignature,
} from './diff/comparison'
import {
  constraint,
  qualified,
  tableSchema,
  statement,
  defaultValue,
  renderType,
  renderColumn,
  actions,
  foreignName,
  foreignTarget,
  indexName,
} from './diff/sql'

export interface SqlStatement {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

export interface SchemaOperation {
  readonly id: string
  readonly kind: string
  readonly table?: string
  readonly up: readonly SqlStatement[]
  readonly down?: readonly SqlStatement[]
  readonly warnings: readonly Warning[]
}

export interface SchemaBlocker {
  readonly code: string
  readonly message: string
  readonly table?: string
  readonly column?: string
}

export interface MissingTable {
  readonly id: string
  readonly name: string
  readonly namespace?: string
  readonly referencedBy: readonly string[]
}

export interface SchemaChangeSet {
  readonly operations: readonly SchemaOperation[]
  readonly warnings: readonly Warning[]
  readonly missingTables: readonly MissingTable[]
  readonly blockers: readonly SchemaBlocker[]
}

export interface ChangeSetOptions {
  readonly db: Kysely<any>
  readonly dropMissingTables?: 'apply' | 'skip'
  /** Exact qualified table keys approved for removal. This overrides the global decision. */
  readonly dropTables?: readonly string[]
  readonly excludeViews?: boolean
}

function warning(code: Warning['code'], message: string, table: string): Warning {
  return { code, message, details: { table } }
}

/** Compile an ordered, reviewable change set without executing database operations. */
export function buildChangeSet(
  from: SchemaModel,
  to: SchemaModel,
  options: ChangeSetOptions,
): SchemaChangeSet {
  if (from.dialect !== to.dialect) throw new Error('Schema dialects must match')
  const { db } = options
  const dialect = to.dialect
  const typeExpression = (column: SchemaColumn) => renderType(column, dialect, to.enums)
  const configureColumn = (column: SchemaColumn, inline: boolean) =>
    renderColumn(column, inline, dialect)
  const operations: SchemaOperation[] = []
  const blockers: SchemaBlocker[] = [...from.unsupported, ...to.unsupported].map(
    ({ code, message }) => ({
      code,
      message: message + '. Use an explicit migration for this schema feature.',
    }),
  )
  const missingTables: MissingTable[] = []
  const ambiguousNames = new Set(
    [...from.tables, ...to.tables].filter((table) => /[.:]/.test(table.name)).map(key),
  )
  for (const name of [...ambiguousNames].sort(compare)) {
    blockers.push({
      code: 'AMBIGUOUS_TABLE_NAME',
      table: name,
      message: 'Table names containing dots or colons require an explicit migration.',
    })
  }
  const visible = (table: SchemaTable) =>
    !ambiguousNames.has(key(table)) && (!(options.excludeViews ?? true) || !table.isView)
  const oldTables = new Map(from.tables.filter(visible).map((table) => [key(table), table]))
  const newTables = new Map(to.tables.filter(visible).map((table) => [key(table), table]))
  const dropping = new Set<string>()
  const add = (
    kind: string,
    name: string,
    up: readonly SqlStatement[],
    down?: readonly SqlStatement[],
    warnings: readonly Warning[] = [],
  ) => {
    operations.push({
      id: kind + ':' + name,
      kind,
      table: name.split(':')[0]!,
      up,
      ...(down ? { down } : {}),
      warnings,
    })
  }
  const block = (code: string, message: string, table?: string, column?: string) => {
    blockers.push({
      code,
      message: message + '. Use an explicit migration.',
      ...(table ? { table } : {}),
      ...(column ? { column } : {}),
    })
  }
  const safe = (table: string, run: () => void) => {
    try {
      run()
    } catch (error) {
      block('UNSUPPORTED_DDL', error instanceof Error ? error.message : String(error), table)
    }
  }
  const compile = (query: { compile(executor: Kysely<any>): CompiledQuery }) =>
    statement(query.compile(db))

  const dropIndex = (table: SchemaTable, index: SchemaIndex): SqlStatement => {
    const name = indexName(table, index)
    if (dialect === 'postgresql' && index.constraint)
      return compile(tableSchema(db, table).alterTable(table.name).dropConstraint(name))
    return dialect === 'mysql'
      ? compile(tableSchema(db, table).alterTable(table.name).dropIndex(name))
      : compile(tableSchema(db, table).dropIndex(name))
  }
  const createIndex = (table: SchemaTable, index: SchemaIndex): SqlStatement => {
    if (dialect === 'postgresql' && index.constraint)
      return compile(
        tableSchema(db, table)
          .alterTable(table.name)
          .addUniqueConstraint(indexName(table, index), [...index.columns]),
      )
    let builder = tableSchema(db, table)
      .createIndex(indexName(table, index))
      .on(table.name)
      .columns([...index.columns])
    if (index.unique) builder = builder.unique()
    return compile(builder)
  }
  const dropForeign = (table: SchemaTable, fk: SchemaForeignKey) =>
    dialect === 'mysql'
      ? compile(
          sql`alter table ${qualified(table)} drop foreign key ${sql.id(foreignName(table, fk))}`,
        )
      : compile(
          tableSchema(db, table).alterTable(table.name).dropConstraint(foreignName(table, fk)),
        )
  const addForeign = (table: SchemaTable, fk: SchemaForeignKey): SqlStatement => {
    let builder = tableSchema(db, table)
      .alterTable(table.name)
      .addForeignKeyConstraint(foreignName(table, fk), [...fk.columns], foreignTarget(fk), [
        ...fk.targetColumns,
      ])
    if (fk.onDelete) builder = builder.onDelete(actions[fk.onDelete])
    if (fk.onUpdate) builder = builder.onUpdate(actions[fk.onUpdate])
    return compile(builder)
  }

  for (const table of [...oldTables.values()].sort((a, b) => compare(key(a), key(b)))) {
    const name = key(table)
    if (newTables.has(name)) continue
    const referencedBy = [...oldTables.values()]
      .filter((other) =>
        other.foreignKeys.some(
          (fk) =>
            key({
              name: fk.targetTable,
              ...(fk.targetNamespace ? { namespace: fk.targetNamespace } : {}),
            }) === name,
        ),
      )
      .map(key)
      .sort(compare)
    missingTables.push({
      id: name,
      name: table.name,
      ...(table.namespace ? { namespace: table.namespace } : {}),
      referencedBy,
    })
    if (
      options.dropTables ? options.dropTables.includes(name) : options.dropMissingTables === 'apply'
    )
      dropping.add(name)
  }
  if (options.dropTables) {
    for (const name of options.dropTables) {
      if (!missingTables.some((table) => table.id === name))
        throw new Error('Unknown missing table selection: ' + name)
    }
  }

  if (dialect === 'postgresql') {
    for (const name of [...new Set(to.namespaces)].sort(compare)) {
      if (!from.namespaces.includes(name)) {
        add('create-schema', name, [compile(db.schema.createSchema(name))])
      }
    }
  } else if (to.namespaces.some((namespace) => !from.namespaces.includes(namespace))) {
    block('UNSUPPORTED_NAMESPACE', 'Creating database namespaces requires explicit provisioning')
  }
  const oldEnums = new Map(from.enums.map((item) => [key(item), item]))
  const newEnums = new Map(to.enums.map((item) => [key(item), item]))
  const enumSql = (item: SchemaEnum) =>
    compile(
      sql`create type ${qualified(item)} as enum (${sql.join(item.values.map((value) => sql.lit(value)))})`,
    )
  if (dialect === 'postgresql') {
    for (const item of [...newEnums.values()].sort((a, b) => compare(key(a), key(b)))) {
      const old = oldEnums.get(key(item))
      if (!old)
        add('create-enum', key(item), [enumSql(item)], [compile(sql`drop type ${qualified(item)}`)])
      else if (!same(old.values, item.values))
        block('ENUM_REWRITE', 'Enum value changes require an explicit data conversion', key(item))
    }
  }

  if (dialect === 'mysql') {
    for (const item of newEnums.values()) {
      const old = oldEnums.get(key(item))
      if (old && !same(old.values, item.values))
        block('ENUM_REWRITE', 'Enum value changes require an explicit data conversion', key(item))
    }
  }

  const delayedForeign: Array<{ table: SchemaTable; fk: SchemaForeignKey }> = []
  for (const table of [...newTables.values()].sort((a, b) => compare(key(a), key(b)))) {
    const name = key(table)
    if (table.isView) {
      block('VIEW_DEFINITION', 'View definitions are not available for safe DDL generation', name)
      continue
    }
    const old = oldTables.get(name)
    safe(name, () => {
      if (!old) {
        let builder: CreateTableBuilder<string, string> = tableSchema(db, table).createTable(
          table.name,
        )
        for (const column of table.columns) {
          const inline =
            dialect === 'sqlite' &&
            column.autoIncrement &&
            table.primaryKey.length === 1 &&
            table.primaryKey[0] === column.name
          builder = builder.addColumn(
            column.name,
            typeExpression(column),
            configureColumn(column, inline),
          )
        }
        const inlinePrimary =
          dialect === 'sqlite' &&
          table.columns.some(
            (column) =>
              column.autoIncrement &&
              table.primaryKey.length === 1 &&
              table.primaryKey[0] === column.name,
          )
        if (table.primaryKey.length && !inlinePrimary) {
          builder = builder.addPrimaryKeyConstraint(
            table.primaryKeyName ?? constraint(table, 'pk', table.primaryKey),
            [...table.primaryKey],
          )
        }
        if (dialect === 'sqlite') {
          for (const fk of table.foreignKeys) {
            builder = builder.addForeignKeyConstraint(
              foreignName(table, fk),
              [...fk.columns],
              foreignTarget(fk),
              [...fk.targetColumns],
              (constraintBuilder) => {
                let next = constraintBuilder
                if (fk.onDelete) next = next.onDelete(actions[fk.onDelete])
                if (fk.onUpdate) next = next.onUpdate(actions[fk.onUpdate])
                return next
              },
            )
          }
        } else {
          delayedForeign.push(...table.foreignKeys.map((fk) => ({ table, fk })))
        }
        add(
          'create-table',
          name,
          [compile(builder)],
          [compile(tableSchema(db, table).dropTable(table.name))],
        )
        for (const index of table.indexes) {
          const warnings = index.unique
            ? [warning('UNIQUE_CONSTRAINT', 'Creating a unique index requires unique values', name)]
            : []
          add(
            'create-index',
            name + ':' + indexName(table, index),
            [createIndex(table, index)],
            [dropIndex(table, index)],
            warnings,
          )
        }
        return
      }
      if (!same(old.primaryKey, table.primaryKey))
        block('PRIMARY_KEY_REWRITE', 'Changing the primary key requires an explicit rewrite', name)
      const oldColumns = new Map(old.columns.map((column) => [column.name, column]))
      const newColumns = new Map(table.columns.map((column) => [column.name, column]))
      const removedColumns = old.columns.filter((column) => !newColumns.has(column.name))
      const desiredForeign = new Set(table.foreignKeys.map(foreignSignature))
      for (const fk of old.foreignKeys) {
        if (!desiredForeign.has(foreignSignature(fk))) {
          if (dialect === 'sqlite' || !fk.name)
            block(
              'FOREIGN_KEY_REWRITE',
              'Removing this foreign key requires a named constraint and ALTER support',
              name,
            )
          else
            add(
              'drop-foreign-key',
              name + ':' + foreignName(old, fk),
              [dropForeign(old, fk)],
              [addForeign(old, fk)],
            )
        }
      }
      const desiredIndexes = new Set(table.indexes.map(indexSignature))
      for (const index of old.indexes) {
        if (!desiredIndexes.has(indexSignature(index))) {
          if (!index.name)
            block(
              'UNNAMED_INDEX',
              'Removing an unnamed live index requires manual identification',
              name,
            )
          else
            add(
              'drop-index',
              name + ':' + indexName(old, index),
              [dropIndex(old, index)],
              [createIndex(old, index)],
            )
        }
      }
      for (const column of removedColumns) {
        const retainedTables = [
          ...newTables.values(),
          ...[...oldTables.values()].filter(
            (other) => !newTables.has(key(other)) && !dropping.has(key(other)),
          ),
        ]
        const incoming = retainedTables.some((other) =>
          other.foreignKeys.some(
            (fk) =>
              key({
                name: fk.targetTable,
                ...(fk.targetNamespace ? { namespace: fk.targetNamespace } : {}),
              }) === name && fk.targetColumns.includes(column.name),
          ),
        )
        if (
          incoming ||
          table.foreignKeys.some((fk) => fk.columns.includes(column.name)) ||
          table.primaryKey.includes(column.name) ||
          table.indexes.some((index) => index.columns.includes(column.name))
        ) {
          block(
            'COLUMN_DEPENDENCY',
            'A removed column remains referenced by a desired constraint',
            name,
            column.name,
          )
          continue
        }
        if (
          dialect === 'sqlite' &&
          (old.primaryKey.includes(column.name) ||
            old.indexes.some((index) => index.columns.includes(column.name)) ||
            old.foreignKeys.some((fk) => fk.columns.includes(column.name)))
        ) {
          block(
            'SQLITE_TABLE_REWRITE',
            'Dropping a constrained SQLite column requires a table rebuild',
            name,
            column.name,
          )
          continue
        }
        add(
          'drop-column',
          name + ':' + column.name,
          [compile(tableSchema(db, table).alterTable(table.name).dropColumn(column.name))],
          undefined,
          [warning('DROP_COLUMN', 'Dropping column ' + column.name + ' deletes its values', name)],
        )
      }
      for (const column of table.columns) {
        const previous = oldColumns.get(column.name)
        if (!previous) {
          if (
            column.autoIncrement ||
            (dialect === 'sqlite' &&
              !column.nullable &&
              (!column.default ||
                column.default.kind !== 'literal' ||
                column.default.value === null))
          ) {
            block(
              'COLUMN_BACKFILL',
              'Adding this required column needs an explicit backfill or table rewrite',
              name,
              column.name,
            )
            continue
          }
          add(
            'add-column',
            name + ':' + column.name,
            [
              compile(
                tableSchema(db, table)
                  .alterTable(table.name)
                  .addColumn(column.name, typeExpression(column), configureColumn(column, false)),
              ),
            ],
            [compile(tableSchema(db, table).alterTable(table.name).dropColumn(column.name))],
          )
          continue
        }
        const changedType =
          (!(dialect === 'postgresql' && previous.enumName && column.enumName) &&
            physicalType(previous.type, dialect) !== physicalType(column.type, dialect)) ||
          enumKey(previous) !== enumKey(column) ||
          previous.array !== column.array
        const changedDefault = !same(
          comparableDefault(previous, dialect),
          comparableDefault(column, dialect),
        )
        const changedNull = previous.nullable !== column.nullable
        if (
          !changedType &&
          !changedDefault &&
          !changedNull &&
          previous.autoIncrement === column.autoIncrement
        )
          continue
        if (dialect === 'sqlite' || previous.autoIncrement !== column.autoIncrement) {
          block(
            'COLUMN_REWRITE',
            'Changing this column requires an explicit table rewrite',
            name,
            column.name,
          )
          continue
        }
        const warnings =
          changedType || (changedNull && !column.nullable)
            ? [
                warning(
                  'TYPE_NARROWING',
                  'Column conversion or NOT NULL may reject or truncate existing values',
                  name,
                ),
              ]
            : []
        if (dialect === 'mysql') {
          add(
            'alter-column',
            name + ':' + column.name,
            [
              compile(
                tableSchema(db, table)
                  .alterTable(table.name)
                  .modifyColumn(
                    column.name,
                    typeExpression(column),
                    configureColumn(column, false),
                  ),
              ),
            ],
            undefined,
            warnings,
          )
        } else {
          const up: SqlStatement[] = []
          if (changedType)
            up.push(
              compile(
                tableSchema(db, table)
                  .alterTable(table.name)
                  .alterColumn(column.name, (alter) => alter.setDataType(typeExpression(column))),
              ),
            )
          if (changedDefault)
            up.push(
              compile(
                tableSchema(db, table)
                  .alterTable(table.name)
                  .alterColumn(column.name, (alter) =>
                    column.default
                      ? alter.setDefault(defaultValue(column.default, dialect))
                      : alter.dropDefault(),
                  ),
              ),
            )
          if (changedNull)
            up.push(
              compile(
                tableSchema(db, table)
                  .alterTable(table.name)
                  .alterColumn(column.name, (alter) =>
                    column.nullable ? alter.dropNotNull() : alter.setNotNull(),
                  ),
              ),
            )
          add('alter-column', name + ':' + column.name, up, undefined, warnings)
        }
      }
      const originalIndexes = new Set(old.indexes.map(indexSignature))
      for (const index of table.indexes) {
        if (!originalIndexes.has(indexSignature(index))) {
          add(
            'create-index',
            name + ':' + indexName(table, index),
            [createIndex(table, index)],
            [dropIndex(table, index)],
            index.unique
              ? [
                  warning(
                    'UNIQUE_CONSTRAINT',
                    'Creating a unique index requires unique values',
                    name,
                  ),
                ]
              : [],
          )
        }
      }
      const originalForeign = new Set(old.foreignKeys.map(foreignSignature))
      for (const fk of table.foreignKeys) {
        if (!originalForeign.has(foreignSignature(fk))) {
          if (dialect === 'sqlite')
            block(
              'SQLITE_FOREIGN_KEY',
              'Adding a foreign key requires a SQLite table rebuild',
              name,
            )
          else delayedForeign.push({ table, fk })
        }
      }
    })
  }

  for (const { table, fk } of delayedForeign) {
    safe(key(table), () =>
      add(
        'add-foreign-key',
        key(table) + ':' + foreignName(table, fk),
        [addForeign(table, fk)],
        [dropForeign(table, fk)],
      ),
    )
  }
  for (const name of [...dropping].sort(compare)) {
    const table = oldTables.get(name)!
    if (table.isView) {
      block('VIEW_DEFINITION', 'Removing a view requires an explicit migration', name)
      continue
    }
    const preservedIncoming = [...newTables.values()].some((other) =>
      other.foreignKeys.some(
        (fk) =>
          key({
            name: fk.targetTable,
            ...(fk.targetNamespace ? { namespace: fk.targetNamespace } : {}),
          }) === name,
      ),
    )
    const unmanagedIncoming = [...oldTables.values()].some(
      (other) =>
        !dropping.has(key(other)) &&
        !newTables.has(key(other)) &&
        other.foreignKeys.some(
          (fk) =>
            key({
              name: fk.targetTable,
              ...(fk.targetNamespace ? { namespace: fk.targetNamespace } : {}),
            }) === name,
        ),
    )
    if (preservedIncoming || unmanagedIncoming) {
      block('DROP_TABLE_DEPENDENCY', 'A preserved table references the selected table drop', name)
      continue
    }
    for (const fk of table.foreignKeys) {
      if (dialect !== 'sqlite' && fk.name) {
        safe(name, () =>
          add('drop-foreign-key', name + ':' + foreignName(table, fk), [dropForeign(table, fk)]),
        )
      }
    }
    add('drop-table', name, [compile(tableSchema(db, table).dropTable(table.name))], undefined, [
      warning('DROP_TABLE', 'Dropping table ' + name + ' deletes its data', name),
    ])
  }
  if (dialect === 'postgresql') {
    for (const item of oldEnums.values()) {
      if (!newEnums.has(key(item))) {
        const retained = [
          ...newTables.values(),
          ...[...oldTables.values()].filter(
            (table) => !dropping.has(key(table)) && !newTables.has(key(table)),
          ),
        ].some((table) => table.columns.some((column) => enumKey(column) === key(item)))
        if (retained)
          block('ENUM_DEPENDENCY', 'A preserved table still uses the removed enum', key(item))
        else add('drop-enum', key(item), [compile(sql`drop type ${qualified(item)}`)])
      }
    }
  }

  const ranks: Record<string, number> = {
    'create-schema': 0,
    'create-enum': 1,
    'drop-foreign-key': 2,
    'drop-index': 3,
    'create-table': 4,
    'drop-column': 5,
    'add-column': 6,
    'alter-column': 7,
    'create-index': 8,
    'add-foreign-key': 9,
    'drop-table': 10,
    'drop-enum': 11,
  }
  const dropOrder = new Map<string, number>()
  const visiting = new Set<string>()
  const visitDrop = (name: string) => {
    if (visiting.has(name)) {
      if (dialect === 'sqlite')
        block('SQLITE_DROP_CYCLE', 'Cyclic table drops require an explicit SQLite rebuild', name)
      return
    }
    if (dropOrder.has(name)) return
    visiting.add(name)
    const incoming = [...dropping]
      .filter(
        (other) =>
          other !== name &&
          oldTables.get(other)!.foreignKeys.some(
            (fk) =>
              key({
                name: fk.targetTable,
                ...(fk.targetNamespace ? { namespace: fk.targetNamespace } : {}),
              }) === name,
          ),
      )
      .sort(compare)
    for (const child of incoming) visitDrop(child)
    visiting.delete(name)
    dropOrder.set(name, dropOrder.size)
  }
  for (const name of [...dropping].sort(compare)) visitDrop(name)
  operations.sort((a, b) => {
    const rank = ranks[a.kind]! - ranks[b.kind]!
    if (rank) return rank
    if (a.kind === 'drop-table') return dropOrder.get(a.table!)! - dropOrder.get(b.table!)!
    return compare(a.id, b.id)
  })
  return {
    operations,
    warnings: operations.flatMap((operation) => operation.warnings),
    missingTables,
    blockers,
  }
}
