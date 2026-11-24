import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { Kysely } from 'kysely'
import { createKyselyAdapter } from '../../../src'
import { readBuiltinLintCatalog } from '../../../src/lint/catalog'
import { createBunSqliteDialect } from '../../fixtures/sqlite'

test('audits SQLite keys, constraints, indexes, attached namespaces, and exact ledger exclusions', async () => {
  const raw = new Database(':memory:')
  const db = new Kysely<any>({ dialect: createBunSqliteDialect(raw) })
  const adapter = createKyselyAdapter(db, 'sqlite')
  try {
    raw.exec(`
      CREATE TABLE parents (id TEXT CONSTRAINT pk_parents PRIMARY KEY);
      CREATE TABLE children (
        id INTEGER CONSTRAINT pk_children PRIMARY KEY,
        parent_id TEXT CONSTRAINT fk_children_parent REFERENCES parents(id),
        alias_id TEXT REFERENCES parents,
        label TEXT DEFAULT 'child',
        computed TEXT GENERATED ALWAYS AS (label || '_computed') VIRTUAL,
        CONSTRAINT ck_children_label CHECK (length(label) > 0),
        CONSTRAINT uq_children_label UNIQUE (label)
      );
      CREATE INDEX idx_children_parent ON children(parent_id);
      CREATE INDEX idx_children_expression ON children(lower(label));
      CREATE INDEX idx_children_partial ON children(parent_id) WHERE parent_id IS NOT NULL;
      CREATE TABLE reversed (id INTEGER PRIMARY KEY DESC);
      CREATE TABLE no_rowid (id INTEGER PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE composite (left_id INTEGER, right_id INTEGER, PRIMARY KEY (left_id, right_id));
      CREATE TABLE loose (value);
      CREATE VIEW visible_children AS SELECT id, parent_id FROM children;
      CREATE TRIGGER trigger_children AFTER INSERT ON children BEGIN SELECT 1; END;
      CREATE TABLE zenlev_migrations (id TEXT);
      CREATE TABLE zenlev_lock (id TEXT);
      CREATE TABLE zenlev_migrations_resolutions (id TEXT);
      CREATE TABLE zenlev_migrations_audit (id TEXT);
      ATTACH DATABASE ':memory:' AS secondary;
      CREATE TABLE secondary.zenlev_migrations (id TEXT PRIMARY KEY);
    `)
    const result = await readBuiltinLintCatalog({ adapter })
    for (const table of ['parents', 'composite', 'reversed'])
      expect(
        result.nodes.find((node) => node.kind === 'column' && node.table === table)?.nullable,
      ).toBe(true)
    for (const table of ['children', 'no_rowid'])
      expect(
        result.nodes.find((node) => node.kind === 'column' && node.table === table)?.nullable,
      ).toBe(false)
    expect(result.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'primary-key',
        table: 'children',
        name: 'pk_children',
        explicit: true,
      }),
    )
    expect(result.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'foreign-key',
        table: 'children',
        name: 'fk_children_parent',
        targetTable: 'parents',
        targetColumns: ['id'],
        explicit: true,
      }),
    )
    expect(result.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'foreign-key',
        table: 'children',
        columns: ['alias_id'],
        generated: true,
      }),
    )
    expect(result.nodes).toContainEqual(
      expect.objectContaining({ kind: 'check', name: 'ck_children_label', origin: 'catalog' }),
    )
    expect(result.nodes).toContainEqual(
      expect.objectContaining({ kind: 'unique', name: 'uq_children_label', origin: 'catalog' }),
    )
    expect(result.nodes).toContainEqual(
      expect.objectContaining({ kind: 'column', table: 'children', name: 'id', sequential: true }),
    )
    expect(result.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'column',
        table: 'children',
        name: 'computed',
        generated: true,
      }),
    )
    for (const table of ['reversed', 'no_rowid', 'composite'])
      expect(
        result.nodes
          .filter((node) => node.table === table && node.kind === 'column')
          .every((node) => node.sequential === false),
      ).toBe(true)
    expect(result.nodes).toContainEqual(
      expect.objectContaining({ kind: 'index', name: 'idx_children_expression', partial: true }),
    )
    expect(result.nodes).toContainEqual(
      expect.objectContaining({ kind: 'index', name: 'idx_children_partial', partial: true }),
    )
    expect(result.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'index',
        name: 'idx_children_parent',
        partial: false,
        columns: ['parent_id'],
      }),
    )
    expect(
      result.nodes.some((node) => node.kind === 'view' && node.name === 'visible_children'),
    ).toBe(true)
    expect(
      result.nodes.some((node) => node.kind === 'trigger' && node.name === 'trigger_children'),
    ).toBe(true)
    expect(
      result.nodes.some(
        (node) => node.table?.startsWith('zenlev_') || node.name.startsWith('zenlev_'),
      ),
    ).toBe(false)
    const selected = await readBuiltinLintCatalog({ adapter, namespaces: ['secondary', 'missing'] })
    expect(selected.nodes).toContainEqual(
      expect.objectContaining({ kind: 'table', schema: 'secondary', name: 'zenlev_migrations' }),
    )
    expect(selected.gaps).toContainEqual(expect.objectContaining({ identity: 'missing' }))
    expect((await readBuiltinLintCatalog({ adapter, namespaces: [] })).nodes).toEqual([])
    expect(
      raw.query("SELECT name FROM sqlite_schema WHERE name = 'zenlev_migrations'").get(),
    ).not.toBeNull()
  } finally {
    await db.destroy()
  }
})
