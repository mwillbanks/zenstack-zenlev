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

async function sqlFiles(cwd: string, patterns: readonly string[]): Promise<readonly string[]> {
  const paths = new Set<string>()
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd, absolute: true, onlyFiles: true }))
      paths.add(resolve(cwd, path))
  }
  return [...paths].sort()
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
  const migrations =
    config.migrations !== false ? await listMigrationFiles(project.migrationsDir) : []
  const files = await sqlFiles(project.cwd, config.sql ?? [])
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
  const inputs = new Set([...files, ...migrations])
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
