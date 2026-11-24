import type { ResolvedProjectConfig } from '../config'
import { acquireDatabase } from '../database'
import type { DatabaseAdapter } from '../types'
import { readBuiltinLintCatalog } from './catalog'
import type { LintConfig, LintInput } from './types'

export async function readLintCatalog(
  adapter: DatabaseAdapter,
  config: LintConfig,
  store: ResolvedProjectConfig['store'],
): Promise<LintInput> {
  if (config.catalog?.dialect === adapter.dialect)
    return config.catalog.read({
      physical: adapter.root.physical,
      dialect: adapter.dialect,
      namespaces: config.namespaces,
    })
  return readBuiltinLintCatalog({ adapter, namespaces: config.namespaces, store })
}

export async function readLiveLintCatalog(
  project: ResolvedProjectConfig,
  config: LintConfig,
): Promise<LintInput> {
  const environment = { name: project.env, cwd: project.cwd }
  const provider = config.catalog
  if (provider?.connect) {
    const connection = await provider.connect(environment)
    try {
      return await provider.read({
        physical: connection.physical,
        dialect: provider.dialect,
        namespaces: config.namespaces,
      })
    } finally {
      await connection.dispose()
    }
  }
  const database = await acquireDatabase(project, environment)
  try {
    if (!database.adapter)
      throw new Error('Configure a ZenStack client or a Kysely adapter for live lint')
    if (provider && provider.dialect !== database.adapter.dialect)
      throw new Error('Lint catalog dialect does not match the configured database adapter')
    return await readLintCatalog(database.adapter, config, project.store)
  } finally {
    await database.dispose()
  }
}
