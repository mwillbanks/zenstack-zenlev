import { afterEach, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CompiledQuery, Kysely, MysqlDialect, PostgresDialect } from 'kysely'
import { buildChangeSet, type ChangeSetOptions, type SchemaChangeSet } from '../../src/schema/diff'
import type {
  SchemaColumn,
  SchemaForeignKey,
  SchemaIndex,
  SchemaModel,
  SchemaTable,
} from '../../src/schema/model'
import type { Dialect } from '../../src/types'
import { createBunSqliteDialect } from '../fixtures/sqlite'

const databases: Kysely<any>[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()))
})

function database(dialect: Dialect = 'sqlite') {
  const connect = mock(() => {
    throw new Error('A planner cannot open a database connection')
  })
  const db = new Kysely<any>({
    dialect:
      dialect === 'sqlite'
        ? createBunSqliteDialect(new Database(':memory:'))
        : dialect === 'postgresql'
          ? new PostgresDialect({ pool: { connect, end: async () => {} } as never })
          : new MysqlDialect({
              pool: { getConnection: connect, end: (done: () => void) => done() } as never,
            }),
  })
  databases.push(db)
  return db
}

function column(name = 'id', extra: Partial<SchemaColumn> = {}): SchemaColumn {
  return {
    name,
    field: name,
    type: 'integer',
    nullable: false,
    autoIncrement: false,
    array: false,
    ...extra,
  }
}
function table(name = 'items', extra: Partial<SchemaTable> = {}): SchemaTable {
  return {
    name,
    model: name,
    isView: false,
    columns: [column()],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    ...extra,
  }
}
function model(
  dialect: Dialect = 'sqlite',
  tables: readonly SchemaTable[] = [],
  extra: Partial<SchemaModel> = {},
): SchemaModel {
  return {
    dialect,
    sourcePath: 'test.zmodel',
    namespaces: [],
    tables,
    enums: [],
    warnings: [],
    unsupported: [],
    ...extra,
  }
}
function diff(
  from: SchemaModel,
  to: SchemaModel,
  options: Omit<ChangeSetOptions, 'db'> = {},
): SchemaChangeSet {
  return buildChangeSet(from, to, { db: database(to.dialect), ...options })
}
function sqlOf(changes: SchemaChangeSet): string {
  return changes.operations.flatMap((operation) => operation.up.map(({ sql }) => sql)).join('; ')
}
const foreign: SchemaForeignKey = {
  name: 'child_parent_fk',
  columns: ['parent_id'],
  targetTable: 'parents',
  targetColumns: ['id'],
  onDelete: 'Cascade',
  onUpdate: 'Restrict',
}

test('compiles and executes SQLite creates with defaults, constraints and indexes', async () => {
  const db = database()
  const target = model('sqlite', [
    table('parents'),
    table('children', {
      columns: [
        column('id', { autoIncrement: true }),
        column('parent_id'),
        column('label', { type: 'text', default: { kind: 'literal', value: "it's safe" } }),
        column('created', { type: 'datetime', default: { kind: 'sql', sql: 'CURRENT_TIMESTAMP' } }),
      ],
      foreignKeys: [foreign],
      indexes: [
        { columns: ['label'], unique: true },
        { name: 'child_parent', columns: ['parent_id'], unique: false },
      ],
    }),
  ])
  const plan = buildChangeSet(model(), target, { db })
  expect(plan.blockers).toEqual([])
  expect(plan.warnings.map(({ code }) => code)).toEqual(['UNIQUE_CONSTRAINT'])
  for (const operation of plan.operations) {
    for (const query of operation.up)
      await db.executeQuery(CompiledQuery.raw(query.sql, [...query.parameters]))
  }
  await db.insertInto('parents').values({ id: 1 }).execute()
  await db.insertInto('children').values({ parent_id: 1 }).execute()
  const result = await db.selectFrom('children').select(['id', 'label']).execute()
  expect(result).toEqual([{ id: 1, label: "it's safe" }])
  expect(plan.operations.every(({ down }) => down?.length)).toBe(true)
})

