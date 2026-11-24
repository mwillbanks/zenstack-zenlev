import { sql, type Kysely } from 'kysely'
import type { CommandContext } from '../engine'
import type { WriteDiagnostic } from '../plugins'
import { inspectResolvedZModel } from '../lint/zmodel'
import { database } from '../migrate/execution'
import { prepareAuthoring, type CreateOptions } from '../migrate/inspection'
import { authorMigration, type AuthorMigrationInput } from '../migrate/files'
import { alignCatalogSchema, readCatalog } from './catalog'
import { buildChangeSet, type SchemaChangeSet, type SqlStatement } from './diff'
import { readStatementEvidence } from './diff/evidence'
import { loadResolvedZModel, loadSchemaModel, projectResolvedZModel } from './model'
import { createStore } from '../migrate/store'
import type { MigrationIdentity } from '../types'

export interface DropOptions {
  readonly dropMissingTables?: 'apply' | 'skip'
  readonly confirmDrops?: (
    tables: readonly string[],
  ) => readonly string[] | Promise<readonly string[]>
}

export interface PushOptions extends DropOptions {
  readonly dryRun?: boolean
  readonly sql?: boolean
  readonly createMigration?: boolean
  readonly name?: string
  readonly format?: boolean
  readonly namespace?: string
  readonly excludeViews?: boolean
}

export interface PushResult {
  readonly status: 'planned' | 'applied' | 'created' | 'blocked' | 'partial' | 'failed'
  readonly changes: SchemaChangeSet
  readonly migration?: MigrationIdentity
  readonly executedStatements?: number
  readonly diagnostics?: readonly WriteDiagnostic[]
  readonly error?: string
}

async function confirm(
  inspection: SchemaChangeSet,
  options: DropOptions,
): Promise<readonly string[] | undefined> {
  const possible = inspection.missingTables.map(({ id }) => id)
  if (possible.length === 0 || options.dropMissingTables !== undefined) return undefined
  if (!options.confirmDrops)
    throw new Error('Choose --drop-missing-tables=apply or --drop-missing-tables=skip')
  const approved = await options.confirmDrops(possible)
  if (new Set(approved).size !== approved.length || approved.some((id) => !possible.includes(id))) {
    throw new Error('Drop confirmation returned IDs outside the offered tables')
  }
  return approved
}

function safeSql(statements: readonly SqlStatement[]): readonly SqlStatement[] {
  if (statements.some(({ parameters }) => parameters.length > 0)) {
    throw new Error('Schema DDL compiler returned unresolved bind parameters')
  }
  return statements
}

function migrationBody(statements: readonly SqlStatement[]): string {
  if (statements.length === 0) return ''
  return [
    "const { sql } = await import('kysely')",
    ...safeSql(statements).map(
      (statement) => 'await sql.raw(' + JSON.stringify(statement.sql) + ').execute(ctx.db.kysely)',
    ),
  ].join('\n')
}

async function scaffolding(
  context: CommandContext,
  plan: SchemaChangeSet,
  options: Pick<
    AuthorMigrationInput,
    'name' | 'format' | 'namespace' | 'dependsOn' | 'supersedes' | 'tags' | 'custom'
  >,
) {
  const up = plan.operations.flatMap((operation) => operation.up)
  const reversible = plan.operations.every((operation) => operation.down !== undefined)
  const down = reversible
    ? plan.operations.toReversed().flatMap((operation) => operation.down!)
    : undefined
  const validate = await prepareAuthoring(context, options)
  return authorMigration(
    context.config.migrationsDir,
    {
      ...options,
      warnings: plan.warnings,
      upBody: migrationBody(up),
      ...(down === undefined ? {} : { downBody: migrationBody(down) }),
      ...(context.config.hashing === undefined ? {} : { hashing: context.config.hashing }),
    },
    { validate },
  )
}

function changeSettings(
  db: Kysely<any>,
  options: DropOptions,
  drops: readonly string[] | undefined,
  excludeViews: boolean,
) {
  return {
    db,
    excludeViews,
    ...(options.dropMissingTables === undefined
      ? {}
      : { dropMissingTables: options.dropMissingTables }),
    ...(drops === undefined ? {} : { dropTables: drops }),
  }
}

function blocked(plan: SchemaChangeSet): Error {
  return new Error(plan.blockers.map(({ message }) => message).join('\n'))
}

function sourceOptions(
  context: CommandContext,
  excludeViews: boolean,
  schema: string | undefined = context.config.schema,
) {
  return {
    cwd: context.env.cwd,
    excludeViews,
    ...(schema === undefined ? {} : { schema }),
  }
}

function exclusions(context: CommandContext) {
  const store = createStore(database(context), context.config.store)
  return [...store.tables, { name: '_prisma_migrations' }, { name: '_Migration' }]
}

