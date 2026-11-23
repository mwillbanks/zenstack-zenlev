import type { LintInput } from './lint/types'
import type { ResolvedProjectConfig } from './config'
import type { SchemaModel } from './schema/model'
import type { DatabaseAdapter } from './types'
import type {
  Attributes,
  Environment,
  MigrationCtx,
  MigrationDefinition,
  MigrationIdentity,
  MigrationResult,
  MigrationStatus,
  Plan,
  Reporter,
  Warning,
} from './types'

export type HookContext<Extension extends object = object> = {
  readonly env: Environment
  readonly reporter: Reporter
  readonly db?: MigrationCtx['db']
  readonly zenstack?: MigrationCtx['zenstack']
} & Extension

export interface CommandInfo {
  readonly name: string
  readonly args: readonly string[]
  readonly options: Attributes
}

export interface WriteDiagnostic {
  readonly ruleId: string
  readonly severity: 'warn' | 'error'
  readonly message: string
  readonly identity?: string | undefined
  readonly source?:
    | {
        readonly path: string
        readonly line: number
        readonly column: number
        readonly endLine?: number
        readonly endColumn?: number
      }
    | undefined
  readonly fingerprint?: string
}

export interface PlannedMigrationHandler {
  readonly migration: MigrationIdentity
  readonly direction: 'up' | 'down'
}

export type WritePlan =
  | { readonly command: 'migrate apply'; readonly handlers: readonly PlannedMigrationHandler[] }
  | {
      readonly command: 'db push'
      readonly statements: readonly string[]
      readonly desired: SchemaModel
      readonly affected: readonly string[]
      readonly zmodel?: LintInput
    }

export interface WriteProject {
  readonly config: Pick<
    ResolvedProjectConfig,
    'cwd' | 'schema' | 'hashing' | 'lint' | 'lintPluginBase' | 'store'
  >
  readonly adapter: DatabaseAdapter
}

export interface CommandResult {
  readonly status: 'ok' | 'error'
  readonly durationMs: number
}

export type StoreSnapshot = readonly {
  readonly id: string
  readonly namespace: string
  readonly hash: string
  readonly status: MigrationStatus
}[]

export interface StoreDelta {
  readonly applied: readonly MigrationIdentity[]
  readonly rolledBack: readonly MigrationIdentity[]
}

type Awaitable<T> = T | Promise<T>
type Decision = Awaitable<void | false>

export interface PluginApi<Extension extends object = object> {
  decorate(values: Partial<Extension>): void
  derive(fn: (context: HookContext<Extension>) => Awaitable<Partial<Extension>>): void
  onInit(fn: (context: HookContext<Extension>) => Awaitable<void>): void
  onBeforeCommand(fn: (context: HookContext<Extension>, command: CommandInfo) => Decision): void
  onAfterCommand(
    fn: (context: HookContext<Extension>, result: CommandResult) => Awaitable<void>,
  ): void
  onPlan(fn: (context: HookContext<Extension>, plan: Plan) => Awaitable<Plan | void>): void
  onBeforeWrite(
    fn: (
      context: HookContext<Extension>,
      plan: WritePlan,
      project: WriteProject,
    ) => Awaitable<readonly WriteDiagnostic[] | void>,
  ): void
  onBeforeMigration(
    fn: (context: MigrationCtx<unknown, any, Extension>, migration: MigrationIdentity) => Decision,
  ): void
  onAfterMigration(
    fn: (
      context: MigrationCtx<unknown, any, Extension>,
      migration: MigrationIdentity,
      result: MigrationResult,
    ) => Awaitable<void>,
  ): void
  onWarning(fn: (context: HookContext<Extension>, warning: Warning) => Awaitable<void>): void
  onError(fn: (context: HookContext<Extension>, error: Error) => Awaitable<void>): void
  onStoreRead(
    fn: (context: HookContext<Extension>, snapshot: StoreSnapshot) => Awaitable<void>,
  ): void
  onStoreWrite(fn: (context: HookContext<Extension>, delta: StoreDelta) => Awaitable<void>): void
}

export interface ZenlevPlugin<Extension extends object = object> {
  readonly name: string
  readonly setup: (api: PluginApi<Extension>) => Awaitable<void>
}

type CombinedPlugin<Decoration extends object, Derivation extends object> = {
  readonly name: string
  readonly decorate?: Decoration
  readonly derive?: (context: HookContext<Decoration>) => Awaitable<Derivation>
  readonly setup?: (api: PluginApi<Decoration & Derivation>) => Awaitable<void>
}

export function definePlugin<
  const Decoration extends object = object,
  const Derivation extends object = object,
>(definition: CombinedPlugin<Decoration, Derivation>): ZenlevPlugin<Decoration & Derivation> {
  return {
    name: definition.name,
    async setup(api) {
      if (definition.decorate) api.decorate(definition.decorate as Partial<Decoration & Derivation>)
      if (definition.derive) {
        const derive = definition.derive
        api.derive(async (context) => (await derive(context)) as Partial<Decoration & Derivation>)
      }
      await definition.setup?.(api)
    },
  }
}