test.each(['postgresql', 'mysql'] as const)(
  'compiles %s identity, enum, indexes and deferred foreign keys',
  (dialect) => {
    const ns = dialect === 'postgresql' ? 'app' : undefined
    const decorate = ns ? { namespace: ns } : {}
    const definition = { name: 'State', values: ["it's active", 'done'], ...decorate }
    const target = model(
      dialect,
      [
        table('parents', decorate),
        table('children', {
          ...decorate,
          columns: [
            column('id', { autoIncrement: true }),
            column('parent_id'),
            column('state', {
              enumName: 'State',
              type: dialect === 'mysql' ? "enum('bad')" : 'State',
            }),
          ],
          foreignKeys: [{ ...foreign, ...(ns ? { targetNamespace: ns } : {}) }],
          indexes: [{ name: 'child_parent', columns: ['parent_id'], unique: false }],
        }),
      ],
      { enums: [definition], namespaces: ns ? [ns] : [] },
    )
    const plan = diff(model(dialect), target)
    expect(plan.blockers).toEqual([])
    expect(sqlOf(plan)).toContain(
      dialect === 'postgresql' ? 'generated by default as identity' : 'auto_increment',
    )
    expect(plan.operations.at(-1)?.kind).toBe('add-foreign-key')
    expect(plan.operations.some(({ kind }) => kind === 'create-enum')).toBe(
      dialect === 'postgresql',
    )
    expect(sqlOf(plan)).toContain(
      dialect === 'postgresql' ? '"app"."State"' : "enum('it''s active', 'done')",
    )
  },
)

test('requires matching dialects and rejects unknown selected drops', () => {
  expect(() => diff(model(), model('mysql'))).toThrow('dialects must match')
  expect(() => diff(model(), model(), { dropTables: ['missing'] })).toThrow('Unknown missing table')
})

test('orders SQL independently of model discovery and safely quotes names', () => {
  const tables = [table('z"quoted'), table('alpha')]
  const a = diff(model(), model('sqlite', tables))
  const b = diff(model(), model('sqlite', tables.toReversed()))
  expect(a).toEqual(b)
  expect(sqlOf(a)).toContain('"z""quoted"')
  expect(diff(model('sqlite', tables), model('sqlite', tables)).operations).toEqual([])
})

test('reports unsupported source features and opts views into explicit blockers', () => {
  const diagnostic = {
    code: 'MANUAL',
    message: 'Needs custom SQL',
    source: { path: 'schema', line: 1, column: 1 },
  }
  const source = model('sqlite', [table('v', { isView: true })], { unsupported: [diagnostic] })
  expect(diff(source, model()).missingTables).toEqual([])
  expect(diff(source, model()).blockers[0]?.message).toContain('explicit migration')
  expect(diff(model(), source, { excludeViews: false }).blockers.map(({ code }) => code)).toContain(
    'VIEW_DEFINITION',
  )
  expect(
    diff(source, model(), { excludeViews: false, dropMissingTables: 'apply' }).blockers.map(
      ({ code }) => code,
    ),
  ).toContain('VIEW_DEFINITION')
})

test('collects explicit table drop candidates and preserves skipped tables', () => {
  const old = model('sqlite', [table('first'), table('second')])
  expect(diff(old, model()).missingTables.map(({ id }) => id)).toEqual(['first', 'second'])
  expect(diff(old, model()).operations).toEqual([])
  expect(diff(old, model(), { dropMissingTables: 'skip' }).operations).toEqual([])
  const chosen = diff(old, model(), { dropMissingTables: 'apply', dropTables: ['second'] })
  expect(chosen.operations.map(({ id }) => id)).toEqual(['drop-table:second'])
  expect(chosen.warnings.map(({ code }) => code)).toEqual(['DROP_TABLE'])
  expect(chosen.operations[0]?.down).toBeUndefined()
})

test('blocks table drops referenced by preserved modeled or skipped tables', () => {
  const parent = table('parents')
  const child = table('children', {
    columns: [column(), column('parent_id')],
    foreignKeys: [foreign],
  })
  const old = model('sqlite', [parent, child])
  const preserved = diff(old, model('sqlite', [child]), { dropMissingTables: 'apply' })
  expect(preserved.blockers.map(({ code }) => code)).toContain('DROP_TABLE_DEPENDENCY')
  expect(preserved.missingTables[0]?.referencedBy).toEqual(['children'])
  const skipped = diff(old, model(), { dropTables: ['parents'] })
  expect(skipped.blockers.map(({ code }) => code)).toContain('DROP_TABLE_DEPENDENCY')
})

