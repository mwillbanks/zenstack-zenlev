import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  lintProject,
  recommendedLintConfig,
  testLintRule,
  type LintConfig,
  type LintRule,
} from '../../src'
import { runCli } from '../../src/cli'
import { createLintRunner } from '../../src/lint/runner'
import { readZModelLintInput } from '../../src/lint/zmodel'

let cwd: string
beforeEach(async () => {
  cwd = await mkdtemp(join(import.meta.dir, '.zenlev-lint-'))
})
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function write(path: string, content: string | object) {
  return Bun.write(join(cwd, path), typeof content === 'string' ? content : JSON.stringify(content))
}

const datasource = 'datasource db { provider = "sqlite" }\n'

for (const dialect of ['sqlite', 'mysql', 'postgresql'] as const) {
  test('normalizes physical ZModel evidence for ' + dialect, async () => {
    await write(
      'schema.zmodel',
      `
      datasource db { provider = "${dialect}" }
      enum Status { ACTIVE @map("active") @@map("status_values") }
      model Item {
        id String @id(map: "item_pk") @default(uuid())
        status Status @default(ACTIVE)
        createdAt DateTime @default(now()) @map("created_at")
        label String @unique
        @@index([status])
        @@map("items")
      }
    `,
    )
    const input = await readZModelLintInput({ cwd })
    const column = (name: string) =>
      input.nodes.find((node) => node.kind === 'column' && node.name === name)!
    expect(column('id').default).toBeUndefined()
    expect(column('created_at').default).toBe('CURRENT_TIMESTAMP')
    expect(column('status').default).toBe("'active'")
    expect(column('status').type).toBe(
      dialect === 'sqlite' ? 'text' : dialect === 'mysql' ? "enum('active')" : 'status_values',
    )
    expect(input.nodes).toContainEqual(
      expect.objectContaining({ kind: 'primary-key', name: 'item_pk', explicit: true }),
    )
    expect(input.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'enum-value',
        name: 'active',
        table: 'status_values',
        ...(dialect === 'postgresql' ? { schema: 'public' } : {}),
      }),
    )
    expect(
      input.nodes
        .filter((node) => node.kind === 'unique' || node.kind === 'index')
        .every((node) => node.nameKnown === false),
    ).toBe(true)
  })
}

test('escapes mapped table components in ZenStack policy identities', async () => {
  await write(
    'schema.zmodel',
    datasource +
      `
plugin policy { provider = "@zenstackhq/plugin-policy" }
model Item {
  id String @id
  @@allow('read', true)
  @@map("billing.items")
}
`,
  )
  const input = await readZModelLintInput({ cwd })
  expect(input.nodes.find((node) => node.kind === 'zenstack-policy')?.identity).toMatch(
    /^"billing\.items"\.@@allow#\d+$/,
  )
})