type ExtensionOf<P> = P extends ZenlevPlugin<infer E> ? E : never
type Intersection<T> = (T extends unknown ? (value: T) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never

export type PluginExtension<Plugins extends readonly ZenlevPlugin<any>[]> =
  Plugins[number] extends never ? object : Intersection<ExtensionOf<Plugins[number]>> & object

export function defineMigration<Context extends object = MigrationCtx>(
  definition: MigrationDefinition<Context>,
): MigrationDefinition<Context> {
  return definition
}

type Register = Exclude<keyof PluginApi<any>, 'decorate'>
type Hook<T extends Register> = Parameters<PluginApi<any>[T]>[0]
type Hooks = { [T in Register]: Hook<T>[] }

const reserved = new Set([
  'env',
  'db',
  'zenstack',
  'migration',
  'reporter',
  '__proto__',
  'constructor',
  'prototype',
])

function mergeExtensions(target: Record<string, unknown>, extension: object): void {
  if (extension === null || typeof extension !== 'object' || Array.isArray(extension)) {
    throw new TypeError('Plugin context extensions must be objects')
  }
  for (const [key, value] of Object.entries(extension)) {
    if (reserved.has(key) || Object.hasOwn(target, key))
      throw new Error('Plugin context collision: ' + key)
    target[key] = value
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export async function createPlugins(plugins: readonly ZenlevPlugin<any>[]) {
  const decoration: Record<string, unknown> = {}
  const hooks: Hooks = {
    derive: [],
    onInit: [],
    onBeforeCommand: [],
    onAfterCommand: [],
    onPlan: [],
    onBeforeWrite: [],
    onBeforeMigration: [],
    onAfterMigration: [],
    onWarning: [],
    onError: [],
    onStoreRead: [],
    onStoreWrite: [],
  }
  const api: PluginApi<any> = {
    decorate: (values) => mergeExtensions(decoration, values),
    derive: (fn) => hooks.derive.push(fn),
    onInit: (fn) => hooks.onInit.push(fn),
    onBeforeCommand: (fn) => hooks.onBeforeCommand.push(fn),
    onAfterCommand: (fn) => hooks.onAfterCommand.push(fn),
    onPlan: (fn) => hooks.onPlan.push(fn),
    onBeforeWrite: (fn) => hooks.onBeforeWrite.push(fn),
    onBeforeMigration: (fn) => hooks.onBeforeMigration.push(fn),
    onAfterMigration: (fn) => hooks.onAfterMigration.push(fn),
    onWarning: (fn) => hooks.onWarning.push(fn),
    onError: (fn) => hooks.onError.push(fn),
    onStoreRead: (fn) => hooks.onStoreRead.push(fn),
    onStoreWrite: (fn) => hooks.onStoreWrite.push(fn),
  }
  const names = new Set<string>()
  for (const plugin of plugins) {
    if (!plugin.name.trim() || names.has(plugin.name))
      throw new Error('Invalid or duplicate plugin name: ' + plugin.name)
    names.add(plugin.name)
    await plugin.setup(api)
  }

  async function invocation(base: HookContext) {
    const extensions = { ...decoration }
    for (const derive of hooks.derive) {
      mergeExtensions(extensions, await derive({ ...base, ...extensions }))
    }
    const context: HookContext = { ...base, ...extensions }
    const scope = (migration: MigrationCtx): MigrationCtx => ({ ...migration, ...extensions })
    const observe = async (run: () => Awaitable<void>) => {
      try {
        await run()
      } catch (error) {
        base.reporter.error('Zenlev plugin observer failed', { code: 'PLUGIN_OBSERVER_ERROR' })
        for (const report of hooks.onError) {
          try {
            await report(context, asError(error))
          } catch {
            base.reporter.error('Zenlev error observer failed', { code: 'PLUGIN_OBSERVER_ERROR' })
          }
        }
      }
    }
    return {
      scope,
      async init() {
        for (const hook of hooks.onInit) await hook(context)
      },
      async beforeCommand(info: CommandInfo) {
        for (const hook of hooks.onBeforeCommand) {
          if ((await hook(context, info)) === false)
            throw new Error('Command cancelled by a plugin: ' + info.name)
        }
      },
      async afterCommand(result: CommandResult) {
        for (const hook of hooks.onAfterCommand) await observe(() => hook(context, result))
      },
      async error(error: unknown) {
        for (const hook of hooks.onError) {
          try {
            await hook(context, asError(error))
          } catch {
            base.reporter.error('Zenlev error observer failed', { code: 'PLUGIN_OBSERVER_ERROR' })
          }
        }
      },
      async plan(original: Plan, validate: (current: Plan) => Plan) {
        let current = original
        for (const hook of hooks.onPlan) {
          const proposed = await hook(context, structuredClone(current))
          if (proposed !== undefined) current = validate(proposed)
        }
        return current
      },
      hasBeforeWrite: hooks.onBeforeWrite.length > 0,
      async beforeWrite(
        plan: WritePlan,
        project: WriteProject,
      ): Promise<readonly WriteDiagnostic[]> {
        const diagnostics: WriteDiagnostic[] = []
        for (const hook of hooks.onBeforeWrite) {
          const findings = await hook(context, structuredClone(plan), project)
          if (findings) diagnostics.push(...findings)
        }
        return diagnostics
      },
      async beforeMigration(migration: MigrationCtx) {
        for (const hook of hooks.onBeforeMigration) {
          if ((await hook(scope(migration), migration.migration)) === false) return false
        }
        return true
      },
      async afterMigration(migration: MigrationCtx, result: MigrationResult) {
        for (const hook of hooks.onAfterMigration) {
          await observe(() => hook(scope(migration), migration.migration, result))
        }
      },
      async warning(warning: Warning) {
        for (const hook of hooks.onWarning) await observe(() => hook(context, warning))
      },
      async storeRead(records: StoreSnapshot) {
        for (const hook of hooks.onStoreRead) await observe(() => hook(context, records))
      },
      async storeWrite(delta: StoreDelta) {
        for (const hook of hooks.onStoreWrite) await observe(() => hook(context, delta))
      },
    }
  }

  return { invocation }
}

export type PluginInvocation = Awaited<
  ReturnType<Awaited<ReturnType<typeof createPlugins>>['invocation']>
>