test.each(['postgresql', 'mysql'] as const)(
  'removes %s foreign constraints before table drops',
  (dialect) => {
    const old = model(dialect, [
      table('parents'),
      table('children', { columns: [column(), column('parent_id')], foreignKeys: [foreign] }),
    ])
    const plan = diff(old, model(dialect), { dropMissingTables: 'apply' })
    expect(plan.blockers).toEqual([])
    expect(plan.operations[0]?.kind).toBe('drop-foreign-key')
    if (dialect === 'mysql') expect(sqlOf(plan)).toContain('drop foreign key')
  },
)

test.each(['app.items', 'items:archived'])('blocks ambiguous physical table names: %s', (name) => {
  const changes = diff(model(), model('sqlite', [table(name)]))
  expect(changes.blockers.map(({ code }) => code)).toEqual(['AMBIGUOUS_TABLE_NAME'])
  expect(changes.operations).toEqual([])
})

test('creates PostgreSQL namespaces and refuses implicit MySQL database provisioning', () => {
  const pg = diff(model('postgresql'), model('postgresql', [], { namespaces: ['app'] }))
  expect(sqlOf(pg)).toContain('create schema "app"')
  expect(diff(model('mysql'), model('mysql', [], { namespaces: ['app'] })).blockers[0]?.code).toBe(
    'UNSUPPORTED_NAMESPACE',
  )
})

test('protects enum conversions and retained enum dependencies', () => {
  const definition = { name: 'State', namespace: 'app', values: ['a'] }
  const old = model(
    'postgresql',
    [
      table('retained', {
        columns: [column('state', { enumName: 'State', enumNamespace: 'app', type: 'State' })],
      }),
    ],
    { enums: [definition] },
  )
  const changed = diff(
    old,
    model('postgresql', old.tables, { enums: [{ ...definition, values: ['b'] }] }),
  )
  expect(changed.blockers.map(({ code }) => code)).toContain('ENUM_REWRITE')
  expect(diff(old, model('postgresql')).blockers.map(({ code }) => code)).toContain(
    'ENUM_DEPENDENCY',
  )
  const dropped = diff(old, model('postgresql'), { dropMissingTables: 'apply' })
  expect(dropped.operations.at(-1)?.kind).toBe('drop-enum')
})

test('requires explicit conversion for MySQL enum value changes', () => {
  const original = { name: 'State', values: ['active'] }
  const updated = { ...original, values: ['active', 'archived'] }
  const tables = [table('items', { columns: [column('state', { enumName: 'State' })] })]
  const plan = diff(
    model('mysql', tables, { enums: [original] }),
    model('mysql', tables, { enums: [updated] }),
  )
  expect(plan.blockers.map(({ code }) => code)).toEqual(['ENUM_REWRITE'])
})

test.each([
  column('bad', { type: 'text; DROP TABLE users' }),
  column('bad', { type: 'text primary key' }),
  column('bad', { default: { kind: 'sql', sql: 'malicious()' } }),
  column('bad', { enumName: 'Unknown' }),
])('blocks unsafe or unsupported DDL fragments', (bad) => {
  expect(
    diff(model(), model('sqlite', [table('items', { columns: [bad], primaryKey: [] })])).blockers[0]
      ?.code,
  ).toBe('UNSUPPORTED_DDL')
})

test.each(['varchar(80)', 'character varying(80)'])(
  'normalizes PostgreSQL varchar spelling %s',
  (type) => {
    const before = model('postgresql', [table('items', { columns: [column('id', { type })] })])
    const after = model('postgresql', [
      table('items', { columns: [column('id', { type: 'varchar(80)' })] }),
    ])
    expect(diff(before, after).operations).toEqual([])
  },
)

test('normalizes implicit and explicit MySQL nullable NULL defaults', () => {
  const implicit = model('mysql', [table('items', { columns: [column('id', { nullable: true })] })])
  const explicit = model('mysql', [
    table('items', {
      columns: [column('id', { nullable: true, default: { kind: 'literal', value: null } })],
    }),
  ])
  expect(diff(implicit, explicit).operations).toEqual([])
  expect(diff(explicit, implicit).operations).toEqual([])
})

