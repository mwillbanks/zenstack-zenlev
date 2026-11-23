import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dir, '..')
const skillNames = [
  'zenlev-deployment-planning',
  'zenlev-migration-authoring',
  'zenlev-plugin-authoring',
  'zenlev-recovery',
  'zenlev-schema-diff',
  'zenlev-setup',
]
const planScript = 'skills/zenlev-deployment-planning/scripts/check-plan.ts'
const intentCli = resolve(root, 'node_modules/@tanstack/intent/dist/cli.mjs')
type SkillCatalog = {
  skills: { use: string; packageName: string; packageVersion: string; skillName: string }[]
}
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

async function run(command: string[], cwd: string, expectFailure = false): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (expectFailure) {
    assert.notEqual(exitCode, 0, command.join(' ') + ' must refuse unauthorized guidance')
    return (stdout + stderr).trim()
  }
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
    ...skillNames.map((name) => 'skills/' + name + '/SKILL.md'),
    planScript,
  ]) {
    assert(published.has(required), 'Missing package entry ' + required)
  }
  for (const path of published) {
    assert(!/^(?:src|test|website|node_modules)\//.test(path), 'Unexpected package content ' + path)
  }

  assert.deepEqual(
    [...published].filter((path) => path.startsWith('skills/')).sort(),
    [...skillNames.map((name) => 'skills/' + name + '/SKILL.md'), planScript].sort(),
  )
  const untrustedName = 'zenlev-untrusted-fixture'
  const untrusted = resolve(temporary, untrustedName)
  await mkdir(untrusted)
  await Bun.write(
    resolve(untrusted, 'package.json'),
    JSON.stringify({
      name: untrustedName,
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      keywords: ['tanstack-intent'],
      repository: 'https://github.com/mwillbanks/zenstack-zenlev.git',
      scripts: {
        preinstall: 'bun ./index.js',
        install: 'bun ./index.js',
        postinstall: 'bun ./index.js',
      },
    }),
  )
  await Bun.write(
    resolve(untrusted, 'index.js'),
    "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./executed', import.meta.url), 'unsafe')\nthrow new Error('Dependency code must never execute')\n",
  )
  await Bun.write(
    resolve(untrusted, 'skills/untrusted/SKILL.md'),
    '---\nname: untrusted\ndescription: Unlisted fixture guidance that must remain unavailable.\n---\nDo not load this fixture.\n',
  )

  const consumer = resolve(temporary, 'consumer')
  await mkdir(consumer)
  const archivePath = resolve(temporary, archive.filename)
  await Bun.write(
    resolve(consumer, 'package.json'),
    JSON.stringify({
      name: 'zenlev-packed-consumer',
      private: true,
      type: 'module',
      intent: { skills: skillNames.map((name) => manifest.name + '#' + name) },
      dependencies: {
        [untrustedName]: 'file:' + untrusted,
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
    'lint-consumer.ts': `import assert from 'node:assert/strict'
import { lintPlugin, lintProject, recommendedLintConfig, type LintResult } from '@mwillbanks/zenstack-zenlev'
assert.equal(lintPlugin().name, 'zenlev-lint')
const result: LintResult = await lintProject({
  cwd: import.meta.dir,
  lint: { ...recommendedLintConfig, zmodel: false, migrations: false },
})
assert.equal(result.status, 'ok')
`,
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
  const intent = (...args: string[]) => [process.execPath, intentCli, ...args]
  const catalog = JSON.parse(await run(intent('list', '--json'), consumer)) as SkillCatalog
  assert.deepEqual(catalog.skills.map((skill) => skill.skillName).sort(), skillNames)
  for (const skill of catalog.skills) {
    assert.equal(skill.packageName, manifest.name)
    assert.equal(skill.packageVersion, manifest.version)
    assert.equal(skill.use, manifest.name + '#' + skill.skillName)
    const relative = 'skills/' + skill.skillName + '/SKILL.md'
    const content = await Bun.file(
      resolve(consumer, 'node_modules', manifest.name, relative),
    ).text()
    assert.equal(content, await Bun.file(resolve(root, relative)).text())
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
    assert(frontmatter, relative + ' must contain frontmatter')
    const metadata = Bun.YAML.parse(frontmatter[1]!) as {
      name: string
      metadata: { library_version: string }
    }
    assert.equal(metadata.name, skill.skillName)
    assert.equal(metadata.metadata.library_version, manifest.version)
  }
  const identifier = manifest.name + '#zenlev-plugin-authoring'
  const loaded = JSON.parse(await run(intent('load', identifier, '--json'), consumer)) as {
    package: string
    skill: string
    version: string
    content: string
  }
  assert.equal(loaded.package, manifest.name)
  assert.equal(loaded.skill, 'zenlev-plugin-authoring')
  assert.equal(loaded.version, manifest.version)
  assert.equal(
    loaded.content,
    await Bun.file(
      resolve(consumer, 'node_modules', manifest.name, 'skills/zenlev-plugin-authoring/SKILL.md'),
    ).text(),
  )
  const consumerManifest = await Bun.file(resolve(consumer, 'package.json')).json()
  const fixtureIdentifier = untrustedName + '#untrusted'
  consumerManifest.intent.skills.push(fixtureIdentifier)
  await Bun.write(resolve(consumer, 'package.json'), JSON.stringify(consumerManifest))
  const fixtureCatalog = JSON.parse(await run(intent('list', '--json'), consumer)) as SkillCatalog
  assert(
    fixtureCatalog.skills.some((skill) => skill.use === fixtureIdentifier),
    'The fixture must be discoverable before testing its allowlist denial',
  )
  consumerManifest.intent.skills = consumerManifest.intent.skills.filter(
    (identifier: string) => identifier !== fixtureIdentifier,
  )
  await Bun.write(resolve(consumer, 'package.json'), JSON.stringify(consumerManifest))
  await run(intent('load', fixtureIdentifier, '--json'), consumer, true)
  const excluded = manifest.name + '#zenlev-recovery'
  consumerManifest.intent.exclude = [excluded]
  await Bun.write(resolve(consumer, 'package.json'), JSON.stringify(consumerManifest))
  const filtered = JSON.parse(await run(intent('list', '--json'), consumer)) as SkillCatalog
  assert.deepEqual(
    filtered.skills.map((skill) => skill.skillName).sort(),
    skillNames.filter((name) => name !== 'zenlev-recovery'),
  )
  await run(intent('load', excluded, '--json'), consumer, true)
  for (const fixtureRoot of [untrusted, resolve(consumer, 'node_modules', untrustedName)]) {
    assert.equal(
      await Bun.file(resolve(fixtureRoot, 'executed')).exists(),
      false,
      'Discovery and installation must not execute dependency code',
    )
  }
  await run([process.execPath, 'check', '--no-script'], consumer)
  const postDeploy = resolve(consumer, 'migrations/a12345678901234567890124_contract.ts')
  try {
    await Bun.write(
      postDeploy,
      `export const meta = {
      id: 'a12345678901234567890124', name: 'contract', namespace: 'post-deploy',
      dependsOn: ['a12345678901234567890123'], createdAt: '2026-11-21T12:00:00Z',
    }
    export function up() {}
    `,
    )
    const command = [
      process.execPath,
      'run',
      '--silent',
      'zenlev',
      'migrate',
      'apply',
      '--plan-only',
      '--json',
    ]
    const planInput = resolve(consumer, 'plan.json')
    const helper = [
      process.execPath,
      resolve(consumer, 'node_modules', manifest.name, planScript),
      planInput,
    ]
    for (const [args, expectedExit] of [
      [[], 0],
      [['--namespace', 'post-deploy'], 1],
    ] as const) {
      const preview = await Bun.spawn([...command, ...args], { cwd: consumer, stdout: 'pipe' })
      const json = await new Response(preview.stdout).text()
      assert.equal(await preview.exited, expectedExit)
      await Bun.write(planInput, json)
      const inspection = await Bun.spawn(helper, { cwd: consumer, stdout: 'pipe' })
      const report = (await new Response(inspection.stdout).json()) as {
        selected: string[]
        blockers: { code: string }[]
      }
      assert.equal(await inspection.exited, expectedExit)
      if (expectedExit === 0) {
        assert.deepEqual(report.selected, ['a12345678901234567890123', 'a12345678901234567890124'])
        assert.deepEqual(report.blockers, [])
      } else {
        assert(report.blockers.some(({ code }) => code === 'PENDING_PREREQUISITE'))
      }
    }
    await Bun.write(planInput, '{"status":"ok","result":[]}')
    const invalid = Bun.spawn(helper, { cwd: consumer, stdout: 'pipe', stderr: 'pipe' })
    assert.equal(await invalid.exited, 2)
    assert.match(await new Response(invalid.stderr).text(), /Expected a Zenlev.*plan-only/)
  } finally {
    await rm(postDeploy)
  }

  await run([process.execPath, 'consumer.ts'], consumer)
  await run([process.execPath, 'lint-consumer.ts'], consumer)

  for (const alias of ['zenlev', 'zenstack-zenlev']) {
    const version = await run([process.execPath, 'run', '--silent', alias, '--version'], consumer)
    assert.equal(version, manifest.version, alias + ' must run the packed CLI')
    const help = await run([process.execPath, 'run', '--silent', alias, '--help'], consumer)
    assert(help.includes('migrate create | apply |'), alias + ' must expose migration commands')
  }
  await Bun.write(
    resolve(consumer, 'lint.sql'),
    'CREATE TABLE packed_lint (id VARCHAR(36) PRIMARY KEY)',
  )
  for (const dialect of ['sqlite', 'postgresql', 'mysql']) {
    await Bun.write(
      resolve(consumer, 'lint-config.json'),
      JSON.stringify({
        lint: { dialect, zmodel: false, migrations: false, sql: ['lint.sql'] },
      }),
    )
    const outputs: string[] = []
    for (const alias of ['zenlev', 'zenstack-zenlev']) {
      const output = await run(
        [
          process.execPath,
          'run',
          '--silent',
          alias,
          'lint',
          '--config',
          'lint-config.json',
          '--max-warnings',
          '0',
          '--json',
        ],
        consumer,
      )
      assert.equal(JSON.parse(output).result.status, 'ok', alias + ' must lint ' + dialect)
      outputs.push(output)
    }
    assert.equal(outputs[0], outputs[1])
  }
  const optionalConsumer = resolve(temporary, 'without-optional-dependencies')
  await mkdir(optionalConsumer)
  await Bun.write(
    resolve(optionalConsumer, 'package.json'),
    JSON.stringify({
      name: 'zenlev-optional-consumer',
      private: true,
      dependencies: {
        [manifest.name]: 'file:' + archivePath,
        kysely: manifest.devDependencies.kysely,
      },
    }),
  )
  await run([process.execPath, 'install', '--ignore-scripts', '--omit=optional'], optionalConsumer)
  await copyFile(resolve(consumer, 'lint.sql'), resolve(optionalConsumer, 'lint.sql'))
  await Bun.write(
    resolve(optionalConsumer, 'lint-config.json'),
    JSON.stringify({
      lint: { dialect: 'sqlite', zmodel: false, migrations: false, sql: ['lint.sql'] },
    }),
  )
  const withoutSqliteParser = await run(
    [
      process.execPath,
      'run',
      '--silent',
      'zenlev',
      'lint',
      '--config',
      'lint-config.json',
      '--json',
    ],
    optionalConsumer,
  )
  const report = JSON.parse(withoutSqliteParser).result
  assert.equal(report.status, 'ok')
  assert.equal(report.coverage.gaps.length, 1)
  assert.match(report.coverage.gaps[0].message, /sqlite3-parser/)

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

  const squash = JSON.parse(
    await run(
      [process.execPath, 'run', '--silent', 'zenlev', 'migrate', 'squash', '--json'],
      consumer,
    ),
  ) as { status: string; result: { migration: { id: string }; supersedes: string[] } }
  assert.equal(squash.status, 'ok')
  assert.equal(squash.result.supersedes.length, 2)
  const baseline = JSON.parse(
    await run(
      [
        process.execPath,
        'run',
        '--silent',
        'zenstack-zenlev',
        'migrate',
        'apply',
        '--only',
        squash.result.migration.id,
        '--json',
      ],
      consumer,
    ),
  ) as { status: string; result: { migrations: { id: string }[] } }
  assert.equal(baseline.status, 'ok')
  assert.deepEqual(
    baseline.result.migrations.map(({ id }) => id),
    [squash.result.migration.id],
  )

  if (options.values.output !== undefined) {
    const output = resolve(options.values.output)
    await mkdir(output, { recursive: true })
    await copyFile(archivePath, resolve(output, archive.filename))
  }
  console.log(
    'Packed package passed versioned skills, static trust controls, typed API, SQLite, and both aliases',
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
