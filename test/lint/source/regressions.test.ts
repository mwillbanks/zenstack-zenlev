import { describe, expect, test } from 'bun:test'
import { parseSqlLintInput } from '../../../src/lint/source'
import { node, source } from './fixtures'

describe('SQL source evidence regressions', () => {
  test('infers MySQL SERIAL unique keys without duplicating inline constraints', async () => {
    for (const [column, tableConstraint, count] of [
      ['SERIAL NULL', '', 1],
      ['SERIAL UNIQUE', '', 1],
      ['SERIAL', ', UNIQUE(id)', 2],
      ['SERIAL', ', CONSTRAINT named UNIQUE(id)', 2],
      ['BIGINT SERIAL DEFAULT VALUE', '', 1],
    ] as const) {
      const input = await parseSqlLintInput(
        'CREATE TABLE records (id ' + column + tableConstraint + ');',
        'mysql',
        source,
      )
      expect(input.gaps).toEqual([])
      const unique = input.nodes.filter(({ kind }) => kind === 'unique')
      expect(unique).toHaveLength(count)
      expect(new Set(unique.map(({ identity }) => identity)).size).toBe(count)
      if (column === 'BIGINT SERIAL DEFAULT VALUE') {
        expect(node(input, 'column', 'id')).toMatchObject({
          type: 'BIGINT',
          nullable: false,
          sequential: true,
        })
        expect(node(input, 'column', 'id').default).toBeUndefined()
      }
    }
  })

  test('distinguishes MySQL SERIAL NULL from default and referential NULL tokens', async () => {
    const input = await parseSqlLintInput(
      'CREATE TABLE records (explicit SERIAL NULL, implicit SERIAL, defaulted SERIAL DEFAULT NULL, referenced SERIAL REFERENCES parents(id) ON DELETE SET NULL);',
      'mysql',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(node(input, 'column', 'explicit')).toMatchObject({ nullable: true, sequential: true })
    for (const name of ['implicit', 'defaulted', 'referenced'])
      expect(node(input, 'column', name)).toMatchObject({ nullable: false, sequential: true })
  })

  test.each(['postgresql', 'mysql', 'sqlite'])(
    'keeps quoted punctuation in %s identifiers',
    async (dialect) => {
      const quote = dialect === 'mysql' ? String.fromCharCode(96) : '"'
      const input = await parseSqlLintInput(
        'CREATE TABLE punctuation (' +
          quote +
          '(' +
          quote +
          ' text, ' +
          quote +
          ',' +
          quote +
          ' text, ' +
          quote +
          ')' +
          quote +
          ' text, PRIMARY KEY(' +
          quote +
          '(' +
          quote +
          ',' +
          quote +
          ',' +
          quote +
          '));',
        dialect,
        source,
      )
      expect(input.gaps).toEqual([])
      expect(input.nodes.filter((item) => item.kind === 'column').map((item) => item.name)).toEqual(
        ['(', ',', ')'],
      )
      expect(node(input, 'primary-key').columns).toEqual(['(', ','])
    },
  )

  test.each(['postgresql', 'mysql', 'sqlite'])(
    'normalizes parameterized %s types without changing defaults or nullability',
    async (dialect) => {
      const input = await parseSqlLintInput(
        "CREATE TABLE details (code varchar(30), amount decimal(10,2), value int DEFAULT (CASE WHEN NOT false THEN 1 ELSE 0 END) CHECK (value IS NOT NULL), note text DEFAULT 'NOT NULL');",
        dialect,
        source,
      )
      expect(input.gaps).toEqual([])
      expect(node(input, 'column', 'code').type).toBe('varchar(30)')
      expect(node(input, 'column', 'amount').type).toBe('decimal(10,2)')
      expect(node(input, 'column', 'value')).toMatchObject({
        nullable: true,
        default: '( CASE WHEN NOT false THEN 1 ELSE 0 END )',
      })
      expect(node(input, 'column', 'note').nullable).toBe(true)
    },
  )

  test.each(['postgresql', 'mysql'])(
    'marks every table-level %s primary key column nonnullable',
    async (dialect) => {
      const input = await parseSqlLintInput(
        'CREATE TABLE links (left_id varchar(30), right_id varchar(30), PRIMARY KEY(left_id,right_id));',
        dialect,
        source,
      )
      expect(input.gaps).toEqual([])
      expect(
        input.nodes.filter((item) => item.kind === 'column').map((item) => item.nullable),
      ).toEqual([false, false])
    },
  )

  test.each([
    ['CREATE TABLE links (id TEXT PRIMARY KEY)', true],
    ['CREATE TABLE links (id INTEGER PRIMARY KEY)', false],
    ['CREATE TABLE links (id TEXT, PRIMARY KEY(id)) WITHOUT ROWID', false],
    ['CREATE TABLE links (id TEXT, PRIMARY KEY(id)) STRICT', false],
  ] as const)('honors SQLite key nullability: %s', async (sql, nullable) => {
    const input = await parseSqlLintInput(sql, 'sqlite', source)
    expect(input.gaps).toEqual([])
    expect(node(input, 'column', 'id').nullable).toBe(nullable)
  })

  test('keeps unknown constraint names empty with distinct identities', async () => {
    const input = await parseSqlLintInput(
      'CREATE TABLE links (left_id text, right_id text, FOREIGN KEY(left_id) REFERENCES parents(id), FOREIGN KEY(right_id) REFERENCES parents(id), CHECK(left_id <> right_id), CHECK(left_id IS NOT NULL));',
      'postgresql',
      source,
    )
    const constraints = input.nodes.filter((item) => ['foreign-key', 'check'].includes(item.kind))
    expect(constraints).toHaveLength(4)
    expect(new Set(constraints.map((item) => item.identity)).size).toBe(4)
    expect(
      constraints.every((item) => item.name === '' && item.generated && item.explicit === false),
    ).toBe(true)
    expect(node(input, 'table').explicit).toBe(true)
    const altered = await parseSqlLintInput(
      'ALTER TABLE links ADD CHECK(left_id IS NOT NULL); ALTER TABLE links ADD CHECK(right_id IS NOT NULL);',
      'postgresql',
      source,
    )
    expect(
      new Set(altered.nodes.filter((item) => item.kind === 'check').map((item) => item.identity))
        .size,
    ).toBe(2)
  })

  test('keeps exclusion constraints separate from columns', async () => {
    const input = await parseSqlLintInput(
      'CREATE TABLE reservations (during tsrange, EXCLUDE USING gist (during WITH &&));',
      'postgresql',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(input.nodes.filter((item) => item.kind === 'column').map((item) => item.name)).toEqual([
      'during',
    ])
    expect(node(input, 'exclusion')).toMatchObject({ name: '', generated: true })
  })

  test('reports inherited fields while retaining local declarations', async () => {
    const input = await parseSqlLintInput(
      'CREATE TABLE child (local_id text) INHERITS (parent);',
      'postgresql',
      source,
    )
    expect(node(input, 'column', 'local_id')).toBeDefined()
    expect(input.gaps).toContainEqual(
      expect.objectContaining({ message: 'Inherited columns require catalog inspection.' }),
    )
  })

  test('reports CTAS shape and inspects its expression calls', async () => {
    const input = await parseSqlLintInput(
      'CREATE TABLE copied AS SELECT app.hidden_fn() AS id, unqualified_fn() AS extra;',
      'postgresql',
      source,
    )
    expect(input.nodes.filter((item) => item.kind === 'column')).toEqual([])
    expect(node(input, 'function')).toMatchObject({ identity: 'app.hidden_fn', action: 'call' })
    expect(input.gaps.map((gap) => gap.identity)).toEqual(['copied', 'unqualified_fn'])
    const columns = await parseSqlLintInput(
      'CREATE TABLE copied(id) AS SELECT app.hidden_fn();',
      'postgresql',
      source,
    )
    expect(columns.nodes.filter((item) => item.kind === 'column')).toEqual([])
    expect(node(columns, 'function').identity).toBe('app.hidden_fn')
    expect(columns.gaps).toHaveLength(1)
  })

  test('extracts calls from MERGE and REPLACE and gaps from CASE operands', async () => {
    const merge = await parseSqlLintInput(
      'MERGE INTO items t USING source s ON t.id = s.id WHEN MATCHED THEN UPDATE SET id = app.hidden_fn();',
      'postgresql',
      source,
    )
    expect(merge.gaps).toEqual([])
    expect(node(merge, 'function').identity).toBe('app.hidden_fn')
    const replace = await parseSqlLintInput(
      'REPLACE INTO items(id) VALUES (app.hidden_fn());',
      'mysql',
      source,
    )
    expect(replace.gaps).toEqual([])
    expect(node(replace, 'function').identity).toBe('app.hidden_fn')
    const conditional = await parseSqlLintInput(
      'SELECT CASE hidden_fn() WHEN 1 THEN 2 ELSE 3 END;',
      'postgresql',
      source,
    )
    expect(conditional.gaps.map((gap) => gap.identity)).toEqual(['hidden_fn'])
  })

  test.each(['postgresql', 'mysql', 'sqlite'])(
    'accepts standard builtins in %s without hiding quoted functions',
    async (dialect) => {
      const input = await parseSqlLintInput(
        'SELECT COUNT(*), SUM(amount), AVG(amount), MAX(amount), MIN(amount), LOWER(name), UPPER(name), LENGTH(name), ABS(amount), ROUND(amount) FROM items;',
        dialect,
        source,
      )
      expect(input).toMatchObject({ nodes: [], gaps: [] })
      const quote = dialect === 'mysql' ? String.fromCharCode(96) : '"'
      const quoted = await parseSqlLintInput(
        'SELECT ' + quote + 'COUNT' + quote + '(1);',
        dialect,
        source,
      )
      expect(quoted.gaps.map((gap) => gap.identity)).toEqual(['COUNT'])
    },
  )

  test.each(['=', 'TO'])(
    'bounds routine search_path with %s before later clauses',
    async (separator) => {
      const input = await parseSqlLintInput(
        'CREATE FUNCTION app.checked() RETURNS int SET search_path ' +
          separator +
          ' app, pg_temp LANGUAGE sql AS $$SELECT 1$$;',
        'postgresql',
        source,
      )
      expect(node(input, 'function').searchPath).toEqual(['app', 'pg_temp'])
    },
  )

  test('retains ALTER POLICY omissions and ADD COLUMN identities', async () => {
    const input = await parseSqlLintInput(
      'ALTER POLICY tenant ON app.users TO app_role; ALTER TABLE app.users ADD COLUMN IF NOT EXISTS extra varchar(30); ALTER TABLE app.users ADD IF NOT EXISTS other text;',
      'postgresql',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(node(input, 'policy').permissive).toBeUndefined()
    expect(node(input, 'column', 'extra')).toMatchObject({ table: 'users', type: 'varchar(30)' })
    expect(node(input, 'column', 'other')).toMatchObject({ table: 'users', type: 'text' })
  })

  test('qualifies index and quoted object identities consistently with catalog evidence', async () => {
    const input = await parseSqlLintInput(
      'CREATE INDEX idx_users ON app.users(id); DROP INDEX app.idx_users; CREATE TABLE "app.users" ("x.y" text);',
      'postgresql',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(
      input.nodes.filter((item) => item.kind === 'index').map((item) => item.identity),
    ).toEqual(['app.users.idx_users', 'app.idx_users'])
    expect(node(input, 'column', 'x.y').identity).toBe('"app.users"."x.y"')
  })
})
