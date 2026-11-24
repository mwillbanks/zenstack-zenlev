import { describe, expect, test } from 'bun:test'
import { parseSqlLintInput } from '../../../src/lint/source'
import { node, source } from './fixtures'

describe('SQL parser adapters', () => {
  test.each(['postgresql', 'mysql', 'sqlite'])(
    'reads %s table, keys and checks',
    async (dialect) => {
      const input = await parseSqlLintInput(
        'CREATE TABLE users (id varchar(30) PRIMARY KEY, parent_id varchar(30), active_count int NOT NULL DEFAULT 1, CONSTRAINT parent_fk FOREIGN KEY(parent_id) REFERENCES parents(id), CONSTRAINT positive CHECK (active_count > 0), CONSTRAINT unique_parent UNIQUE(parent_id)); CREATE INDEX idx_parent ON users(parent_id);',
        dialect,
        source,
      )
      expect(input.gaps).toEqual([])
      expect(node(input, 'table').name).toBe('users')
      expect(node(input, 'primary-key').columns).toEqual(['id'])
      expect(node(input, 'foreign-key').targetTable).toBe('parents')
      expect(node(input, 'column', 'active_count')).toMatchObject({ nullable: false, default: '1' })
      expect(node(input, 'check', 'positive')).toMatchObject({ generated: false })
      expect(node(input, 'unique', 'unique_parent').columns).toEqual(['parent_id'])
      expect(node(input, 'index').columns).toEqual(['parent_id'])
    },
  )
  test.each([
    ['postgresql', 'CREATE TABLE users (id bigserial PRIMARY KEY)'],
    ['postgresql', 'CREATE TABLE users (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY)'],
    ['postgresql', "CREATE TABLE users (id bigint DEFAULT nextval('ids') PRIMARY KEY)"],
    ['mysql', 'CREATE TABLE users (id bigint AUTO_INCREMENT PRIMARY KEY)'],
    ['sqlite', 'CREATE TABLE users (id INTEGER PRIMARY KEY)'],
    ['sqlite', 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT)'],
  ])('detects generated keys in %s', async (dialect, sql) => {
    const input = await parseSqlLintInput(sql, dialect, source)
    expect(input.gaps).toEqual([])
    expect(node(input, 'column', 'id').sequential).toBe(true)
  })
  test.each([
    'CREATE TABLE users (id INTEGER PRIMARY KEY) WITHOUT ROWID',
    'CREATE TABLE users (id INTEGER PRIMARY KEY DESC)',
    'CREATE TABLE users (id INT PRIMARY KEY)',
    'CREATE TABLE users (id TEXT PRIMARY KEY)',
    'CREATE TABLE users (id INTEGER, scope INTEGER, PRIMARY KEY(id, scope))',
  ])('honors SQLite rowid exceptions %s', async (sql) => {
    const input = await parseSqlLintInput(sql, 'sqlite', source)
    expect(input.gaps).toEqual([])
    expect(node(input, 'column', 'id').sequential).toBe(false)
  })
  test.each(['postgresql', 'mysql', 'sqlite'])(
    'does not infer sequential IDs from names or string defaults in %s',
    async (dialect) => {
      const input = await parseSqlLintInput(
        "CREATE TABLE items (identity text PRIMARY KEY DEFAULT 'serial', nextval text DEFAULT 'identity', sequence_value text DEFAULT 'auto_increment');",
        dialect,
        source,
      )
      expect(input.gaps).toEqual([])
      expect(
        input.nodes.filter((item) => item.kind === 'column').map((item) => item.sequential),
      ).toEqual([false, false, false])
    },
  )
  test('distinguishes overloaded routine identities using authored signatures', async () => {
    const input = await parseSqlLintInput(
      'CREATE FUNCTION app.convert(integer) RETURNS text LANGUAGE sql AS $$ SELECT 1 $$; CREATE FUNCTION app.convert(text) RETURNS text LANGUAGE sql AS $$ SELECT 1 $$; DROP FUNCTION app.convert(integer); DROP FUNCTION app.other;',
      'postgresql',
      source,
    )
    expect(
      input.nodes.filter((item) => item.kind === 'function').map((item) => item.identity),
    ).toEqual(['app.convert(integer)', 'app.convert(text)', 'app.convert(integer)', 'app.other'])
    expect(input.gaps[0]?.identity).toBe('app.convert(integer)')
  })
  test.each(['postgresql', 'mysql'])(
    'inspects definite qualified function calls in %s statements',
    async (dialect) => {
      const input = await parseSqlLintInput(
        'SELECT app.forbidden_routine(), app.outer_call(app.inner_call(1)); INSERT INTO app.items(id) SELECT app.make_id(); UPDATE app.items SET id = app.replace_id(id); DELETE FROM app.items WHERE app.remove_id(id); WITH scoped AS (SELECT app.scoped_id()) SELECT * FROM scoped;',
        dialect,
        source,
      )
      expect(input.gaps).toEqual([])
      expect(input.nodes.map((item) => [item.identity, item.kind, item.action])).toEqual([
        ['app.forbidden_routine', 'function', 'call'],
        ['app.outer_call', 'function', 'call'],
        ['app.inner_call', 'function', 'call'],
        ['app.make_id', 'function', 'call'],
        ['app.replace_id', 'function', 'call'],
        ['app.remove_id', 'function', 'call'],
        ['app.scoped_id', 'function', 'call'],
      ])
      expect(input.nodes[0]?.source).toMatchObject({ line: 1, column: 12 })
    },
  )
  test('does not treat qualified casts, SQL keywords or literal text as calls', async () => {
    const input = await parseSqlLintInput(
      "SELECT 1::app.amount(10), CAST(1 AS app.amount(10)), EXTRACT(YEAR FROM CURRENT_TIMESTAMP), 'app.fake()'; INSERT INTO app.items(id) VALUES (1);",
      'postgresql',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(input.nodes).toEqual([])
  })
  test.each(['postgresql', 'mysql', 'sqlite'])(
    'reports unresolved unqualified calls in %s query expressions',
    async (dialect) => {
      const input = await parseSqlLintInput(
        'SELECT forbidden_routine() AS result, 1 + nested_call(other_call());',
        dialect,
        source,
      )
      expect(input.nodes).toEqual([])
      expect(input.gaps.map((gap) => gap.identity)).toEqual([
        'forbidden_routine',
        'nested_call',
        'other_call',
      ])
      expect(input.gaps[0]).toMatchObject({
        message: expect.stringContaining('Unqualified function call'),
        source: { line: 1, column: 8 },
      })
    },
  )
  test('does not report unresolved calls for syntax or relation column lists', async () => {
    const input = await parseSqlLintInput(
      'WITH scoped(id) AS (SELECT 1), other(id) AS (SELECT 2) SELECT CAST(id AS numeric(10)), EXTRACT(YEAR FROM CURRENT_TIMESTAMP) FROM scoped s(id) WHERE id IN (1,2) AND EXISTS (SELECT 1 FROM other); INSERT INTO things(id) VALUES(1);',
      'postgresql',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(input.nodes).toEqual([])
  })
  test('reads named composite keys, qualified references and partial indexes', async () => {
    const input = await parseSqlLintInput(
      'CREATE TABLE app.links (left_id uuid, right_id uuid, CONSTRAINT links_pk PRIMARY KEY(left_id,right_id), CONSTRAINT links_fk FOREIGN KEY(left_id,right_id) REFERENCES other.targets(left_id,right_id)); CREATE UNIQUE INDEX links_idx ON app.links(left_id,right_id) WHERE left_id IS NOT NULL;',
      'postgresql',
      source,
    )
    expect(node(input, 'primary-key')).toMatchObject({
      name: 'links_pk',
      columns: ['left_id', 'right_id'],
      generated: false,
    })
    expect(node(input, 'foreign-key')).toMatchObject({
      targetSchema: 'other',
      targetTable: 'targets',
      targetColumns: ['left_id', 'right_id'],
    })
    expect(node(input, 'index')).toMatchObject({ unique: true, partial: true, schema: 'app' })
  })
  test.each(['sqlite', 'postgresql'])(
    'keeps separate inline constraint names in %s',
    async (dialect) => {
      const input = await parseSqlLintInput(
        "CREATE TABLE children (id TEXT CONSTRAINT pk_children PRIMARY KEY CONSTRAINT uq_children UNIQUE CONSTRAINT ck_children CHECK(length(id) > 0) CONSTRAINT fk_children REFERENCES parents(id) CHECK(id <> ''));",
        dialect,
        source,
      )
      expect(input.gaps).toEqual([])
      expect(node(input, 'primary-key')).toMatchObject({ name: 'pk_children', generated: false })
      expect(node(input, 'unique')).toMatchObject({ name: 'uq_children', generated: false })
      expect(node(input, 'foreign-key')).toMatchObject({ name: 'fk_children', generated: false })
      expect(
        input.nodes
          .filter((item) => item.kind === 'check')
          .map((item) => ({ name: item.name, generated: item.generated })),
      ).toEqual([
        { name: 'ck_children', generated: false },
        { name: '', generated: true },
      ])
    },
  )
  test('preserves quoted names and exact source positions', async () => {
    const input = await parseSqlLintInput(
      '-- heading\nCREATE TABLE "Odd""Name" ("oddColumn" text PRIMARY KEY);',
      'postgresql',
      { ...source, line: 4, column: 8 },
    )
    expect(node(input, 'table')).toMatchObject({
      name: 'Odd"Name',
      spelling: '"Odd""Name"',
      quoted: true,
      source: { line: 5, column: 14 },
    })
    expect(node(input, 'column')).toMatchObject({ name: 'oddColumn', quoted: true })
    const unicode = await parseSqlLintInput(
      "SELECT '🦊';\nCREATE TABLE users (id text PRIMARY KEY);",
      'postgresql',
      source,
    )
    expect(node(unicode, 'table').source).toMatchObject({ line: 2, column: 14 })
  })
  test('retains SQLite statement boundaries around maintenance commands', async () => {
    const input = await parseSqlLintInput(
      'CREATE TABLE items (id TEXT PRIMARY KEY); REINDEX; VACUUM; DROP TABLE items;',
      'sqlite',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(input.nodes.filter(({ kind }) => kind === 'table').map(({ action }) => action)).toEqual([
      'create',
      'drop',
    ])
  })

  test('parses compound SQLite triggers as one statement', async () => {
    const input = await parseSqlLintInput(
      'CREATE TRIGGER log_change AFTER INSERT ON users BEGIN INSERT INTO log VALUES (1); INSERT INTO log VALUES (2); END; CREATE VIEW visible_users AS SELECT * FROM users;',
      'sqlite',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(input.nodes.map((item) => item.kind)).toEqual(['trigger', 'view'])
  })
  test('reads routines, anonymous blocks and event triggers', async () => {
    const input = await parseSqlLintInput(
      'CREATE OR REPLACE FUNCTION app.count_users() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$ BEGIN RETURN 1; END $$; CALL app.refresh_users(); DROP FUNCTION app.old_function(); CREATE EVENT TRIGGER audit_ddl ON ddl_command_end EXECUTE FUNCTION audit(); DO $$ BEGIN NULL; END $$;',
      'postgresql',
      source,
    )
    expect(node(input, 'function', 'count_users')).toMatchObject({
      action: 'replace',
      language: 'plpgsql',
      security: 'definer',
    })
    expect(node(input, 'procedure', 'refresh_users').action).toBe('call')
    expect(node(input, 'function', 'old_function').action).toBe('drop')
    expect(node(input, 'event-trigger').name).toBe('audit_ddl')
    expect(node(input, 'anonymous-block')).toBeDefined()
    expect(input.gaps.some((gap) => gap.message.includes('Routine body'))).toBe(true)
  })
  test('distinguishes MySQL invoker and definer views', async () => {
    const input = await parseSqlLintInput(
      'CREATE SQL SECURITY INVOKER VIEW users_view AS SELECT * FROM users; CREATE VIEW default_view AS SELECT * FROM users;',
      'mysql',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(node(input, 'view', 'users_view').security).toBe('invoker')
    expect(node(input, 'view', 'default_view').security).toBe('definer')
  })
  test('reads PostgreSQL RLS flags and preserves omitted ALTER POLICY predicates', async () => {
    const input = await parseSqlLintInput(
      "ALTER TABLE app.users ENABLE ROW LEVEL SECURITY; ALTER TABLE app.users FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_policy ON app.users AS RESTRICTIVE FOR UPDATE TO app_role USING (tenant_id = current_setting('app.tenant')::uuid) WITH CHECK (true); ALTER POLICY tenant_policy ON app.users TO other_role; ALTER TABLE app.users NO FORCE ROW LEVEL SECURITY; ALTER TABLE app.users DISABLE ROW LEVEL SECURITY;",
      'postgresql',
      source,
    )
    expect(input.gaps).toEqual([])
    expect(input.nodes.filter((item) => item.kind === 'rls').map((item) => item.action)).toEqual([
      'enable',
      'force',
      'no-force',
      'disable',
    ])
    const policy = input.nodes.find((item) => item.kind === 'policy' && item.action === 'create')!
    expect(policy).toMatchObject({
      table: 'users',
      schema: 'app',
      command: 'update',
      roles: ['app_role'],
      permissive: false,
      check: 'true',
    })
    expect(policy.using).toContain('tenant_id')
    const altered = input.nodes.find((item) => item.kind === 'policy' && item.action === 'alter')!
    expect(altered.using).toBeUndefined()
    expect(altered.check).toBeUndefined()
  })
  test('reads ALL policies, invoker views and added columns', async () => {
    const input = await parseSqlLintInput(
      'CREATE POLICY scoped ON users USING (true); CREATE VIEW filtered WITH (security_invoker=true) AS SELECT * FROM users; ALTER TABLE users ADD COLUMN extra text; ALTER TABLE users ADD CONSTRAINT users_check CHECK (extra IS NOT NULL);',
      'postgresql',
      source,
    )
    expect(node(input, 'policy')).toMatchObject({
      command: 'all',
      roles: ['public'],
      using: 'true',
    })
    expect(node(input, 'view').security).toBe('invoker')
    expect(node(input, 'column', 'extra').action).toBe('alter')
    expect(node(input, 'check', 'users_check')).toBeDefined()
  })
  test('reports inherited table and unknown operations as gaps', async () => {
    const input = await parseSqlLintInput(
      'CREATE TABLE copied AS SELECT 1 AS id; ALTER TABLE copied RENAME TO renamed; CREATE DATABASE sample;',
      'postgresql',
      source,
    )
    expect(input.gaps).toHaveLength(3)
  })
  test.each(['sqlite', 'mysql', 'postgresql', undefined, 'custom'])(
    'reports unsupported input for %s',
    async (dialect) => {
      const input = await parseSqlLintInput('CREAT THING ???', dialect, source)
      expect(input.nodes).toEqual([])
      expect(input.gaps).toHaveLength(1)
    },
  )
  test('ignores ordinary selects, nested SQL comments and empty statements', async () => {
    const input = await parseSqlLintInput(
      "SELECT /* outer /* nested */ comment */ 'x; y'; -- hi\n;",
      'postgresql',
      source,
    )
    expect(input.nodes).toEqual([])
    expect(input.gaps).toEqual([])
  })
})