export async function push(context: CommandContext, options: PushOptions): Promise<PushResult> {
  const adapter = database(context)
  const store = createStore(adapter, context.config.store)
  const physical = adapter.root.physical
  const excludeViews = options.excludeViews ?? context.config.diff?.excludeViews ?? true
  const snapshot = async () => {
    const source = await loadResolvedZModel(sourceOptions(context, excludeViews))
    const desired = projectResolvedZModel(source, excludeViews)
    if (adapter.dialect !== desired.dialect)
      throw new Error('ZModel provider does not match the configured client')
    const target = await alignCatalogSchema(physical, desired)
    const live = await readCatalog(physical, target, exclusions(context), excludeViews)
    return { live, target, source }
  }
  const compare = (
    { live, target }: Awaited<ReturnType<typeof snapshot>>,
    drops?: readonly string[],
  ) => buildChangeSet(live, target, changeSettings(physical, options, drops, excludeViews))
  const initial = compare(await snapshot())
  if (options.dryRun || options.sql) return { status: 'planned', changes: initial }
  if (initial.blockers.length > 0) return { status: 'blocked', changes: initial }
  const drops = await confirm(initial, options)
  return store.withLock(async (owner): Promise<PushResult> => {
    const current = await snapshot()
    const rediscovered = compare(current)
    if (JSON.stringify(rediscovered) !== JSON.stringify(initial)) {
      return {
        status: 'blocked',
        changes: rediscovered,
        error: 'Live schema changed. Review the current plan.',
      }
    }
    const changes = drops === undefined ? rediscovered : compare(current, drops)
    if (changes.blockers.length > 0) return { status: 'blocked', changes }
    if (options.createMigration) {
      const migration = await scaffolding(context, changes, {
        ...options,
        name: options.name ?? 'schema_update',
      })
      return { status: 'created', changes, migration }
    }
    const statements = safeSql(changes.operations.flatMap((operation) => operation.up))
    const affected = new Set<string>()
    for (const operation of changes.operations) {
      if (operation.table) affected.add(operation.table)
    }
    const diagnostics = await context.plugins.beforeWrite(
      {
        command: 'db push',
        statements: statements.map(({ sql }) => sql),
        evidence: changes.operations.flatMap(readStatementEvidence),
        desired: current.target,
        affected: [...affected],
        ...(context.plugins.hasBeforeWrite && context.config.lint?.zmodel !== false
          ? { zmodel: inspectResolvedZModel(current.source) }
          : {}),
      },
      { config: context.config, adapter },
    )
    const findings = diagnostics.length ? { diagnostics } : {}
    if (diagnostics.some(({ severity }) => severity === 'error'))
      return { status: 'blocked', changes, ...findings }
    for (const warning of changes.warnings) {
      context.notifyWarning(warning)
      await context.plugins.warning(warning)
    }
    if (!adapter.transactionalDdl && changes.operations.length > 0) {
      const warning = {
        code: 'REDUCED_TRANSACTION_SAFETY' as const,
        message: 'MySQL DDL may commit implicitly. A failed push may leave partial changes.',
      }
      context.notifyWarning(warning)
      await context.plugins.warning(warning)
    }
    let executedStatements = 0
    const execute = async (session: typeof adapter.root) => {
      for (const statement of statements) {
        await store.assertOwner(session, owner)
        await sql.raw(statement.sql).execute(session.physical)
        executedStatements += 1
      }
    }
    try {
      if (adapter.transactionalDdl) await adapter.transaction(execute)
      else await execute(adapter.root)
      return { status: 'applied', changes, executedStatements, ...findings }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return adapter.transactionalDdl
        ? { status: 'failed', changes, executedStatements: 0, error: message, ...findings }
        : { status: 'partial', changes, executedStatements, error: message, ...findings }
    }
  })
}

export async function createDiffMigration(
  context: CommandContext,
  options: CreateOptions,
): Promise<MigrationIdentity> {
  if (options.empty) throw new Error('--empty cannot be combined with schema diff inputs')
  const adapter = database(context)
  const physical = adapter.root.physical
  const excludeViews = context.config.diff?.excludeViews ?? true
  const snapshot = async () => {
    const baseline = await loadSchemaModel(sourceOptions(context, excludeViews, options.fromSchema))
    if (adapter.dialect !== baseline.dialect)
      throw new Error('ZModel provider does not match the configured client')
    const from = await alignCatalogSchema(physical, baseline)
    const current = options.toDb
      ? await readCatalog(physical, from, exclusions(context), excludeViews)
      : await alignCatalogSchema(
          physical,
          await loadSchemaModel(sourceOptions(context, excludeViews)),
        )
    return { from, current }
  }
  const compare = (
    { from, current }: Awaited<ReturnType<typeof snapshot>>,
    drops?: readonly string[],
  ) => buildChangeSet(from, current, changeSettings(physical, options, drops, excludeViews))
  const initial = compare(await snapshot())
  if (initial.blockers.length > 0) throw blocked(initial)
  const drops = await confirm(initial, options)
  const store = createStore(adapter, context.config.store)
  return store.withLock(async () => {
    const live = await snapshot()
    const updated = compare(live)
    if (JSON.stringify(updated) !== JSON.stringify(initial))
      throw new Error(
        'Schema changed. Review the current plan.\n' + JSON.stringify(updated, null, 2),
      )
    const plan = drops === undefined ? updated : compare(live, drops)
    if (plan.blockers.length > 0) throw blocked(plan)
    return scaffolding(context, plan, options)
  })
}