test('keeps qualified enum identities distinct when identifiers contain dots or quotes', () => {
  const definitions = [
    { namespace: 'app', name: 'foo.bar', values: ['first'] },
    { namespace: 'app.foo', name: 'bar', values: ['second'] },
    { name: 'literal"quote', values: ['third'] },
  ]
  const target = model(
    'postgresql',
    [
      table('first', {
        columns: [column('id', { type: 'foo.bar', enumName: 'foo.bar', enumNamespace: 'app' })],
      }),
      table('second', {
        columns: [column('id', { type: 'bar', enumName: 'bar', enumNamespace: 'app.foo' })],
      }),
      table('third', {
        columns: [column('id', { type: 'literal"quote', enumName: 'literal"quote' })],
      }),
    ],
    { namespaces: ['app', 'app.foo'], enums: definitions },
  )
  const changes = diff(model('postgresql'), target)
  expect(changes.blockers).toEqual([])
  expect(changes.operations.filter(({ kind }) => kind === 'create-enum')).toHaveLength(3)
  expect(sqlOf(changes)).toContain('"id" "app"."foo.bar"')
  expect(sqlOf(changes)).toContain('"id" "app.foo"."bar"')
  expect(sqlOf(changes)).toContain('"id" "literal""quote"')
  expect(diff(target, target).operations).toEqual([])
})

test.each([
  ['sqlite', 'now()', false],
  ['sqlite', 'uuid()', false],
  ['sqlite', 'gen_random_uuid()', false],
  ['sqlite', 'CURRENT_TIMESTAMP(3)', false],
  ['sqlite', 'CURRENT_TIMESTAMP', true],
  ['sqlite', 'CURRENT_DATE', true],
  ['sqlite', 'CURRENT_TIME', true],
  ['postgresql', 'now()', true],
  ['postgresql', 'gen_random_uuid()', true],
  ['postgresql', 'uuid_generate_v4()', true],
  ['postgresql', 'CURRENT_TIMESTAMP(3)', true],
  ['postgresql', 'uuid()', false],
  ['mysql', 'uuid()', true],
  ['mysql', 'now()', true],
  ['mysql', 'CURRENT_TIMESTAMP(3)', true],
  ['mysql', 'CURRENT_DATE', true],
  ['mysql', 'CURRENT_TIME', true],
  ['mysql', 'gen_random_uuid()', false],
  ['mysql', 'uuid_generate_v4()', false],
] as const)('checks %s default expression %s before execution', (dialect, expression, accepted) => {
  const changes = diff(
    model(dialect),
    model(dialect, [
      table('items', {
        columns: [column('id', { type: 'text', default: { kind: 'sql', sql: expression } })],
      }),
    ]),
  )
  expect(changes.blockers.map(({ code }) => code)).toEqual(accepted ? [] : ['UNSUPPORTED_DDL'])
  if (accepted && dialect === 'mysql' && /^(uuid\(\)|CURRENT_DATE|CURRENT_TIME)$/.test(expression))
    expect(sqlOf(changes)).toContain('default (' + expression + ')')
})

test('adds nullable and literal-default SQLite columns with reversible SQL', () => {
  const old = table()
  const target = table('items', {
    columns: [
      ...old.columns,
      column('value', { type: 'text', nullable: true }),
      column('enabled', { type: 'boolean', default: { kind: 'literal', value: true } }),
    ],
  })
  const changes = diff(model('sqlite', [old]), model('sqlite', [target]))
  expect(changes.blockers).toEqual([])
  expect(changes.operations.map(({ kind }) => kind)).toEqual(['add-column', 'add-column'])
  expect(changes.operations.every(({ down }) => down?.[0]?.sql.includes('drop column'))).toBe(true)
})

test.each([
  column('value'),
  column('value', { default: { kind: 'literal', value: null } }),
  column('value', { autoIncrement: true }),
])('requires an explicit backfill for constrained SQLite additions', (added) => {
  expect(
    diff(
      model('sqlite', [table()]),
      model('sqlite', [table('items', { columns: [column(), added] })]),
    ).blockers[0]?.code,
  ).toBe('COLUMN_BACKFILL')
})

test('drops ordinary columns and refuses destructive implicit constraint rewrites', () => {
  const ordinary = table('items', { columns: [column(), column('value')] })
  const drop = diff(model('sqlite', [ordinary]), model('sqlite', [table()]))
  expect(drop.operations[0]?.kind).toBe('drop-column')
  expect(drop.operations[0]?.down).toBeUndefined()
  expect(drop.warnings[0]?.code).toBe('DROP_COLUMN')
  const old = table('items', {
    columns: [column(), column('value')],
    indexes: [{ name: 'unique_value', columns: ['value'], unique: true }],
  })
  const rewrite = diff(model('sqlite', [old]), model('sqlite', [table()]))
  expect(rewrite.blockers.map(({ code }) => code)).toContain('SQLITE_TABLE_REWRITE')
  const referenced = diff(
    model('sqlite', [old]),
    model('sqlite', [table('items', { indexes: old.indexes })]),
  )
  expect(referenced.blockers.map(({ code }) => code)).toContain('COLUMN_DEPENDENCY')
})

