import { describe, expect, test } from 'bun:test'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { createKyselyAdapter, lintProject } from '../../../src'
import { readBuiltinLintCatalog } from '../../../src/lint/catalog'

const postgresUrl = process.env.ZENLEV_TEST_POSTGRES_URL
describe.skipIf(postgresUrl === undefined)('PostgreSQL lint catalog', () => {
  test('reads object, policy, key, and security metadata while excluding extension members and ledger tables', async () => {
    const db = new Kysely<any>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: postgresUrl!, max: 2 }) }),
    })
    const adapter = createKyselyAdapter(db, 'postgresql')
    const schema = 'zenlev_lint_catalog'
    const shadow = 'zenlev_lint_shadow'
    try {
      await sql.raw('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').execute(db)
      await sql.raw('DROP SCHEMA IF EXISTS ' + shadow + ' CASCADE').execute(db)
      await sql.raw('CREATE SCHEMA ' + schema).execute(db)
      await sql.raw('CREATE SCHEMA ' + shadow).execute(db)
      const empty = await readBuiltinLintCatalog({ adapter, namespaces: [schema] })
      expect(empty.nodes.map((node) => node.kind)).toEqual(['schema'])
      expect(
        (await readBuiltinLintCatalog({ adapter, namespaces: ['zenlev_lint_absent'] })).gaps,
      ).toContainEqual(expect.objectContaining({ identity: 'zenlev_lint_absent' }))
      await sql
        .raw(
          `
        CREATE TYPE ${schema}.category AS ENUM ('first', 'second');
        CREATE SEQUENCE ${schema}.separate_sequence;
        CREATE TABLE ${schema}.parents (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          label text NOT NULL DEFAULT 'parent',
          category ${schema}.category,
          CONSTRAINT uq_parents_label UNIQUE (label),
          CONSTRAINT ck_parents_label CHECK (length(label) > 0)
        );
        CREATE TABLE ${schema}.children (
          id serial PRIMARY KEY,
          parent_id bigint,
          label text,
          computed text GENERATED ALWAYS AS (label || '_derived') STORED,
          CONSTRAINT fk_children_parent FOREIGN KEY (parent_id) REFERENCES ${schema}.parents(id)
        );
        CREATE INDEX idx_children_parent ON ${schema}.children(parent_id) INCLUDE (label);
        CREATE INDEX idx_children_partial ON ${schema}.children(parent_id) WHERE parent_id IS NOT NULL;
        CREATE INDEX idx_children_expression ON ${schema}.children(lower(label));
        CREATE VIEW ${schema}.definer_view AS SELECT id FROM ${schema}.parents;
        CREATE VIEW ${schema}.invoker_view WITH (security_invoker=true) AS SELECT id FROM ${schema}.parents;
        CREATE MATERIALIZED VIEW ${schema}.snapshot AS SELECT id FROM ${schema}.parents;
        ALTER TABLE ${schema}.parents ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${schema}.parents FORCE ROW LEVEL SECURITY;
        CREATE POLICY parents_policy ON ${schema}.parents FOR ALL TO PUBLIC USING (id > 0) WITH CHECK (id > 1);
        CREATE POLICY parents_insert ON ${schema}.parents AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (id > 0);
        CREATE FUNCTION ${schema}.increment(value integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT value + 1';
        CREATE FUNCTION ${schema}.increment(value bigint) RETURNS bigint LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO pg_catalog, ${schema} AS 'SELECT value + 1';
        CREATE PROCEDURE ${schema}.procedure() LANGUAGE sql AS 'SELECT 1';
        CREATE FUNCTION ${schema}.definer_without_path() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
        CREATE FUNCTION ${schema}.trigger_function() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
        CREATE TRIGGER children_trigger BEFORE INSERT ON ${schema}.children FOR EACH ROW EXECUTE FUNCTION ${schema}.trigger_function();
        CREATE FUNCTION ${schema}.event_function() RETURNS event_trigger LANGUAGE plpgsql AS 'BEGIN RETURN; END';
        CREATE EVENT TRIGGER zenlev_lint_catalog_event ON ddl_command_end EXECUTE FUNCTION ${schema}.event_function();
        CREATE TABLE ${schema}.internal_migrations (id text);
        CREATE TABLE ${schema}.internal_lock (id text);
        CREATE TABLE ${schema}.internal_migrations_resolutions (id text);
        CREATE TABLE ${schema}.internal_migrations_audit (id text);
        CREATE TABLE ${shadow}.internal_migrations (id text PRIMARY KEY);
      `,
        )
        .execute(db)
      await sql.raw('CREATE EXTENSION hstore WITH SCHEMA ' + schema).execute(db)
      const result = await readBuiltinLintCatalog({
        adapter,
        namespaces: [schema, shadow],
        store: {
          schemaName: schema,
          tableName: 'internal_migrations',
          lockTableName: 'internal_lock',
        },
      })
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'rls',
          schema,
          table: 'parents',
          enabled: true,
          forced: true,
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'policy',
          name: 'parents_policy',
          roles: ['public'],
          command: 'ALL',
          permissive: true,
          using: '(id > 0)',
          check: '(id > 1)',
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'policy',
          name: 'parents_insert',
          permissive: false,
          using: null,
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'foreign-key',
          name: 'fk_children_parent',
          columns: ['parent_id'],
          targetSchema: schema,
          targetTable: 'parents',
          targetColumns: ['id'],
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'index',
          name: 'idx_children_parent',
          columns: ['parent_id'],
          partial: false,
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'index', name: 'idx_children_partial', partial: true }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'index', name: 'idx_children_expression', partial: true }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'column', table: 'parents', name: 'id', sequential: true }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'column',
          table: 'children',
          name: 'id',
          sequential: true,
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'column',
          table: 'children',
          name: 'computed',
          generated: true,
        }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'view', name: 'invoker_view', security: 'invoker' }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'view', name: 'definer_view', security: 'definer' }),
      )
      expect(result.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'function',
          name: 'increment',
          signature: 'bigint',
          security: 'definer',
          searchPath: ['pg_catalog', schema],
        }),
      )
      expect(
        result.nodes
          .filter((node) => node.kind === 'function' && node.name === 'increment')
          .map((node) => node.identity)
          .sort(),
      ).toEqual([schema + '.increment(bigint)', schema + '.increment(integer)'])
      for (const kind of [
        'procedure',
        'trigger',
        'event-trigger',
        'materialized-view',
        'sequence',
        'extension',
        'enum',
        'enum-value',
        'unique',
        'check',
      ])
        expect(result.nodes.some((node) => node.kind === kind)).toBe(true)
      expect(
        result.nodes.some((node) => node.kind === 'function' && node.name === 'fetchval'),
      ).toBe(false)
      expect(
        result.nodes.some(
          (node) => node.schema === schema && (node.table ?? node.name).startsWith('internal_'),
        ),
      ).toBe(false)
      expect(result.nodes).toContainEqual(
        expect.objectContaining({ kind: 'table', schema: shadow, name: 'internal_migrations' }),
      )
      expect(result.gaps).toEqual([])
      expect(result.capabilities).toContain('policy:with-check')
      expect(result.capabilities).toContain('routine:search-path')
      const security = await lintProject(
        {
          adapter,
          lint: {
            presets: [],
            namespaces: [schema],
            rules: {
              'zenlev/objects/security': ['error', { trustedSearchPath: ['pg_catalog', schema] }],
            },
          },
        },
        { live: true },
      )
      expect(security.diagnostics).toEqual([
        expect.objectContaining({ identity: schema + '.definer_without_path()' }),
      ])
      const scoped = await readBuiltinLintCatalog({ adapter, namespaces: [shadow] })
      expect(scoped.nodes).toContainEqual(
        expect.objectContaining({ kind: 'event-trigger', name: 'zenlev_lint_catalog_event' }),
      )
      const publicDefault = await readBuiltinLintCatalog({ adapter })
      expect(publicDefault.nodes.some((node) => node.schema === schema)).toBe(true)
    } finally {
      try {
        await sql.raw('DROP EVENT TRIGGER IF EXISTS zenlev_lint_catalog_event').execute(db)
        await sql.raw('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').execute(db)
        await sql.raw('DROP SCHEMA IF EXISTS ' + shadow + ' CASCADE').execute(db)
      } finally {
        await db.destroy()
      }
    }
  })

  test('audits tenant policies and verifies their behavior as the application role', async () => {
    const db = new Kysely<any>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: postgresUrl!, max: 2 }) }),
    })
    const adapter = createKyselyAdapter(db, 'postgresql')
    const schema = 'zenlev_lint_tenant'
    const role = 'zenlev_lint_application'
    try {
      await sql
        .raw(
          `
        CREATE ROLE ${role} NOLOGIN;
        CREATE SCHEMA ${schema};
        CREATE TABLE ${schema}.accounts (id text PRIMARY KEY, tenant_id text NOT NULL);
        INSERT INTO ${schema}.accounts VALUES ('a', 'one'), ('b', 'two');
        ALTER TABLE ${schema}.accounts ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${schema}.accounts FORCE ROW LEVEL SECURITY;
        GRANT USAGE ON SCHEMA ${schema} TO ${role};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.accounts TO ${role};
        CREATE POLICY tenant_account ON ${schema}.accounts FOR ALL TO ${role}
          USING (tenant_id = current_setting('zenlev.test_tenant'))
          WITH CHECK (tenant_id = current_setting('zenlev.test_tenant'));
      `,
        )
        .execute(db)
      const audited = await lintProject(
        {
          adapter,
          lint: {
            namespaces: [schema],
            rules: {
              'zenlev/postgres/rls': [
                'error',
                {
                  tables: [schema + '.accounts'],
                  roles: [role],
                  allowedRoles: [role],
                  commands: ['select', 'insert', 'update', 'delete'],
                  force: true,
                  explicitWriteCheck: true,
                },
              ],
            },
          },
        },
        { live: true },
      )
      expect(audited.diagnostics).toEqual([])
      await expect(
        db.transaction().execute(async (connection) => {
          await sql.raw('SET LOCAL ROLE ' + role).execute(connection)
          await sql`SELECT set_config('zenlev.test_tenant', 'one', true)`.execute(connection)
          const read = await sql
            .raw<{ id: string }>('SELECT id FROM ' + schema + '.accounts')
            .execute(connection)
          expect(read.rows).toEqual([{ id: 'a' }])
          await sql
            .raw(`UPDATE ${schema}.accounts SET tenant_id = 'two' WHERE id = 'a'`)
            .execute(connection)
        }),
      ).rejects.toThrow('row-level security policy')
    } finally {
      try {
        await sql.raw('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').execute(db)
        await sql.raw('DROP ROLE IF EXISTS ' + role).execute(db)
      } finally {
        await db.destroy()
      }
    }
  })
})