test('loads ZenStack AST and reports model, mapped column, and PK problems with source ranges', async () => {
  await write(
    'schema.zmodel',
    datasource +
      `
model badModel {
  key Int @id @default(autoincrement()) @map("BadKey")
  displayName String @map("display_name")
  ignored String? @ignore
  @@map("BadTable")
}
`,
  )
  const result = await lintProject({ cwd })
  expect(result.status).toBe('failed')
  expect(result.files).toBe(1)
  expect(result.diagnostics.map(({ ruleId }) => ruleId).sort()).toEqual([
    'zenlev/keys/no-sequential',
    'zenlev/keys/primary-name',
    'zenlev/naming/column-case',
    'zenlev/naming/model-case',
    'zenlev/naming/table-case',
  ])
  const finding = result.diagnostics.find(({ ruleId }) => ruleId === 'zenlev/naming/column-case')!
  expect(finding).toMatchObject({
    identity: 'BadTable.BadKey',
    source: { path: 'schema.zmodel', line: 4 },
  })
  expect(finding.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  const config: LintConfig = {
    exceptions: [
      { ruleId: finding.ruleId, fingerprint: finding.fingerprint!, reason: 'Existing column' },
    ],
  }
  expect((await lintProject({ cwd, lint: config })).suppressed).toBe(1)
  await write('schema.zmodel', datasource + 'model Item { id String @id @@map("items") }\n')
  const revised = await lintProject({ cwd, lint: config }, { maxWarnings: 0 })
  expect(revised).toMatchObject({
    diagnostics: [],
    staleExceptions: config.exceptions,
    status: 'failed',
  })
  expect(recommendedLintConfig.rules?.['zenlev/naming/table-case']).toBe('error')
})

test('reads imported models, mixins, relations, enum members, constraints and policies', async () => {
  await write(
    'related.zmodel',
    `
enum State {
  ACTIVE
}
type Audited {
  createdAt DateTime @map("created_at")
}
model Owner {
  id String @id
  items Item[]
  @@map("owners")
}
model Item with Audited {
  id String @id @default(cuid())
  ownerId String @map("owner_id")
  owner Owner @relation(fields: [ownerId], references: [id])
  state State @default(ACTIVE)
  badge String @unique
  @@index([ownerId])
  @@allow('read', true)
  @@allow('create,update', ownerId != '')
  @@map("items")
}
`,
  )
  await write(
    'schema.zmodel',
    'import "./related"\n' +
      datasource +
      '\nplugin policy { provider = "@zenstackhq/plugin-policy" }\n',
  )
  const zmodel = await readZModelLintInput({ cwd })
  expect(zmodel.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'column',
        name: 'created_at',
        source: expect.objectContaining({ path: join(cwd, 'related.zmodel') }),
      }),
      expect.objectContaining({
        kind: 'foreign-key',
        columns: ['owner_id'],
        targetTable: 'owners',
        targetColumns: ['id'],
      }),
      expect.objectContaining({ kind: 'enum-value', name: 'ACTIVE' }),
      expect.objectContaining({ kind: 'index', columns: ['owner_id'] }),
      expect.objectContaining({ kind: 'unique', columns: ['badge'] }),
      expect.objectContaining({ kind: 'zenstack-policy', command: 'read', using: 'true' }),
      expect.objectContaining({ kind: 'zenstack-policy', command: 'create,update' }),
    ]),
  )
  const audited = await lintProject({
    cwd,
    lint: {
      presets: [],
      rules: {
        'zenlev/zenstack/policies': [
          'error',
          { include: ['items.Item'], commands: ['create', 'read', 'update'] },
        ],
      },
    },
  })
  expect(audited.diagnostics).toEqual([])
})

test('loads offline config without the client module and lints migration source without imports', async () => {
  await write('zenlev.config.json', {
    clientModule: './missing.ts',
    lint: { dialect: 'sqlite', zmodel: false, sql: ['sql/*.sql'] },
  })
  await write(
    'migrations/aaaa_items.ts',
    `
throw new Error('Migration modules must stay unevaluated')
export const meta = {}
export async function up(ctx: any) {
  await ctx.db.schema.createTable('wrongTable').addColumn('id', 'text', (col: any) => col.primaryKey()).execute()
}
export async function down(ctx: any) {
  const { sql } = await import('kysely')
  await sql.raw(dynamicSql).execute(ctx.db.kysely)
}
`,
  )
  await write('sql/table.sql', 'CREATE TABLE foo (wrong_key INTEGER PRIMARY KEY)')
  const result = await lintProject({ cwd })
  expect(result.files).toBe(2)
  expect(result.diagnostics.map(({ ruleId }) => ruleId)).toContain('zenlev/keys/no-sequential')
  expect(result.diagnostics.map(({ ruleId }) => ruleId)).toContain('zenlev/naming/table-case')
  expect(result.coverage.gaps.length).toBeGreaterThan(0)
  await expect(lintProject({ cwd }, { live: true })).rejects.toThrow()
})

test('validates rule settings and resolves the plugin relative to its config layer', async () => {
  await write('package.json', {
    zenlev: {
      lint: {
        zmodel: false,
        rules: { 'zenlev/naming/table-case': 'warn' },
        dialect: 'sqlite',
        sql: ['input.sql'],
      },
    },
  })
  await write('input.sql', 'CREATE TABLE "BadTable" (id TEXT PRIMARY KEY)')
  await write('nested/settings.json', {
    lint: {
      plugins: [{ specifier: './rule.ts', name: 'project' }],
      rules: { 'project/custom': ['error', 'prohibited'] },
      overrides: [
        {
          files: ['*.sql'],
          kinds: ['table'],
          origins: ['sql'],
          dialects: ['sqlite'],
          identities: ['Bad*'],
          rules: { 'project/custom': 'warn' },
        },
        { files: ['input.sql'], rules: { 'project/custom': ['error', 'blocked'] } },
      ],
    },
  })
  await write(
    'nested/rule.ts',
    `
export default {
  meta: { name: 'example' },
  rules: { custom: { meta: { schema: [{ type: 'string' }], messages: { message: '{{ word }} {{ name }}' } },
    create(ctx: any) { return { table(node: any) {
      ctx.report({ node, messageId: 'message', data: { word: ctx.options[0], name: node.name } })
    } } } } },
}
`,
  )
  const result = await lintProject({ cwd }, {}, 'nested/settings.json')
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'project/custom',
        severity: 'error',
        message: 'blocked BadTable',
      }),
      expect.objectContaining({ ruleId: 'zenlev/naming/table-case', severity: 'warn' }),
    ]),
  )
  await expect(
    lintProject(
      { cwd, lint: { rules: { 'project/custom': ['error', 1] } } },
      {},
      'nested/settings.json',
    ),
  ).rejects.toThrow('Invalid lint options')
})

