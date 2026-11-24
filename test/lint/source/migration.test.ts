import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSqlLintInput, readMigrationLintInputs } from '../../../src/lint/source'
import { hashMigrationContent } from '../../../src/migrate/files'
import { node, source } from './fixtures'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'zenlev-lint-source-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function migration(
  body: string,
  dialect = 'sqlite',
  directions: readonly ('up' | 'down')[] = ['up'],
) {
  const path = join(directory, 'migration.ts')
  await Bun.write(path, body)
  return readMigrationLintInputs(path, dialect, directions)
}

describe('migration source inspection', () => {
  test('retains modifiers through parentheses and omits incomplete index evidence', async () => {
    const input = await migration(
      "export async function up(ctx) { await ctx.db.schema.createTable('users').addColumn('id', 'integer', (c => ((c.primaryKey()).notNull()))).execute(); await ctx.db.schema.createIndex('partial_idx').on('users').column('id').where('id', '>', 1).execute(); }",
    )
    expect(node(input, 'column', 'id')).toMatchObject({ sequential: true, nullable: false })
    expect(input.nodes.filter((item) => item.kind === 'index')).toEqual([])
    expect(input.gaps).toContainEqual(
      expect.objectContaining({
        message: 'Kysely index modifier is outside static analysis: where',
      }),
    )
  })

  test('inspects static SQL fragments and warns for opaque value-position fragments', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export async function up(ctx) { await sql\x60SELECT \x24{(sql.raw('app.hidden_fn()'))} WHERE id = \x24{ctx.id}\x60.execute(ctx.db.kysely); await sql\x60SELECT \x24{sql\x60app.other_fn()\x60}\x60.execute(ctx.db.kysely); await sql\x60SELECT * FROM users WHERE id = \x24{sql.raw(ctx.fragment)}\x60.execute(ctx.db.kysely); await sql\x60SELECT * FROM users WHERE id = \x24{helper()}\x60.execute(ctx.db.kysely); }",
      'postgresql',
    )
    expect(
      input.nodes.filter((item) => item.kind === 'function').map((item) => item.identity),
    ).toEqual(['app.hidden_fn', 'app.other_fn'])
    expect(
      input.gaps.filter((gap) => gap.message === 'Dynamic SQL structure cannot be analyzed.'),
    ).toHaveLength(2)
  })

  test('reports module initialization effects while preserving safe generated metadata', async () => {
    const input = await migration(
      "export const id = 'example'; export const dependsOn = ['prior']; const unused = () => helper(); const sideEffect = runDdl(); const nested = { effect: start() }; export async function up(ctx) {}",
    )
    expect(input.nodes).toEqual([])
    expect(input.gaps.map((gap) => gap.message)).toEqual([
      'Top-level migration initialization may execute before lint enforcement.',
      'Top-level migration initialization may execute before lint enforcement.',
    ])
  })

  test('keeps object and class method bodies deferred during module inspection', async () => {
    const input = await migration(
      'const object = { run(value = prepare()) { helper() }, get value() { return read() }, set value(value) { save(value) } }; const Model = class { field = initialize(); constructor(value = prepare()) { helper() } run(value = prepare()) { helper() } static run() { helper() } get value() { return read() } set value(value) { save(value) } }; export function up() {}',
    )
    expect(input).toMatchObject({ nodes: [], gaps: [] })
  })

  test.each([
    '({ [methodKey()]() { deferred() } })',
    '({ get [accessorKey()]() { return deferred() } })',
    '({ set [accessorKey()](value) { deferred(value) } })',
    '(class { [methodKey()]() { deferred() } })',
    '(class { [fieldKey()] = deferred() })',
    '(class { static field = initialize() })',
    '(class { static { initialize() } })',
    '(class extends baseFactory() {})',
    '(class { @decorate() method() { deferred() } })',
    '(() => { immediate() })()',
    '({ method() { immediate() } }).method()',
    'new (class { constructor() { immediate() } })()',
  ])('reports eager initializer effects in %s', async (initializer) => {
    const input = await migration('const value = ' + initializer + '; export function up() {}')
    expect(input.nodes).toEqual([])
    expect(input.gaps.map((gap) => gap.message)).toEqual([
      'Top-level migration initialization may execute before lint enforcement.',
    ])
  })

  test.each([
    ['@decorate class {}', '@decorate'],
    ['(class { @decorate method() {} })', '@decorate'],
    ['(class { @decorate field = deferred() })', '@decorate'],
    ['(class { constructor(@decorate value: string) {} })', '@decorate'],
    ['(class { constructor(@decorate public value: string) {} })', '@decorate'],
    ['(class { @decorate accessor field = deferred() })', '@decorate'],
    ['(class { method(@factory() value: string) {} })', '@factory()'],
  ])('reports eager decorator applications in %s', async (initializer, decorator) => {
    const body = 'const value = ' + initializer + '; export function up() {}'
    const input = await migration(body)
    const offset = body.indexOf(decorator)
    expect(input.gaps).toEqual([
      expect.objectContaining({
        message: 'Top-level migration initialization may execute before lint enforcement.',
        source: expect.objectContaining({
          line: 1,
          column: offset + 1,
          endColumn: offset + decorator.length + 1,
        }),
      }),
    ])
  })

  test('warns about dynamic module loads without executing them', async () => {
    const input = await migration(`
      import { sql } from 'kysely'
      const eager = import('./eager.ts')
      export async function up(ctx, fallback = import('./fallback.ts')) {
        await import('./up.ts')
        await sql\`SELECT * FROM users WHERE id = \${(await import('./bound.ts')).id}\`.execute(ctx.db.kysely)
      }
      export async function down() {
        await import('./down.ts')
      }
    `)
    expect(input.gaps.map(({ message, source }) => [message, source?.line])).toEqual([
      ['Top-level migration initialization may execute before lint enforcement.', 3],
      ['Dynamically imported migration module cannot be inspected.', 4],
      ['Dynamically imported migration module cannot be inspected.', 5],
      ['Dynamically imported migration module cannot be inspected.', 6],
    ])
  })

  test('inspects SQL evaluated inside a dynamic import expression', async () => {
    const input = await migration(`
      import { sql } from 'kysely'
      export async function up(ctx) {
        await import((await sql.raw('CREATE VIEW handler_view AS SELECT 1').execute(ctx.db.kysely), './helper.ts'))
        await sql\`SELECT * FROM users WHERE id = \${(await import((await sql.raw('CREATE VIEW bound_view AS SELECT 1').execute(ctx.db.kysely), './bound.ts'))).id}\`.execute(ctx.db.kysely)
      }
    `)
    expect(input.nodes.filter(({ kind }) => kind === 'view').map(({ name }) => name)).toEqual([
      'handler_view',
      'bound_view',
    ])
    expect(input.gaps.map(({ message }) => message)).toEqual([
      'Dynamically imported migration module cannot be inspected.',
      'Dynamically imported migration module cannot be inspected.',
    ])
  })

  test('never imports modules and respects handler direction', async () => {
    const input = await migration(
      "import { sql as query } from 'kysely'; throw new Error('must never run'); export async function up(ctx) { await query.raw('CREATE TABLE users (id text PRIMARY KEY)').execute(ctx.db.kysely) } export async function down(ctx) { await query.raw('DROP TABLE users').execute(ctx.db.kysely) }",
    )
    expect(node(input, 'table')).toMatchObject({
      name: 'users',
      action: 'create',
      origin: 'migration',
    })
    expect(input.nodes.some((item) => item.action === 'drop')).toBe(false)
  })
  test('reads tagged SQL without substitutions', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export async function up(ctx) { await sql`CREATE TABLE items (id text PRIMARY KEY)`.execute(ctx.db.kysely) }",
    )
    expect(input.nodes).toContainEqual(expect.objectContaining({ kind: 'table', name: 'items' }))
    expect(input.gaps).toEqual([])
  })

  test('reads arrow handlers and both directions', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export const up = async ctx => { await sql.raw('CREATE VIEW v AS SELECT 1').execute(ctx.db.kysely) }; export const down = async ctx => { await sql.raw('DROP VIEW v').execute(ctx.db.kysely) };",
      'sqlite',
      ['up', 'down'],
    )
    expect(input.nodes.map((item) => item.action)).toEqual(['create', 'drop'])
  })
  test('accepts bound values and reports structural interpolation', async () => {
    const tick = String.fromCharCode(96)
    const value = '$' + '{ctx.id}'
    const table = '$' + '{ctx.table}'
    const body =
      "import { sql } from 'kysely'; export async function up(ctx) { await sql" +
      tick +
      'SELECT * FROM users WHERE id = ' +
      value +
      tick +
      '.execute(ctx.db.kysely); await sql' +
      tick +
      'CREATE TABLE ' +
      table +
      '(id text)' +
      tick +
      '.execute(ctx.db.kysely); }'
    const input = await migration(body)
    expect(input.gaps.filter((gap) => gap.message.includes('Dynamic SQL structure'))).toHaveLength(
      1,
    )
  })
  test('preserves SQL analysis gaps inside migration templates with bound values', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export async function up(ctx) { await sql`SELECT custom_function() WHERE 1 = ${ctx.value}`.execute(ctx.db.kysely) }",
    )
    expect(input.gaps).toContainEqual(
      expect.objectContaining({
        identity: 'custom_function',
        message: expect.stringContaining('cannot be resolved'),
        source: expect.objectContaining({ line: 1, endLine: 1 }),
      }),
    )
  })

  test('reports dynamic raw text and opaque helpers', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export async function up(ctx) { await sql.raw(ctx.sql).execute(ctx.db.kysely); await helper(ctx); }",
    )
    expect(input.gaps.map((gap) => gap.message)).toContain('Dynamic SQL text cannot be analyzed.')
    expect(input.gaps.some((gap) => gap.message.includes('Migration call'))).toBe(true)
  })
  test.each(['sqlite', 'postgresql', 'mysql'])(
    'reads Kysely %s columns and indexes',
    async (dialect) => {
      const input = await migration(
        "export async function up(ctx) { await ctx.db.schema.createTable('users').ifNotExists().addColumn('id', 'integer', c => c.primaryKey().notNull().autoIncrement()).addColumn('email','text',c => c.unique().defaultTo('pending')).addColumn('parent_id','integer',c=>c.references('parents.id').onDelete('cascade').onUpdate('restrict')).execute(); await ctx.db.schema.createIndex('idx_users_email').on('users').columns(['email']).unique().execute(); await ctx.db.schema.dropIndex('old_idx').on('users').execute(); await ctx.db.schema.dropTable('old_table').execute(); }",
        dialect,
      )
      expect(input.gaps).toEqual([])
      expect(node(input, 'column', 'id').sequential).toBe(true)
      expect(node(input, 'column', 'email').default).toBe("'pending'")
      expect(node(input, 'foreign-key').targetTable).toBe('parents')
      expect(node(input, 'index', 'idx_users_email')).toMatchObject({
        unique: true,
        columns: ['email'],
      })
    },
  )
  test('reads Kysely table constraints and literal defaults', async () => {
    const input = await migration(
      "import {sql} from 'kysely'; export async function up(ctx) { await ctx.db.schema.createTable('links').addColumn('id','text').addColumn('scope','text', c=>c.defaultTo(null)).addColumn('active','boolean',c=>c.defaultTo(true)).addColumn('disabled','boolean',c=>c.defaultTo(false)).addColumn('count','integer',c=>c.defaultTo(3)).addPrimaryKeyConstraint('links_pk',['id','scope']).addForeignKeyConstraint('links_fk',['scope'],'scopes',['id']).addUniqueConstraint('links_uniq',['id']).addCheckConstraint('count_check',sql.raw('count > 0')).execute(); await ctx.db.schema.createIndex('count_idx').on('links').column('count').execute(); }",
    )
    expect(input.gaps).toEqual([])
    expect(node(input, 'primary-key').columns).toEqual(['id', 'scope'])
    expect(node(input, 'foreign-key')).toMatchObject({ name: 'links_fk', targetTable: 'scopes' })
    expect(node(input, 'check').name).toBe('count_check')
    expect(node(input, 'column', 'scope').default).toBe('NULL')
  })
  test('reports unsupported Kysely arguments and modifiers', async () => {
    const input = await migration(
      "export async function up(ctx) { await ctx.db.schema.createTable(ctx.name).execute(); await ctx.db.schema.createTable('users').addColumn(ctx.col,'text').addColumn('id',ctx.type).addColumn('name','text',c=>{ return c.notNull() }).addColumn('a','text',c=>c.defaultTo(ctx.value).references(ctx.target).onDelete(ctx.action).unknown()).addPrimaryKeyConstraint(ctx.constraint,['id']).addForeignKeyConstraint('fk',['a'],ctx.table,['id']).addCheckConstraint('ck',ctx.expression).unknown().execute(); await ctx.db.schema.createIndex('idx').using(ctx.method).execute(); }",
    )
    expect(input.gaps.length).toBeGreaterThan(8)
  })
  test('resolves literal Kysely schemas and checks portable declarations without a dialect', async () => {
    const input = await migration(
      "export async function up(ctx) { await ctx.db.schema.withSchema('app').createTable('users').addColumn('id','text',c=>c.primaryKey()).execute(); }",
      'postgresql',
    )
    expect(node(input, 'table')).toMatchObject({ schema: 'app', name: 'users' })
    const path = join(directory, 'portable.ts')
    await Bun.write(
      path,
      "export async function up(ctx) { await ctx.db.schema.createTable('BadTable').addColumn('badColumn','integer',c=>c.primaryKey()).execute(); await unknown.execute(); }",
    )
    const portable = await readMigrationLintInputs(path, undefined, ['up'])
    expect(node(portable, 'table')).toMatchObject({ name: 'BadTable' })
    expect(node(portable, 'column').sequential).toBeUndefined()
    expect(portable.gaps.some((gap) => gap.message.includes('Executed query'))).toBe(true)
  })
  test('folds PostgreSQL identifiers and preserves authored spelling', async () => {
    const input = await parseSqlLintInput(
      'CREATE TABLE App.Users (UserId text PRIMARY KEY);',
      'postgresql',
      source,
    )
    expect(node(input, 'table')).toMatchObject({ name: 'users', schema: 'app', spelling: 'Users' })
    expect(node(input, 'column')).toMatchObject({ name: 'userid', spelling: 'UserId' })
    const unicode = await parseSqlLintInput(
      "SELECT '🦊'; CREATE TABLE users (id TEXT PRIMARY KEY);",
      'sqlite',
      source,
    )
    expect(node(unicode, 'table').source?.column).toBe(27)
  })
  test('maps direct literal positions after the opening quote and anchors transformed SQL', async () => {
    const direct =
      "import {sql} from 'kysely'; export async function up(ctx) { await sql.raw('CREATE TABLE users (id text PRIMARY KEY)').execute(ctx.db.kysely) }"
    const input = await migration(direct)
    expect(node(input, 'table').source).toMatchObject({
      line: 1,
      column: direct.indexOf('users') + 1,
      endColumn: direct.indexOf('users') + 6,
    })
    const escaped =
      "import {sql} from 'kysely'; export async function up(ctx) { await sql.raw('CREATE\\nTABLE users (id text PRIMARY KEY)').execute(ctx.db.kysely) }"
    const transformed = await migration(escaped)
    expect(node(transformed, 'table').source).toMatchObject({
      line: 1,
      column: escaped.indexOf("'CREATE") + 1,
      endLine: 1,
    })
    expect(node(transformed, 'table').source?.endColumn).toBeLessThanOrEqual(escaped.length + 1)
    const builder =
      "export async function up(ctx) { await ctx.db.schema.createTable('users').addColumn('id','text',c=>c.primaryKey()).execute() }"
    const generated = await migration(builder)
    expect(node(generated, 'table').source).toMatchObject({
      line: 1,
      column: builder.indexOf('ctx.db.schema') + 1,
    })
    expect(node(generated, 'column').source).toEqual(node(generated, 'table').source)
  })
  test('preserves SQL source columns after non-ASCII migration text', async () => {
    const body =
      "import {sql} from 'kysely'; const marker = '🦊'; export async function up(ctx) { await sql.raw('CREATE TABLE users (id text PRIMARY KEY)').execute(ctx.db.kysely) }"
    const result = await migration(body)
    const start = body.indexOf('users') + 1
    expect(node(result, 'table').source).toMatchObject({
      line: 1,
      column: start,
      endColumn: start + 'users'.length,
    })
  })

  test('reports unresolved exported handlers and preserves optional down coverage', async () => {
    const reexported = await migration("export { helper as up } from './other';", 'sqlite', [
      'up',
      'down',
    ])
    expect(reexported.gaps).toHaveLength(1)
    expect(reexported.gaps[0]?.message).toContain('Re-exported migration handler')
    const wildcard = await migration("export * from './other';")
    expect(wildcard.gaps[0]?.message).toContain('Re-exported migration handlers')
    const indirect = await migration("import { helper } from './other'; export const up = helper;")
    expect(indirect.gaps[0]?.message).toContain('implementation cannot be inspected')
    const local = await migration('function up() {} export {up};', 'sqlite', ['up', 'down'])
    expect(local.gaps).toEqual([])
  })
  test('reports incomplete Kysely index operations as coverage gaps', async () => {
    const result = await migration(
      `
      export async function up(ctx) {
        await ctx.db.schema.dropIndex('old_idx').execute()
        await ctx.db.schema.createIndex('new_idx').on('items').execute()
      }
    `,
      'mysql',
    )
    expect(result.nodes).toEqual([])
    expect(result.gaps.map(({ message }) => message)).toEqual([
      'MySQL DROP INDEX requires a statically known table.',
      'Kysely schema definition requires manual review.',
    ])
  })
  test('rejects malformed TypeScript before producing partial lint evidence', async () => {
    await expect(migration('export async function up( {')).rejects.toThrow(
      'Invalid migration TypeScript',
    )
  })
  test('keeps source fingerprints independent of configured migration hash algorithms', async () => {
    const path = join(directory, 'fingerprint.ts')
    const text =
      "import {sql} from 'kysely';\r\nexport async function up(ctx) { await sql.raw('CREATE TABLE users(id text PRIMARY KEY)').execute(ctx.db.kysely) }"
    await Bun.write(path, text)
    const offline = await readMigrationLintInputs(path, 'sqlite', ['up'])
    const guarded = await readMigrationLintInputs(path, 'sqlite', ['up'], {
      hash: hashMigrationContent(text, { algorithm: 'sha512' }),
      hashing: { algorithm: 'sha512' },
    })
    expect(node(guarded, 'table').source?.fingerprint).toBe(
      node(offline, 'table').source?.fingerprint,
    )
    expect(node(guarded, 'table').source?.fingerprint).toBe(
      hashMigrationContent(text, { algorithm: 'sha256', normalizeLineEndings: false }),
    )
  })
  test('rejects non-files, symlinks and stale hashes', async () => {
    const path = join(directory, 'guarded.ts')
    const text = 'export function up() {}'
    await Bun.write(path, text)
    await expect(
      readMigrationLintInputs(path, 'sqlite', ['up'], { hash: hashMigrationContent(text) }),
    ).resolves.toMatchObject({ nodes: [], gaps: [] })
    await expect(
      readMigrationLintInputs(path, 'sqlite', ['up'], { hash: 'changed' }),
    ).rejects.toThrow('hash changed')
    await expect(readMigrationLintInputs(directory, 'sqlite', ['up'])).rejects.toThrow(
      'regular file',
    )
    const link = join(directory, 'linked.ts')
    await symlink(path, link)
    await expect(readMigrationLintInputs(link, 'sqlite', ['up'])).rejects.toThrow('regular file')
  })
  test.each(['postgresql', 'mysql', 'sqlite'])(
    'projects %s builder evidence consistently with SQL declarations',
    async (dialect) => {
      const input = await migration(
        "export async function up(ctx) { await ctx.db.schema.createTable('links').addColumn('left_id','text',c=>c.notNull()).addColumn('right_id','text').addPrimaryKeyConstraint('links_pk',['left_id','right_id']).addUniqueConstraint('links_unique',['right_id']).addForeignKeyConstraint('links_fk',['left_id'],'parents',['id']).execute(); await ctx.db.schema.createIndex('links_idx').on('links').columns(['left_id','right_id']).unique().execute(); }",
        dialect,
      )
      const sql = await parseSqlLintInput(
        'CREATE TABLE links (left_id text NOT NULL, right_id text, CONSTRAINT links_pk PRIMARY KEY(left_id,right_id), CONSTRAINT links_unique UNIQUE(right_id), CONSTRAINT links_fk FOREIGN KEY(left_id) REFERENCES parents(id)); CREATE UNIQUE INDEX links_idx ON links(left_id,right_id);',
        dialect,
        source,
      )
      const facts = (items: typeof input.nodes) =>
        items.map(
          ({
            kind,
            name,
            table,
            columns,
            type,
            nullable,
            sequential,
            unique,
            targetTable,
            targetColumns,
          }) => ({
            kind,
            name,
            table,
            columns,
            type,
            nullable,
            sequential: !!sequential,
            unique,
            targetTable,
            targetColumns,
          }),
        )
      expect(input.gaps).toEqual([])
      expect(facts(input.nodes)).toEqual(facts(sql.nodes))
    },
  )

  test('keeps mixed raw SQL and structured index operations in execution order', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export async function up(ctx) { await ctx.db.schema.createIndex('links_idx').on('links').column('id').execute(); await sql.raw('DROP INDEX links_idx').execute(ctx.db.kysely); await ctx.db.schema.createTable('next_table').addColumn('id','text').execute(); await sql.raw('DROP TABLE next_table').execute(ctx.db.kysely); }",
      'postgresql',
    )
    expect(input.gaps).toEqual([])
    expect(
      input.nodes
        .filter(({ kind }) => kind !== 'column')
        .map(({ kind, name, action }) => [kind, name, action]),
    ).toEqual([
      ['index', 'links_idx', 'create'],
      ['index', 'links_idx', 'drop'],
      ['table', 'next_table', 'create'],
      ['table', 'next_table', 'drop'],
    ])
  })

  test('inspects the selected down builder without evaluating module code', async () => {
    const input = await migration(
      "throw new Error('must stay offline'); export async function up(ctx) { await ctx.db.schema.createTable('users').addColumn('id','text').execute(); } export async function down(ctx) { await ctx.db.schema.dropTable('users').execute(); }",
      'postgresql',
      ['down'],
    )
    expect(input.nodes.map(({ kind, name, action }) => [kind, name, action])).toEqual([
      ['table', 'users', 'drop'],
    ])
    expect(node(input, 'table').source?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  test('uses known dialects for SQLite rowid and serial inference', async () => {
    const path = join(directory, 'dialect-facts.ts')
    await Bun.write(
      path,
      "export async function up(ctx) { await ctx.db.schema.createTable('users').addColumn('id','integer',c=>c.primaryKey()).addColumn('other','serial').execute(); }",
    )
    const portable = await readMigrationLintInputs(path, undefined, ['up'])
    expect(node(portable, 'column', 'id').sequential).toBeUndefined()
    expect(node(portable, 'column', 'other').sequential).toBeUndefined()
    expect(portable.gaps).toEqual([])
    const sqlite = await readMigrationLintInputs(path, 'sqlite', ['up'])
    expect(node(sqlite, 'column', 'id')).toMatchObject({ sequential: true, nullable: false })
    expect(node(sqlite, 'column', 'other').sequential).toBeUndefined()
    const postgres = await readMigrationLintInputs(path, 'postgresql', ['up'])
    expect(node(postgres, 'column', 'id')).toMatchObject({ sequential: false, nullable: false })
    expect(node(postgres, 'column', 'other').sequential).toBe(true)
  })

  test('analyzes embedded expressions without reconstructing a SQL statement', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export async function up(ctx) { await ctx.db.schema.withSchema('app').createTable('users').addColumn('id','bigint',c=>c.primaryKey().defaultTo(sql.raw(\"pg_catalog.nextval('users_id_seq')\"))).addColumn('value','text',c=>c.defaultTo(sql.raw('app.compute_value()'))).addCheckConstraint('users_check',sql.raw('app.allowed(value)')).execute(); }",
      'postgresql',
    )
    expect(node(input, 'column', 'id').sequential).toBe(true)
    expect(
      input.nodes.filter(({ kind }) => kind === 'function').map(({ identity }) => identity),
    ).toEqual(['pg_catalog.nextval', 'app.compute_value', 'app.allowed'])
    expect(input.gaps).toEqual([])
    expect(input.nodes.every(({ source }) => source?.line === 1 && source.fingerprint)).toBe(true)
  })

  test('gaps opaque modifier roots and missing or dynamic index definitions', async () => {
    const input = await migration(
      "export async function up(ctx) { await ctx.db.schema.createTable('users').addColumn('id','text',c=>helper(c).primaryKey()).execute(); await ctx.db.schema.createIndex('empty').execute(); await ctx.db.schema.createIndex('dynamic').on('users').column(ctx.column).execute(); }",
    )
    expect(input.nodes.filter(({ kind }) => kind === 'primary-key' || kind === 'index')).toEqual([])
    expect(input.gaps.map(({ message }) => message)).toEqual([
      'Kysely modifier callback requires manual review.',
      'Kysely schema definition requires manual review.',
      'Dynamic Kysely index column cannot be analyzed.',
    ])
  })

  test('keeps sequence-like literal defaults and user routines distinct from sequence calls', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export async function up(ctx) { await ctx.db.schema.createTable('users').addColumn('literal','text',c=>c.defaultTo('nextval(')).addColumn('quoted','text',c=>c.defaultTo(sql.raw(\"'nextval('\"))).addColumn('custom','text',c=>c.defaultTo(sql.raw('app.nextval()'))).addColumn('uppercase','text',c=>c.defaultTo(sql.raw('\"NEXTVAL\"()'))).addColumn('native','bigint',c=>c.defaultTo(sql.raw(\"pg_catalog.nextval('s')\"))).execute(); }",
      'postgresql',
    )
    for (const name of ['literal', 'quoted', 'custom', 'uppercase'])
      expect(node(input, 'column', name).sequential).toBe(false)
    expect(node(input, 'column', 'native').sequential).toBe(true)
    expect(input.gaps.map(({ identity }) => identity)).toEqual(['NEXTVAL'])
  })

  test('marks opaque CHECK and default evidence while retaining proven fields', async () => {
    const input = await migration(
      "export async function up(ctx) { await ctx.db.schema.createTable('users').addColumn('unknown','text',c=>{return c.defaultTo(ctx.value)}).addColumn('known','text',c=>c.defaultTo('ready').unknown()).addColumn('dynamic','text',c=>c.defaultTo(ctx.value)).addCheckConstraint(ctx.name,ctx.expression).execute(); }",
    )
    expect(node(input, 'table')).toMatchObject({ checksKnown: false, partial: true })
    expect(node(input, 'column', 'unknown')).toMatchObject({ partial: true, nullable: undefined })
    expect(Object.hasOwn(node(input, 'column', 'unknown'), 'default')).toBe(false)
    expect(node(input, 'column', 'known')).toMatchObject({ partial: true, default: "'ready'" })
    expect(node(input, 'column', 'dynamic').partial).toBe(true)
    expect(input.nodes.filter(({ kind }) => kind === 'check')).toEqual([])
    expect(input.gaps).toHaveLength(4)
  })
  test.each(['postgresql', 'mysql', 'sqlite'])(
    'retains literal dotted %s index names and ordered column lists',
    async (dialect) => {
      const input = await migration(
        "export async function up(ctx) { await ctx.db.schema.withSchema('app').createIndex('dot.index').on('records').column('one desc').columns(['two asc']).execute(); await ctx.db.schema.withSchema('app').dropIndex('dot.index').on('records').execute(); await ctx.db.schema.dropIndex('app.idx').on('records').execute(); }",
        dialect,
      )
      expect(input.gaps).toEqual([])
      const indexes = input.nodes.filter(({ kind }) => kind === 'index')
      expect(indexes[0]).toMatchObject({
        name: 'dot.index',
        schema: 'app',
        table: 'records',
        identity: 'app.records."dot.index"',
        columns: ['one', 'two'],
      })
      expect(indexes[1]).toMatchObject({
        name: 'dot.index',
        schema: 'app',
        table: 'records',
        identity: 'app.records."dot.index"',
        action: 'drop',
      })
      expect(indexes[2]).toMatchObject({
        name: 'app.idx',
        identity: 'records."app.idx"',
        action: 'drop',
      })
      const quote = dialect === 'mysql' ? String.fromCharCode(96) : '"'
      const sql = await parseSqlLintInput(
        'CREATE INDEX ' + quote + 'dot.index' + quote + ' ON records(one DESC,two ASC);',
        dialect,
        source,
      )
      expect(sql.gaps).toEqual([])
      expect(node(sql, 'index')).toMatchObject({
        name: indexes[0]!.name,
        table: indexes[0]!.table,
        columns: indexes[0]!.columns,
      })
    },
  )

  test('does not infer SQLite rowid or nullability through an opaque table suffix', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export async function up(ctx) { await ctx.db.schema.createTable('records').addColumn('id','integer',c=>c.primaryKey()).modifyEnd(sql.raw('without rowid')).execute(); await ctx.db.schema.createTable('explicit').addColumn('id','integer',c=>c.primaryKey().autoIncrement().notNull()).unknown().execute(); }",
    )
    const inferred = input.nodes.find(
      ({ kind, table }) => kind === 'column' && table === 'records',
    )!
    const explicit = input.nodes.find(
      ({ kind, table }) => kind === 'column' && table === 'explicit',
    )!
    expect(inferred.sequential).toBeUndefined()
    expect(inferred.nullable).toBeUndefined()
    expect(explicit).toMatchObject({ sequential: true, nullable: false })
    expect(input.gaps).toHaveLength(2)
  })

  test('handles tagged default expressions and foreign-key modifier callbacks directly', async () => {
    const input = await migration(
      "import { sql } from 'kysely'; export async function up(ctx) { await ctx.db.schema.createTable('records').addColumn('id','bigint',c=>c.defaultTo(sql.raw('pg_catalog.nextval(1)'))).addColumn('status','text',c=>c.defaultTo(sql\x60'ready'\x60)).addForeignKeyConstraint('fk',['id'],'parents',['id'],c=>c.onDelete('cascade').onUpdate('restrict')).addForeignKeyConstraint('opaque_fk',['id'],'parents',['id'],c=>c.unknown()).execute(); }",
      'postgresql',
    )
    expect(node(input, 'column', 'id').sequential).toBe(true)
    expect(node(input, 'column', 'status').default).toBe("'ready'")
    expect(input.nodes.filter(({ kind }) => kind === 'foreign-key')).toHaveLength(2)
    expect(input.gaps.map(({ message }) => message)).toEqual([
      'Kysely foreign key modifier requires manual review.',
    ])
    const path = join(directory, 'unknown-expression.ts')
    await Bun.write(
      path,
      "import {sql} from 'kysely'; export async function up(ctx) { await ctx.db.schema.createTable('records').addColumn('value','text',c=>c.defaultTo(sql.raw('app.value()'))).execute() }",
    )
    const portable = await readMigrationLintInputs(path, undefined, ['up'])
    expect(portable.gaps.map(({ message }) => message)).toEqual([
      'SQL expression analysis requires a supported dialect.',
    ])
  })
})
