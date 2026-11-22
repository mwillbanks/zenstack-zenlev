import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dir, '..')
const options = parseArgs({
  args: process.argv.slice(2),
  options: { output: { type: 'string' } },
  strict: true,
})
const manifest = (await Bun.file(resolve(root, 'package.json')).json()) as {
  name: string
  version: string
  devDependencies: Record<string, string>
}
assert.equal(manifest.name, '@mwillbanks/zenstack-zenlev')
assert(
  await Bun.file(resolve(root, 'dist/index.js')).exists(),
  'Run bun run build before pack:check',
)

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(command.join(' ') + ' failed in packed consumer\n' + stdout + stderr)
  }
  return stdout.trim()
}

const temporary = await mkdtemp(join(tmpdir(), 'zenlev-package-'))
try {
  const packed = JSON.parse(
    await run(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root),
  ) as { filename: string; files: { path: string }[] }[]
  assert.equal(packed.length, 1)
  const archive = packed[0]!
  assert.equal(archive.filename, basename(archive.filename), 'Pack output must be a filename')
  const published = new Set(archive.files.map((file) => file.path))
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/cli.js',
    'README.md',
    'LICENSE',
  ]) {
    assert(published.has(required), 'Missing package entry ' + required)
  }
  for (const path of published) {
    assert(!/^(?:src|test|website|node_modules)\//.test(path), 'Unexpected package content ' + path)
  }

  const consumer = resolve(temporary, 'consumer')
  await mkdir(consumer)
  const archivePath = resolve(temporary, archive.filename)
  await Bun.write(
    resolve(consumer, 'package.json'),
    JSON.stringify({
      name: 'zenlev-packed-consumer',
      private: true,
      type: 'module',
      dependencies: {
        [manifest.name]: 'file:' + archivePath,
        '@zenstackhq/orm': manifest.devDependencies['@zenstackhq/orm'],
        kysely: manifest.devDependencies.kysely,
      },
      devDependencies: {
        '@types/bun': manifest.devDependencies['@types/bun'],
        typescript: manifest.devDependencies.typescript,
      },
    }),
  )
  await Bun.write(
    resolve(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'Preserve',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['bun'],
      },
      include: ['**/*.ts'],
    }),
  )
  const fixtureSources = {
    'db.ts':
      "import { Database, type SQLQueryBindings } from 'bun:sqlite'\nimport { ZenStackClient } from '@zenstackhq/orm'\nimport { SqliteDialect } from 'kysely'\nimport { resolve } from 'node:path'\n\nconst schema = {\n  provider: { type: 'sqlite' },\n  plugins: {},\n  models: {\n    Item: {\n      name: 'Item',\n      fields: {\n        id: { name: 'id', type: 'Int', id: true },\n        value: { name: 'value', type: 'String' },\n      },\n      idFields: ['id'],\n      uniqueFields: { id: { type: 'Int' } },\n    },\n  },\n} as const\n\nexport function createClient() {\n  const database = new Database(resolve(import.meta.dir, 'consumer.sqlite'))\n  const client = new ZenStackClient(schema, {\n    dialect: new SqliteDialect({\n      database: {\n        close: () => database.close(),\n        prepare(sql) {\n          const statement = database.prepare(sql)\n          return {\n            reader: statement.columnNames.length > 0,\n            all: (parameters) => statement.all(...(parameters as SQLQueryBindings[])),\n            run: (parameters) => statement.run(...(parameters as SQLQueryBindings[])),\n            iterate: (parameters) => statement.iterate(...(parameters as SQLQueryBindings[])),\n          }\n        },\n      },\n    }),\n  })\n  return { client, dispose: () => client.$disconnect() }\n}\n",
    'zenlev.config.ts':
      "import { defineConfig } from '@mwillbanks/zenstack-zenlev'\nimport { createClient } from './db'\nexport default defineConfig({ createClient })\n",
    'consumer.ts':
      "import assert from 'node:assert/strict'\nimport { createZenlev, defineConfig } from '@mwillbanks/zenstack-zenlev'\nimport { createClient } from './db'\n\nconst owned = createClient()\nconst zenlev = await createZenlev(defineConfig({ cwd: import.meta.dir, client: owned.client }))\ntry {\n  const typed = zenlev.defineMigration({\n    meta: { id: 'b12345678901234567890123', name: 'typed', namespace: 'default', createdAt: '2026-11-21T12:00:00.000Z' },\n    async up(ctx) {\n      const count: number = await ctx.zenstack.client.item.count()\n      ctx.reporter.info(String(count))\n    },\n  })\n  assert.equal(typeof typed.up, 'function')\n  const result = await zenlev.migrate.apply()\n  assert.equal(result.status, 'ok')\n  assert.equal(result.migrations.length, 1)\n  await owned.client.item.create({ data: { id: 1, value: 'packed consumer' } })\n  assert.equal(await owned.client.item.count(), 1)\n  await zenlev.migrate.create({ name: 'packed_followup', empty: true })\n  const entries = await zenlev.migrate.status()\n  assert.equal(entries.length, 2)\n  assert.equal(entries.filter((entry) => entry.status === 'pending').length, 1)\n} finally {\n  await zenlev.close()\n  await owned.dispose()\n}\n",
    'migrations/a12345678901234567890123_create_items.ts':
      "import type { MigrationCtx, MigrationMeta } from '@mwillbanks/zenstack-zenlev'\nexport const meta = {\n  id: 'a12345678901234567890123',\n  name: 'create_items',\n  namespace: 'default',\n  createdAt: '2026-11-21T12:00:00.000Z',\n} satisfies MigrationMeta\nexport async function up(ctx: MigrationCtx) {\n  await ctx.db.schema.createTable('Item')\n    .addColumn('id', 'integer', (column) => column.primaryKey())\n    .addColumn('value', 'text', (column) => column.notNull())\n    .execute()\n}\n",
  }
  for (const [path, content] of Object.entries(fixtureSources)) {
    await Bun.write(resolve(consumer, path), content)
  }
  await run([process.execPath, 'install', '--ignore-scripts'], consumer)
  await run([process.execPath, 'check', '--no-script'], consumer)
  await run([process.execPath, 'consumer.ts'], consumer)

  for (const alias of ['zenlev', 'zenstack-zenlev']) {
    const version = await run([process.execPath, 'run', '--silent', alias, '--version'], consumer)
    assert.equal(version, manifest.version, alias + ' must run the packed CLI')
    const help = await run([process.execPath, 'run', '--silent', alias, '--help'], consumer)
    assert(help.includes('migrate create | apply |'), alias + ' must expose migration commands')
  }
  const applied = JSON.parse(
    await run(
      [process.execPath, 'run', '--silent', 'zenstack-zenlev', 'migrate', 'apply', '--json'],
      consumer,
    ),
  ) as { status: string; result: { status: string } }
  assert.equal(applied.status, 'ok')
  assert.equal(applied.result.status, 'ok')
  const status = JSON.parse(
    await run(
      [process.execPath, 'run', '--silent', 'zenlev', 'migrate', 'status', '--json'],
      consumer,
    ),
  ) as { status: string; result: { status: string }[] }
  assert.equal(status.status, 'ok')
  assert.equal(status.result.length, 2)
  assert(status.result.every((entry) => entry.status === 'applied'))

  if (options.values.output !== undefined) {
    const output = resolve(options.values.output)
    await mkdir(output, { recursive: true })
    await copyFile(archivePath, resolve(output, archive.filename))
  }
  console.log(
    'Packed package passed typed API, SQLite migration, configuration, and both CLI aliases',
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
