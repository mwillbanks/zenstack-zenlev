import { acquireDatabase, type ZenStackTransactionClient } from './database'
import {
  createPlugins,
  defineMigration,
  type CommandInfo,
  type HookContext,
  type PluginExtension,
  type PluginInvocation,
  type ZenlevPlugin,
} from './plugins'
import { createTelemetry } from './telemetry'
import type { Kysely } from 'kysely'
import * as execution from './migrate/execution'
import * as inspection from './migrate/inspection'
import { rollback, type RollbackOptions, type RollbackResult } from './migrate/rollback'
import { squash, type SquashOptions, type SquashResult } from './migrate/baseline'
import { createDiffMigration, push, type PushOptions, type PushResult } from './schema/commands'
import type { RecoveryOptions } from './migrate/store'
import { loadProjectConfig, type ResolvedProjectConfig } from './config'
import type {
  ApplyOptions,
  ApplyResult,
  DatabaseAdapter,
  Environment,
  MigrationCtx,
  MigrationDefinition,
  MigrationIdentity,
  Warning,
  ZenlevConfig,
} from './types'

export interface CommandContext {
  readonly env: Environment
  readonly config: ResolvedProjectConfig
  readonly adapter: DatabaseAdapter | undefined
  readonly reporter: HookContext['reporter']
  readonly plugins: PluginInvocation
  notifyWarning(warning: Warning): void
}

type ConfigClient<Config> = Config extends { readonly client: infer Client }
  ? Client
  : Config extends { readonly createClient: (...args: any[]) => infer Produced }
    ? Awaited<Produced> extends { readonly client: infer Client }
      ? Client
      : unknown
    : unknown

export type ZenlevMigrationContext<Config> = MigrationCtx<
  Config extends { readonly adapter: DatabaseAdapter<infer Root, any, infer Tx> }
    ? Root | Tx
    : ConfigClient<Config> | ZenStackTransactionClient<ConfigClient<Config>>,
  Config extends { readonly adapter: DatabaseAdapter<any, infer DB, any> }
    ? DB
    : ConfigClient<Config> extends { readonly $qb: Kysely<infer DB> }
      ? DB
      : any,
  Config extends { readonly plugins: infer Plugins extends readonly ZenlevPlugin<any>[] }
    ? PluginExtension<Plugins>
    : object
>

export interface Zenlev<Context extends object = any> {
  readonly environment: Environment
  defineMigration(definition: MigrationDefinition<Context>): MigrationDefinition<Context>
  readonly db: {
    push(options?: PushOptions): Promise<PushResult>
  }
  readonly migrate: {
    apply(options?: ApplyOptions): Promise<ApplyResult>
    create(options: inspection.CreateOptions): Promise<MigrationIdentity>
    rollback(options: RollbackOptions): Promise<RollbackResult>
    squash(options?: SquashOptions): Promise<SquashResult>
    status(options?: inspection.StatusOptions): Promise<inspection.StatusEntry[]>
    tree(options?: inspection.TreeOptions): Promise<string>
    remove(options: inspection.RemoveOptions): Promise<MigrationIdentity[]>
    resolve(options: execution.ResolveOptions): ReturnType<typeof execution.resolveHash>
    reshape(options: execution.ReshapeOptions): ReturnType<typeof execution.reshapeHash>
    recover(options: RecoveryOptions): Promise<void>
  }
  close(): Promise<void>
}