test.each([
  [{ presets: ['missing'] }, 'Unknown lint preset'],
  [{ rules: { 'missing/rule': 'warn' } }, 'Unknown lint rule'],
  [{ rules: { 'zenlev/naming/table-case': 'maybe' } }, 'Invalid severity'],
  [{ rules: { 'zenlev/naming/table-case': ['error', {}, 'second'] } }, 'Invalid lint options'],
  [{ zmodel: 'no' }, 'must be a boolean'],
  [{ migrations: 3 }, 'must be a boolean'],
  [{ dialect: false }, 'must be a nonempty string'],
  [{ sql: 31 }, 'must contain nonempty strings'],
  [{ overrides: 'bad' }, 'must be an array'],
  [{ overrides: [{ origins: ['missing'], rules: {} }] }, 'Invalid lint override origin'],
  [{ catalog: { dialect: 'sqlite' } }, 'must declare a dialect'],
  [{ exceptions: [{ ruleId: 'zenlev/keys/primary-name', reason: '' }] }, 'Invalid lint exception'],
  [{ plugins: [{ meta: { name: 'zenlev' }, rules: {} }] }, 'Invalid or duplicate lint plugin'],
  [{ plugins: [{ meta: { name: 'example' }, rules: { 'invalid key': {} } }] }, 'Invalid lint rule'],
  [{ plugins: [{ specifier: '' }] }, 'must be a nonempty string'],
] as const)('validates lint config %j', async (lint, message) => {
  await expect(createLintRunner(lint as unknown as LintConfig, cwd)).rejects.toThrow(message)
})

test('tests custom rule visitors, scope and coverage through the packaged API', async () => {
  const rule: LintRule = {
    meta: { messages: { invalid: '{{name}} is invalid' } },
    create(context) {
      return {
        '*': (node) => {
          context.gap('Unsupported property', node)
          context.report({ node, messageId: 'invalid', data: { name: node.name } })
        },
      }
    },
  }
  const node = { kind: 'table', name: 'legacy', origin: 'catalog' as const }
  expect(
    await testLintRule(rule, { nodes: [node], gaps: [], capabilities: ['tables'] }),
  ).toMatchObject({
    status: 'failed',
    diagnostics: [{ ruleId: 'test/rule', message: 'legacy is invalid', identity: 'legacy' }],
    coverage: { capabilities: ['tables'], gaps: [{ message: 'test/rule: Unsupported property' }] },
  })
  await expect(
    testLintRule(
      {
        meta: { messages: {} },
        create: ({ report }) => ({ table: (item) => report({ node: item, messageId: 'missing' }) }),
      },
      { nodes: [node], gaps: [] },
    ),
  ).rejects.toThrow('Unknown message')
})

test('blocks definite SQL routine calls when configured', async () => {
  await write('database/routines.sql', 'SELECT app.forbidden_routine();')
  const config: LintConfig = {
    zmodel: false,
    dialect: 'postgresql',
    sql: ['database/*.sql'],
    rules: {
      'zenlev/objects/restricted': ['error', { kinds: ['function'], actions: ['call'] }],
    },
  }
  const result = await lintProject({ cwd, lint: config })
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      ruleId: 'zenlev/objects/restricted',
      identity: 'app.forbidden_routine',
    }),
  ])
  await write('database/routines.sql', 'SELECT forbidden_routine();')
  const unresolved = await lintProject({ cwd, lint: config }, { maxWarnings: 0 })
  expect(unresolved.status).toBe('failed')
  expect(unresolved.diagnostics).toEqual([])
  expect(unresolved.coverage.gaps).toHaveLength(1)
})

test('applies exact object exceptions and leaves warnings available to CI', async () => {
  await write('schema.zmodel', datasource + 'model Row { id String @id @@map("BadTable") }')
  expect(
    await lintProject(
      {
        cwd,
        lint: {
          rules: { 'zenlev/naming/table-case': 'warn' },
          exceptions: [
            {
              ruleId: 'zenlev/naming/table-case',
              identity: 'BadTable',
              reason: 'Stable legacy API',
            },
          ],
        },
      },
      { maxWarnings: 0 },
    ),
  ).toMatchObject({ status: 'ok', suppressed: 1 })
  expect(
    (
      await lintProject(
        { cwd, lint: { rules: { 'zenlev/naming/table-case': 'warn' } } },
        { maxWarnings: 0 },
      )
    ).status,
  ).toBe('failed')
})

