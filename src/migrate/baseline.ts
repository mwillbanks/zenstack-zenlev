import { resolve } from 'node:path'
import { sql } from 'kysely'
import type { CommandContext } from '../engine'
import { database } from './execution'
import { buildGraph, planMigrations } from './graph'
import { authorMigration, discoverMigrations, verifyMigrationFile } from './files'
import { createStore } from './store'
import type { BaselineManifest, MigrationIdentity } from '../types'

export interface SquashOptions {
  readonly name?: string
  readonly namespace?: string
  /** JSON file containing one reviewed SQL statement per string. */
  readonly snapshot?: string
  readonly format?: boolean
  readonly dryRun?: boolean
}

export interface SquashResult {
  readonly supersedes: readonly string[]
  readonly statements: readonly string[]
  readonly migration?: MigrationIdentity
}

export async function squash(
  context: CommandContext,
  options: SquashOptions,
): Promise<SquashResult> {
  const adapter = database(context)
  const store = createStore(adapter, context.config.store)
  const generate = async (): Promise<SquashResult> => {
    const records = await store.read()
    const local = await discoverMigrations(context.config.migrationsDir, context.config.hashing)
    const graph = buildGraph(local, records)
    const plan = planMigrations(graph)
    if (!records.some(({ status }) => status === 'applied')) {
      throw new Error('Squash requires an applied migration history')
    }
    if (
      plan.migrations.length > 0 ||
      plan.blockers.length > 0 ||
      records.some(
        ({ status, unresolvedAttempt }) =>
          unresolvedAttempt || (status !== 'applied' && status !== 'rolled_back'),
      )
    ) {
      throw new Error('Apply pending migrations and resolve ledger or hash issues before squashing')
    }
    for (const migration of local) await verifyMigrationFile(migration, context.config.hashing)

    const supersedes = [...graph.nodes.keys()]
    // A prior applied baseline stands in for its entries on destinations bootstrapped from it.
    const previouslyArchived = new Set(
      records.flatMap(({ meta, status }) =>
        status === 'applied' && meta.baseline ? (meta.supersedes ?? []) : [],
      ),
    )
    const history: BaselineManifest['history'] = supersedes.flatMap((id) => {
      if (previouslyArchived.has(id)) return []
      const record = graph.nodes.get(id)?.record
      return [
        {
          id,
          expected: record
            ? { status: record.status as 'applied' | 'rolled_back', hash: record.hash }
            : null,
        },
      ]
    })
    const statements = await snapshotStatements(context, store.tables, options.snapshot)
    if (options.dryRun) return { supersedes, statements }

    const migration = await authorMigration(
      context.config.migrationsDir,
      {
        name: options.name ?? 'baseline',
        namespace: options.namespace ?? 'default',
        supersedes,
        baseline: { dialect: adapter.dialect, history },
        upBody:
          statements.length > 0
            ? [
                "  const { sql } = await import('kysely')",
                ...statements.map(
                  (statement) =>
                    '  await sql.raw(' + JSON.stringify(statement) + ').execute(ctx.db.kysely)',
                ),
              ].join('\n')
            : '  void ctx',
        ...(options.format === undefined ? {} : { format: options.format }),
        ...(context.config.hashing ? { hashing: context.config.hashing } : {}),
      },
      { validate: (identity) => buildGraph([...local, identity], records) },
    )
    return { supersedes, statements, migration }
  }
  return options.dryRun ? generate() : store.withLock(generate)
}

async function snapshotStatements(
  context: CommandContext,
  tables: readonly { readonly name: string }[],
  path: string | undefined,
): Promise<string[]> {
  if (path !== undefined) {
    const snapshot: unknown = await Bun.file(resolve(context.env.cwd, path)).json()
    if (
      !Array.isArray(snapshot) ||
      snapshot.some((item) => typeof item !== 'string' || !item.trim())
    ) {
      throw new Error('Snapshot must be a JSON array of nonempty SQL statements')
    }
    return snapshot as string[]
  }

  const adapter = database(context)
  if (adapter.dialect !== 'sqlite') {
    throw new Error('Pass --snapshot with reviewed SQL statements for ' + adapter.dialect)
  }
  const excluded = new Set([...tables.map(({ name }) => name), '_prisma_migrations', '_Migration'])
  const { rows } = await sql<{ sql: string; tbl_name: string }>`
    SELECT sql, tbl_name
    FROM main.sqlite_schema
    WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, rowid
  `.execute(adapter.root.physical)
  const ddl = rows.filter(({ tbl_name }) => !excluded.has(tbl_name)).map((row) => row.sql)
  if (ddl.some((statement) => /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(statement))) {
    throw new Error('Pass --snapshot with reviewed SQL for a database with virtual tables')
  }
  return ddl
}