export async function createCommandService(overrides: ZenlevConfig, configPath?: string) {
  const config = await loadProjectConfig(overrides, configPath)
  const env = Object.freeze({ name: config.env, cwd: config.cwd })
  const database = await acquireDatabase(config, env)
  const telemetry = await createTelemetry(config.telemetry?.opentelemetry).catch(
    async (error: unknown) => {
      await database.dispose()
      throw error
    },
  )
  const { reporter } = telemetry
  const dispose = async () => {
    const results = await Promise.allSettled([database.dispose(), telemetry.close()])
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Zenlev disposal failed')
  }
  const adapter = database.adapter
  const base: HookContext = {
    env,
    reporter,
    ...(adapter
      ? {
          db: {
            kysely: adapter.root.kysely,
            schema: adapter.root.kysely.schema,
            dialect: { name: adapter.dialect },
          },
          zenstack: { client: adapter.root.client },
        }
      : {}),
  }
  const pluginRuntime = await (async () => {
    try {
      const runtime = await createPlugins(config.plugins ?? [])
      await (await runtime.invocation(base)).init()
      return runtime
    } catch (error) {
      await dispose()
      throw error
    }
  })()
  const notifyWarning = (warning: Warning) => {
    reporter.warn(warning.message, { code: warning.code })
    try {
      config.onWarning?.(warning)
    } catch {
      reporter.error('Zenlev warning observer failed', { code: 'WARNING_OBSERVER_ERROR' })
    }
  }
  const running = new Set<Promise<unknown>>()
  let close: Promise<void> | undefined

  return {
    environment: env,
    run<T>(
      command: (context: CommandContext) => T | Promise<T>,
      info: CommandInfo = { name: 'api', args: [], options: {} },
    ): Promise<T> {
      if (close !== undefined) return Promise.reject(new Error('Zenlev is closed'))
      const result = reporter.span('zenlev.command', async () => {
        const start = performance.now()
        const plugins = await pluginRuntime.invocation(base)
        let status: 'ok' | 'error' = 'ok'
        try {
          await plugins.beforeCommand(info)
          const output = await command({ env, config, adapter, reporter, plugins, notifyWarning })
          if (
            output &&
            typeof output === 'object' &&
            'status' in output &&
            ['failed', 'blocked', 'partial'].includes(String(output.status))
          )
            status = 'error'
          return output
        } catch (error) {
          status = 'error'
          await plugins.error(error)
          throw error
        } finally {
          await plugins.afterCommand({
            status,
            durationMs: Math.max(0, Math.round(performance.now() - start)),
          })
        }
      })
      running.add(result)
      const remove = () => running.delete(result)
      void result.then(remove, remove)
      return result
    },
    close(): Promise<void> {
      return (close ??= Promise.allSettled(running).then(dispose))
    },
  }
}

export async function createZenlev<const Config extends ZenlevConfig = {}>(
  config?: Config & ZenlevConfig,
  configPath?: string,
): Promise<Zenlev<ZenlevMigrationContext<Config>>> {
  const service = await createCommandService(config ?? {}, configPath)
  const dispatch = <T>(
    name: string,
    options: object,
    command: (context: CommandContext) => T | Promise<T>,
  ) => service.run(command, { name, options: { ...options }, args: [] })
  return {
    environment: service.environment,
    defineMigration,
    close: service.close,
    db: {
      push: (options = {}) => dispatch('db push', options, (context) => push(context, options)),
    },
    migrate: {
      apply: (options = {}) =>
        dispatch('migrate apply', options, (context) => execution.apply(context, options)),
      create: (options) =>
        dispatch('migrate create', options, (context) =>
          options.fromSchema || options.toDb
            ? createDiffMigration(context, options)
            : inspection.create(context, options),
        ),
      rollback: (options) =>
        dispatch('migrate rollback', options, (context) => rollback(context, options)),
      squash: (options = {}) =>
        dispatch('migrate squash', options, (context) => squash(context, options)),
      status: (options = {}) =>
        dispatch('migrate status', options, (context) => inspection.status(context, options)),
      tree: (options = {}) =>
        dispatch('migrate tree', options, (context) => inspection.tree(context, options)),
      remove: (options) =>
        dispatch('migrate remove', options, (context) => inspection.remove(context, options)),
      resolve: (options) =>
        dispatch('migrate resolve', options, (context) => execution.resolveHash(context, options)),
      reshape: (options) =>
        dispatch('migrate reshape', options, (context) => execution.reshapeHash(context, options)),
      recover: (options) =>
        dispatch('migrate recover', options, (context) => execution.recover(context, options)),
    },
  }
}