test('reports stable CLI status and keeps migration client initialization out of offline lint', async () => {
  await write('schema.zmodel', datasource + 'model Item { id String @id }')
  const stdout: string[] = []
  const stderr: string[] = []
  const cli = (args: string[]) =>
    runCli(['--cwd', cwd, 'lint', ...args], {
      create: async () => {
        throw new Error('Offline lint must avoid the migration service')
      },
      stdout: (value) => {
        stdout.push(value)
      },
      stderr: (value) => {
        stderr.push(value)
      },
    })
  expect(await cli(['--json'])).toBe(1)
  expect(JSON.parse(stdout[0]!)).toMatchObject({ status: 'error', result: { status: 'failed' } })
  expect(await cli([])).toBe(1)
  expect(stdout[1]).toContain('zenlev/naming/table-case')
  expect(await cli(['--max-warnings=-1'])).toBe(2)
  expect(stderr[0]).toContain('nonnegative integer')
  expect(await cli(['--unexpected'])).toBe(2)
  await write('schema.zmodel', datasource + 'model Item { id String @id @@map("items") }')
  expect(await cli(['--max-warnings', '0'])).toBe(0)
  await write(
    'zenlev.config.ts',
    `
    export default {
      lint: {
        catalog: {
          dialect: 'custom',
          connect({ name }) { return { physical: { name }, dispose() {} } },
          read({ physical }) { return { nodes: [], gaps: [], capabilities: [physical.name] } },
        },
      },
    }
  `,
  )
  expect(await cli(['--live', '--env', 'staging', '--json'])).toBe(0)
  expect(JSON.parse(stdout.at(-1)!).result.coverage.capabilities).toEqual(['staging'])
})

test('resolves optional ZModel, views, computed fields and PostgreSQL native types', async () => {
  expect(await readZModelLintInput({ cwd }, true)).toEqual({ nodes: [], gaps: [] })
  await expect(readZModelLintInput({ cwd })).rejects.toThrow('Schema file not found')
  await write(
    'schema.zmodel',
    `
datasource db { provider = "postgresql" }
model Owner {
  id String @id @db.Uuid
  items Item[]
  views OwnerView[]
  @@map("owners")
}
model Item {
  id String @id @default(dbgenerated("nextval('ids')"))
  owners Owner[]
  computedName String @computed
  @@map("items")
}
view OwnerView {
  id String @unique
  owners Owner[]
  @@map("owner_views")
}
`,
  )
  const result = await readZModelLintInput({ cwd })
  expect(result.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'schema', name: 'public' }),
      expect.objectContaining({ kind: 'column', table: 'owners', name: 'id', type: 'uuid' }),
      expect.objectContaining({ kind: 'column', table: 'items', name: 'id', sequential: true }),
      expect.objectContaining({ kind: 'view', name: 'owner_views' }),
      expect.objectContaining({ kind: 'field', name: 'computedName' }),
    ]),
  )
  expect(result.nodes.some(({ kind, name }) => kind === 'column' && name === 'computedName')).toBe(
    false,
  )
  expect(result.gaps.some(({ message }) => message.includes('generated join table'))).toBe(true)
  await expect(lintProject({ cwd, lint: { dialect: 'sqlite' } })).rejects.toThrow('does not match')
})

test('plain SQLite ZModel integer PK implies a rowid sequence', async () => {
  await write('schema.zmodel', datasource + 'model Item { id Int @id @@map("items") }')
  expect((await lintProject({ cwd })).diagnostics).toEqual([
    expect.objectContaining({ ruleId: 'zenlev/keys/no-sequential' }),
  ])
})

test('prints coverage gaps and stale exceptions in plain CLI output', async () => {
  await write('lint.json', {
    lint: {
      zmodel: false,
      sql: ['bad.sql'],
      dialect: 'sqlite',
      exceptions: [
        { ruleId: 'zenlev/naming/table-case', reason: 'Retired name', identity: 'old_table' },
      ],
    },
  })
  await write('bad.sql', 'CREATE TABLE')
  const lines: string[] = []
  const code = await runCli(['lint', '--cwd', cwd, '--config', 'lint.json'], {
    stdout: (value) => {
      lines.push(value)
    },
  })
  expect(code).toBe(0)
  expect(lines[0]).toContain('zenlev/coverage')
  expect(lines[0]).toContain('Stale exception')
})
