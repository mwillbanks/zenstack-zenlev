import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { loadProjectConfig, type ResolvedProjectConfig } from '../config'
import { listMigrationFiles } from '../migrate/files'
import type { ZenlevConfig } from '../types'
import { readLiveLintCatalog } from './live'
import { createLintRunner, lintOptions, type LintBatch } from './runner'
import { parseSqlLintInput, readMigrationLintInputs } from './source'
import type { LintConfig, LintInput, LintOptions, LintResult } from './types'
import { readZModelLintInput } from './zmodel'

async function inputFiles(cwd: string, patterns: readonly string[]): Promise<readonly string[]> {
  const paths = new Set<string>()
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd, absolute: true, onlyFiles: true }))
      paths.add(resolve(cwd, path))
  }
  return [...paths].sort()
}

function applicationMode(
  project: ResolvedProjectConfig,
  schemaDialect: string | undefined,
): 'zenstack' | 'standalone' {
  if (schemaDialect || project.schema) return 'zenstack'
  const client = project.adapter?.root.client ?? project.client
  if (client && typeof client === 'object') {
    if ('$qb' in client) return 'zenstack'
    if ('selectFrom' in client) return 'standalone'
  }
  return project.lint?.zmodel === false ? 'standalone' : 'zenstack'
}

async function readOffline(
  project: ResolvedProjectConfig,
  config: LintConfig,
): Promise<{
  readonly batches: readonly LintBatch[]
  readonly files: number
}> {
  const schema: LintInput =
    config.zmodel !== false ? await readZModelLintInput(project, true) : { nodes: [], gaps: [] }
  const dialect = config.dialect ?? schema.dialect
  if (config.dialect && schema.dialect && config.dialect !== schema.dialect)
    throw new Error('Lint dialect does not match the ZModel datasource')
  const source = (await inputFiles(project.cwd, config.source ?? [])).filter(
    (path) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path) && !/\.d\.[cm]?ts$/u.test(path),
  )
  const migrationFiles =
    config.migrations !== false || source.length > 0
      ? await listMigrationFiles(project.migrationsDir)
      : []
  const migrations = config.migrations === false ? [] : migrationFiles
  const migrationPaths = new Set(migrationFiles)
  const application = source.filter((path) => !migrationPaths.has(path))
  const files = await inputFiles(project.cwd, config.sql ?? [])
  const batches: LintBatch[] = [schema]
  for (const path of files) {
    const sql = await Bun.file(path).text()
    batches.push(
      await parseSqlLintInput(sql, dialect, {
        path,
        line: 1,
        column: 1,
        fingerprint: createHash('sha256').update(sql).digest('hex'),
      }),
    )
  }
  for (const path of migrations) {
    batches.push(await readMigrationLintInputs(path, dialect, ['up']))
    batches.push(await readMigrationLintInputs(path, dialect, ['down']))
  }
  if (application.length > 0) {
    const { createApplicationLintReader } = await import('./source/application')
    const readApplicationLintInput = createApplicationLintReader()
    const mode = applicationMode(project, schema.dialect)
    for (const path of application) {
      batches.push(await readApplicationLintInput(path, dialect, mode))
    }
  }
  const inputs = new Set([...files, ...migrations, ...application])
  for (const { source } of schema.nodes) if (source) inputs.add(source.path)
  return { batches, files: inputs.size }
}

export async function lintProject(
  config: ZenlevConfig = {},
  options: LintOptions = {},
  configPath?: string,
): Promise<LintResult> {
  lintOptions(options)
  const project = await loadProjectConfig(config, configPath, {
    loadClientModule: options.live === true,
    lintCatalogConnection: true,
  })
  const lint = project.lint ?? {}
  const run = await createLintRunner(lint, project.cwd, project.lintPluginBase)
  if (options.live) return run([await readLiveLintCatalog(project, lint)], options)
  const { batches, files } = await readOffline(project, lint)
  return run(batches, options, files)
}
