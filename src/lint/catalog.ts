import { sql } from 'kysely'
import { createStore } from '../migrate/store'
import type { DatabaseAdapter, StoreConfig } from '../types'
import type { LintInput } from './types'
import { rows } from './catalog/shared'
import { postgres } from './postgresql/catalog'
import { mysql } from './mysql/catalog'
import { sqlite } from './sqlite/catalog'

interface CatalogOptions {
  readonly adapter: DatabaseAdapter<any, any, any>
  readonly namespaces?: readonly string[] | undefined
  readonly store?: StoreConfig | undefined
}
export async function readBuiltinLintCatalog(options: CatalogOptions): Promise<LintInput> {
  const { adapter, namespaces, store } = options
  const result =
    adapter.dialect === 'postgresql'
      ? await postgres(adapter.root.physical, namespaces)
      : adapter.dialect === 'mysql'
        ? await mysql(adapter.root.physical, namespaces)
        : await sqlite(adapter.root.physical, namespaces)
  const ledger = createStore(adapter, store).tables
  const current =
    adapter.dialect === 'postgresql'
      ? await rows(adapter.root.physical, sql<{ name: string }>`SELECT current_schema() AS name`)
      : adapter.dialect === 'mysql'
        ? await rows(adapter.root.physical, sql<{ name: string }>`SELECT DATABASE() AS name`)
        : [{ name: 'main' }]
  const currentNamespace = current[0]?.name
  const nodes = result.nodes.filter(
    (entry) =>
      !ledger.some(
        (table) =>
          entry.kind !== 'schema' &&
          (entry.table ?? entry.name) === table.name &&
          (table.namespace ?? currentNamespace) === entry.schema,
      ),
  )
  return { ...result, nodes, defaultSchema: currentNamespace ?? undefined }
}
