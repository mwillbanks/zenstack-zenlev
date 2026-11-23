import type { Kysely } from 'kysely'
import type { ZenlevPlugin } from './plugins'

export type Dialect = 'sqlite' | 'postgresql' | 'mysql'
export type HashAlgorithm = 'sha256' | 'sha512' | 'sha1' | 'md5'
export type MigrationStatus = 'pending' | 'applying' | 'applied' | 'rolled_back' | 'failed'
export type Attributes = Readonly<Record<string, unknown>>

export interface Environment {
  readonly name: string
  readonly cwd: string
}

export interface ReporterSpan {
  setAttribute(key: string, value: string | number | boolean): void
  addEvent(name: string, attributes?: Attributes): void
  recordException(error: unknown): void
  end(): void
}

export interface Reporter {
  span<T>(name: string, fn: (span: ReporterSpan) => T | Promise<T>): Promise<T>
  event(name: string, attributes?: Attributes): void
  info(message: string, attributes?: Attributes): void
  warn(message: string, attributes?: Attributes): void
  error(message: string, attributes?: Attributes): void
}

export interface DatabaseSession<Client = unknown, DB = any> {
  readonly kysely: Kysely<DB>
  /** The query executor reserved for physical ledger and catalog operations. */
  readonly physical: Kysely<any>
  readonly client: Client
}

export interface DatabaseAdapter<Client = unknown, DB = any, TxClient = Client> {
  readonly dialect: Dialect
  readonly transactionalDdl: boolean
  readonly root: DatabaseSession<Client, DB>
  transaction<T>(run: (session: DatabaseSession<TxClient, DB>) => Promise<T>): Promise<T>
}

export interface BaselineManifest {
  readonly dialect: Dialect
  readonly history: readonly {
    readonly id: string
    readonly expected: { readonly status: 'applied' | 'rolled_back'; readonly hash: string } | null
  }[]
}

export interface MigrationMeta {
  readonly id: string
  readonly name: string
  readonly namespace: string
  readonly createdAt: string
  readonly dependsOn?: readonly string[]
  readonly supersedes?: readonly string[]
  readonly tags?: readonly string[]
  readonly custom?: Attributes
  readonly warnings?: readonly Warning[]
  readonly baseline?: BaselineManifest
  readonly rollback?: {
    readonly mode: 'cascade' | 'compensate'
    readonly target: string
    readonly reversals: readonly string[]
  }
}

export interface MigrationIdentity extends MigrationMeta {
  readonly filePath: string
  readonly hash: string
}

export interface Warning {
  readonly code:
    | 'DROP_TABLE'
    | 'DROP_COLUMN'
    | 'TYPE_NARROWING'
    | 'UNIQUE_CONSTRAINT'
    | 'DESTRUCTIVE_DATA'
    | 'REDUCED_TRANSACTION_SAFETY'
    | 'ACTIVE_DEPENDENTS'
    | 'UNSUPPORTED_SCHEMA'
  readonly message: string
  readonly migrationId?: string
  readonly details?: Attributes
}

export type MigrationCtx<Client = unknown, DB = any, Extension extends object = object> = {
  readonly env: Environment
  readonly db: {
    readonly kysely: Kysely<DB>
    readonly schema: Kysely<DB>['schema']
    readonly dialect: { readonly name: Dialect }
  }
  readonly zenstack: { readonly client: Client }
  readonly migration: MigrationIdentity
  readonly reporter: Reporter
} & Extension

export interface MigrationDefinition<Context extends object = MigrationCtx> {
  readonly meta: MigrationMeta
  readonly up: (context: Context) => void | Promise<void>
  readonly down?: (context: Context) => void | Promise<void>
}

export interface StoreConfig {
  readonly location?: 'schema' | 'database' | 'table'
  readonly schemaName?: string
  readonly databaseName?: string
  readonly tableName?: string
  readonly lockTableName?: string
}

export interface ZenlevSettings {
  readonly plugins?: readonly ZenlevPlugin<any>[]
  readonly onWarning?: (warning: Warning) => void
  readonly cwd?: string
  readonly env?: string
  readonly migrationsDir?: string
  readonly schema?: string
  readonly store?: StoreConfig
  readonly namespaces?: Readonly<Record<string, { readonly description?: string }>>
  readonly diff?: { readonly excludeViews?: boolean }
  readonly hashing?: { readonly algorithm?: HashAlgorithm; readonly normalizeLineEndings?: boolean }
  readonly telemetry?: {
    readonly opentelemetry?: {
      readonly enabled?: boolean
      readonly serviceName?: string
      readonly exporter?: 'console' | 'otlp'
      readonly otlpEndpoint?: string
    }
  }
}

export interface OwnedClient<Client> {
  readonly client: Client
  readonly dispose: () => void | Promise<void>
}

export type ClientFactory<Client> = (
  env: Environment,
) => OwnedClient<Client> | Promise<OwnedClient<Client>>

export type ZenlevConfig<Client = unknown, DB = any, TxClient = Client> = ZenlevSettings &
  (
    | { readonly client: Client; readonly createClient?: never; readonly adapter?: never }
    | {
        readonly createClient: ClientFactory<Client>
        readonly client?: never
        readonly adapter?: never
      }
    | {
        readonly adapter: DatabaseAdapter<Client, DB, TxClient>
        readonly client?: never
        readonly createClient?: never
      }
    | { readonly client?: never; readonly createClient?: never; readonly adapter?: never }
  )

export interface Selection {
  readonly namespace?: readonly string[]
  readonly from?: string
  readonly to?: string
  readonly only?: readonly string[]
  readonly tags?: readonly string[]
}

export interface ApplyOptions extends Selection {
  readonly dryRun?: boolean
  readonly planOnly?: boolean
  readonly noTransaction?: boolean
  readonly continueOnFailure?: boolean
}

export interface Plan {
  readonly migrations: readonly MigrationIdentity[]
  readonly namespaces: readonly string[]
  readonly warnings: readonly Warning[]
  readonly transactional: boolean
  readonly blockers: readonly PlanBlocker[]
}

export interface PlanBlocker {
  readonly migrationId: string
  readonly code:
    'PENDING_PREREQUISITE' | 'HASH_MISMATCH' | 'UNRESOLVED_ATTEMPT' | 'BASELINE_HISTORY'
  readonly message: string
}

export interface MigrationResult {
  readonly id: string
  readonly status: 'applied' | 'skipped' | 'failed' | 'rolled_back'
  readonly durationMs: number
  readonly error?: string
}

export interface ApplyResult {
  readonly plan: Plan
  readonly migrations: readonly MigrationResult[]
  readonly status: 'planned' | 'ok' | 'failed' | 'partial'
}