test('blocks SQLite column drops while local foreign keys still use the column', () => {
  const old = table('children', {
    columns: [column(), column('parent_id')],
    foreignKeys: [foreign],
  })
  const previous = model('sqlite', [old])
  const retainedKey = table('children', { foreignKeys: [foreign] })
  const retained = diff(previous, model('sqlite', [retainedKey]))
  expect(retained.blockers.map(({ code }) => code)).toContain('COLUMN_DEPENDENCY')
  const removed = diff(previous, model('sqlite', [table('children')]))
  expect(removed.blockers.map(({ code }) => code)).toContain('SQLITE_TABLE_REWRITE')
})

test('blocks removed columns referenced by another desired table', () => {
  const parent = table('parents', { columns: [column(), column('other')] })
  const child = table('children', { foreignKeys: [{ ...foreign, targetColumns: ['other'] }] })
  expect(
    diff(
      model('postgresql', [parent]),
      model('postgresql', [table('parents'), child]),
    ).blockers.map(({ code }) => code),
  ).toContain('COLUMN_DEPENDENCY')
})

test('blocks primary key changes and unnamed live index deletion', () => {
  const old = table('items', { indexes: [{ columns: ['id'], unique: true }] })
  const plan = diff(
    model('postgresql', [old]),
    model('postgresql', [table('items', { primaryKey: [] })]),
  )
  expect(plan.blockers.map(({ code }) => code)).toEqual(
    expect.arrayContaining(['PRIMARY_KEY_REWRITE', 'UNNAMED_INDEX']),
  )
})

test.each(['postgresql', 'mysql'] as const)(
  'compiles %s column alterations and index replacement',
  (dialect) => {
    const old = table('items', {
      columns: [
        column(),
        column('value', {
          type: 'varchar(100)',
          nullable: true,
          default: { kind: 'literal', value: 'old' },
        }),
      ],
      indexes: [{ name: 'old_idx', columns: ['value'], unique: false }],
    })
    const target = table('items', {
      columns: [
        column(),
        column('value', { type: 'varchar(20)', default: { kind: 'literal', value: 'new' } }),
      ],
      indexes: [{ name: 'new_idx', columns: ['value'], unique: true }],
    })
    const plan = diff(model(dialect, [old]), model(dialect, [target]))
    expect(plan.blockers).toEqual([])
    expect(plan.operations.map(({ kind }) => kind)).toEqual([
      'drop-index',
      'alter-column',
      'create-index',
    ])
    expect(plan.warnings.map(({ code }) => code)).toEqual(['TYPE_NARROWING', 'UNIQUE_CONSTRAINT'])
    const reverse = diff(model(dialect, [target]), model(dialect, [old]))
    expect(sqlOf(reverse)).toContain(dialect === 'postgresql' ? 'drop not null' : 'modify column')
    const noDefault = table('items', {
      columns: [column(), column('value', { type: 'varchar(20)' })],
      indexes: target.indexes,
    })
    expect(sqlOf(diff(model(dialect, [target]), model(dialect, [noDefault])))).toContain(
      dialect === 'postgresql' ? 'drop default' : 'modify column',
    )
  },
)

test('blocks SQLite type alteration and identity conversion', () => {
  const old = model('sqlite', [table()])
  const changed = model('sqlite', [table('items', { columns: [column('id', { type: 'text' })] })])
  expect(diff(old, changed).blockers.map(({ code }) => code)).toContain('COLUMN_REWRITE')
  expect(
    diff(
      model('postgresql', [table()]),
      model('postgresql', [table('items', { columns: [column('id', { autoIncrement: true })] })]),
    ).blockers.map(({ code }) => code),
  ).toContain('COLUMN_REWRITE')
})

