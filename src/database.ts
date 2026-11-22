import type { Kysely } from 'kysely'
import type { DatabaseAdapter, Dialect, Environment, ZenlevConfig } from './types'

/** The public ZenStack members used by the database bridge. */
export interface ZenStackClientLike {
  readonly $qb: Kysely<any>
  readonly $qbRaw: Kysely<any>
  readonly $schema: { readonly provider: { readonly type: string } }
  $transaction?<T>(run: (client: any) => Promise<T>): Promise<T>
}

export type ZenStackTransactionClient<Client> = Omit<
  Client,
  '$transaction' | '$connect' | '$disconnect' | '$use'
>

type ClientDatabase<Client extends ZenStackClientLike> =
  Client['$qb'] extends Kysely<infer DB> ? DB : never

export interface AcquiredDatabase<Client = unknown, DB = any, TransactionClient = Client> {
  readonly adapter: DatabaseAdapter<Client, DB, TransactionClient> | undefined
  dispose(): Promise<void>
}

function requireDialect(value: string): Dialect {
  if (value === 'sqlite' || value === 'postgresql' || value === 'mysql') return value
  throw new TypeError(`Unsupported database dialect: ${value}`)
}

function requireRoot(kysely: Kysely<any>): void {
  if (kysely.isTransaction) {
    throw new TypeError('A transaction client cannot be used as the root database connection')
  }
}

export function createKyselyAdapter<DB>(
  kysely: Kysely<DB>,
  dialect: Dialect,
): DatabaseAdapter<Kysely<DB>, DB> {
  const supportedDialect = requireDialect(dialect)
  return {
    dialect: supportedDialect,
    transactionalDdl: supportedDialect !== 'mysql',
    root: { kysely, physical: kysely, client: kysely },
    async transaction(run) {
      requireRoot(kysely)
      return kysely
        .transaction()
        .execute((transaction) =>
          run({ kysely: transaction, physical: transaction, client: transaction }),
        )
    },
  }
}

export function createZenStackAdapter<Client extends ZenStackClientLike>(
  client: Client,
): DatabaseAdapter<Client, ClientDatabase<Client>, ZenStackTransactionClient<Client>> {
  const dialect = requireDialect(client.$schema.provider.type)
  return {
    dialect,
    transactionalDdl: dialect !== 'mysql',
    root: { kysely: client.$qb, physical: client.$qbRaw, client },
    async transaction(run) {
      requireRoot(client.$qb)
      if (!client.$transaction) {
        throw new TypeError('The ZenStack client must expose an interactive $transaction callback')
      }
      return client.$transaction((transaction: ZenStackTransactionClient<Client>) =>
        run({
          kysely: transaction.$qb,
          physical: transaction.$qb,
          client: transaction,
        }),
      )
    },
  }
}

function requireZenStackClient(client: unknown): asserts client is ZenStackClientLike {
  const candidate = client as Partial<ZenStackClientLike> | null
  if (
    !candidate ||
    !candidate.$qb ||
    !candidate.$qbRaw ||
    !candidate.$schema?.provider ||
    typeof candidate.$schema.provider.type !== 'string'
  ) {
    throw new TypeError('Expected a configured ZenStack V3 client')
  }
}

function once(dispose: () => void | Promise<void>): () => Promise<void> {
  let completion: Promise<void> | undefined
  return () => {
    completion ??= Promise.resolve().then(dispose)
    return completion
  }
}

export function acquireDatabase<Client extends ZenStackClientLike>(
  config: ZenlevConfig<Client>,
  environment: Environment,
): Promise<AcquiredDatabase<Client, ClientDatabase<Client>, ZenStackTransactionClient<Client>>>
export function acquireDatabase<Client, DB, TransactionClient = Client>(
  config: ZenlevConfig<Client, DB, TransactionClient>,
  environment: Environment,
): Promise<AcquiredDatabase<Client, DB, TransactionClient>>
export async function acquireDatabase(
  config: ZenlevConfig<any, any, any>,
  environment: Environment,
): Promise<AcquiredDatabase<any, any, any>> {
  const sources = [config.adapter, config.client, config.createClient].filter(
    (value) => value !== undefined,
  )
  if (sources.length > 1) {
    throw new TypeError('Configure exactly one database adapter, client, or client factory')
  }
  if (config.adapter) return { adapter: config.adapter, dispose: once(() => {}) }
  if (config.client !== undefined) {
    requireZenStackClient(config.client)
    return { adapter: createZenStackAdapter(config.client), dispose: once(() => {}) }
  }
  if (!config.createClient) return { adapter: undefined, dispose: once(() => {}) }

  const owned = await config.createClient(environment)
  if (!owned || typeof owned.dispose !== 'function') {
    throw new TypeError('The client factory must return a client and an explicit dispose function')
  }
  const dispose = once(() => owned.dispose())
  try {
    requireZenStackClient(owned.client)
    return { adapter: createZenStackAdapter(owned.client), dispose }
  } catch (error) {
    try {
      await dispose()
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'Client initialization and disposal failed')
    }
    throw error
  }
}