test.each(['sqlite', 'postgresql', 'mysql'] as const)(
  'handles %s foreign key additions and removals explicitly',
  (dialect) => {
    const plain = table('children', { columns: [column(), column('parent_id')] })
    const linked = { ...plain, foreignKeys: [foreign] }
    const added = diff(
      model(dialect, [plain, table('parents')]),
      model(dialect, [linked, table('parents')]),
    )
    const removed = diff(
      model(dialect, [linked, table('parents')]),
      model(dialect, [plain, table('parents')]),
    )
    expect(added.blockers.map(({ code }) => code)).toEqual(
      dialect === 'sqlite' ? ['SQLITE_FOREIGN_KEY'] : [],
    )
    expect(removed.blockers.map(({ code }) => code)).toEqual(
      dialect === 'sqlite' ? ['FOREIGN_KEY_REWRITE'] : [],
    )
    if (dialect !== 'sqlite') {
      expect(added.operations[0]?.kind).toBe('add-foreign-key')
      expect(removed.operations[0]?.down).toHaveLength(1)
    }
  },
)

test('requires an observed name before dropping a live foreign key', () => {
  const unnamed = { ...foreign, name: undefined } as unknown as SchemaForeignKey
  const old = table('children', { foreignKeys: [unnamed] })
  expect(
    diff(model('postgresql', [old]), model('postgresql', [table('children')])).blockers.map(
      ({ code }) => code,
    ),
  ).toContain('FOREIGN_KEY_REWRITE')
})

test('matches structural index and foreign-key identity despite display names', () => {
  const index: SchemaIndex = { name: 'database_name', columns: ['id'], unique: false }
  const old = table('items', { indexes: [index], foreignKeys: [foreign] })
  const target = table('items', {
    indexes: [{ columns: ['id'], unique: false }],
    foreignKeys: [{ ...foreign, name: 'model_name' }],
  })
  expect(diff(model('postgresql', [old]), model('postgresql', [target])).operations).toEqual([])
})

test('drops named PostgreSQL unique constraints through ALTER TABLE', () => {
  const old = table('items', {
    indexes: [{ name: 'items_id_key', columns: ['id'], unique: true, constraint: true }],
  })
  const plan = diff(model('postgresql', [old]), model('postgresql', [table()]))
  expect(plan.blockers).toEqual([])
  expect(plan.operations[0]?.up[0]?.sql).toContain('drop constraint "items_id_key"')
  expect(plan.operations[0]?.down?.[0]?.sql).toContain('add constraint "items_id_key" unique')
})

test('orders table drops by dependencies and blocks cyclic SQLite drops', () => {
  const parent = table('aparent')
  const child = table('zchild', { foreignKeys: [{ ...foreign, targetTable: 'aparent' }] })
  const changes = diff(model('sqlite', [parent, child]), model(), { dropMissingTables: 'apply' })
  expect(changes.operations.map(({ table }) => table)).toEqual(['zchild', 'aparent'])
  const cycle = table('aparent', { foreignKeys: [{ ...foreign, targetTable: 'zchild' }] })
  expect(
    diff(model('sqlite', [cycle, child]), model(), { dropMissingTables: 'apply' }).blockers.map(
      ({ code }) => code,
    ),
  ).toContain('SQLITE_DROP_CYCLE')
  expect(
    diff(model('postgresql', [cycle, child]), model('postgresql'), { dropMissingTables: 'apply' })
      .blockers,
  ).toEqual([])
})

test('retains foreign-key protection from skipped unmodeled tables during column drops', () => {
  const parent = table('parents', { columns: [column(), column('value')] })
  const child = table('children', { foreignKeys: [{ ...foreign, targetColumns: ['value'] }] })
  expect(
    diff(
      model('postgresql', [parent, child]),
      model('postgresql', [table('parents')]),
    ).blockers.map(({ code }) => code),
  ).toContain('COLUMN_DEPENDENCY')
})

test('treats enums as text on SQLite and supports nullable SQL-default columns on PostgreSQL', () => {
  const sqlite = diff(
    model(),
    model(
      'sqlite',
      [
        table('items', {
          columns: [column('value', { type: 'text', enumName: 'State', nullable: true })],
          primaryKey: [],
        }),
      ],
      { enums: [{ name: 'State', values: ['a'] }] },
    ),
  )
  expect(sqlOf(sqlite)).toContain('"value" text')
  const postgres = diff(
    model('postgresql', [table()]),
    model('postgresql', [
      table('items', {
        columns: [
          column(),
          column('created_at', {
            type: 'timestamp(3)',
            nullable: true,
            default: { kind: 'sql', sql: 'now()' },
          }),
        ],
      }),
    ]),
  )
  expect(postgres.blockers).toEqual([])
  expect(sqlOf(postgres)).toContain('default now()')
})
