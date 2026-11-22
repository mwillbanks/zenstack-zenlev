import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { Kysely } from 'kysely'
import { acquireDatabase, createKyselyAdapter, createZenStackAdapter } from '../src/database'
import type { Dialect, Environment, ZenlevConfig } from '../src/types'

const environment = { name: 'test', cwd: '/project' } as const

function connection(isTransaction = false): Kysely<{ account: { id: number } }> {
  return { isTransaction } as Kysely<{ account: { id: number } }>
}

function zenstack(dialect = 'sqlite') {
  const $qb = connection()
  const $qbRaw = connection()
  const $schema = { provider: { type: dialect } }
  const tx = {
    $qb: connection(true),
    $qbRaw,
    $schema,
    account: { findMany: () => ['transaction'] },
  }
  const client = {
    $qb,
    $qbRaw,
    $schema,
    account: { findMany: () => ['root'] },
    async $transaction<T>(run: (transaction: typeof tx) => Promise<T>): Promise<T> {
      return run(tx)
    },
    $disconnect: mock(async () => {}),
  }
  spyOn(client, '$transaction')
  return { client, tx }
}

afterEach(() => mock.restore())

describe('configured ZenStack adapter', () => {
  test('preserves client identity and transaction-scoped query builders', async () => {
    const { client, tx } = zenstack()
    const adapter = createZenStackAdapter(client)
    expect(adapter.root.client).toBe(client)
    expect(adapter.root.kysely).toBe(client.$qb)
    expect(adapter.root.physical).toBe(client.$qbRaw)
    expect(adapter.root.client.account.findMany()).toEqual(['root'])
    const result = await adapter.transaction(async (session) => {
      expect(session.client).toBe(tx)
      expect(session.kysely).toBe(tx.$qb)
      expect(session.physical).toBe(tx.$qb)
      expect(session.physical).not.toBe(tx.$qbRaw)
      return session.client.account.findMany()
    })
    expect(result).toEqual(['transaction'])
    expect(client.$transaction).toHaveBeenCalledTimes(1)
  })

  test.each(['sqlite', 'postgresql', 'mysql'])('declares %s DDL capability', (dialect) => {
    const { client } = zenstack(dialect)
    const adapter = createZenStackAdapter(client)
    expect(adapter.dialect).toBe(dialect)
    expect(adapter.transactionalDdl).toBe(dialect !== 'mysql')
  })

  test('rejects unknown dialects', () => {
    expect(() => createZenStackAdapter(zenstack('unsupported').client)).toThrow(
      'Unsupported database dialect',
    )
  })

  test('rejects transaction roots before invoking a nested transaction', async () => {
    const { client } = zenstack()
    const transactional = { ...client, $qb: connection(true) }
    await expect(createZenStackAdapter(transactional).transaction(async () => 1)).rejects.toThrow(
      'transaction client cannot be used',
    )
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  test('rejects a root without an interactive transaction method', async () => {
    const { client } = zenstack()
    const { $transaction: _, ...incomplete } = client
    await expect(createZenStackAdapter(incomplete).transaction(async () => 1)).rejects.toThrow(
      'interactive $transaction callback',
    )
  })

  test('preserves transaction errors', async () => {
    const error = new Error('migration failed')
    await expect(
      createZenStackAdapter(zenstack().client).transaction(async () => {
        throw error
      }),
    ).rejects.toBe(error)
  })
})

describe('standalone Kysely adapter', () => {
  test('uses the supplied connection and transaction delegate', async () => {
    const root = connection()
    const transaction = connection(true)
    const execute = mock(async <T>(run: (transaction: Kysely<any>) => Promise<T>) =>
      run(transaction),
    )
    const kysely = Object.assign(root, { transaction: () => ({ execute }) })
    const adapter = createKyselyAdapter(kysely, 'postgresql')
    expect(adapter.root.client).toBe(kysely)
    expect(adapter.root.physical).toBe(kysely)
    expect(adapter.transactionalDdl).toBe(true)
    const result = await adapter.transaction(async (session) => {
      expect(session.client).toBe(transaction)
      expect(session.physical).toBe(transaction)
      expect(session.kysely).toBe(transaction)
      return 'committed'
    })
    expect(result).toBe('committed')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('reports MySQL DDL limits and rejects unsupported dialects', () => {
    expect(createKyselyAdapter(connection(), 'mysql').transactionalDdl).toBe(false)
    expect(() => createKyselyAdapter(connection(), 'other' as Dialect)).toThrow(
      'Unsupported database dialect',
    )
  })

  test('rejects a transactional root', async () => {
    const adapter = createKyselyAdapter(connection(true), 'sqlite')
    await expect(adapter.transaction(async () => 1)).rejects.toThrow(
      'transaction client cannot be used',
    )
  })
})

describe('database acquisition and ownership', () => {
  test('supports commands without a database', async () => {
    const acquired = await acquireDatabase({}, environment)
    expect(acquired.adapter).toBeUndefined()
    await acquired.dispose()
    await acquired.dispose()
  })

  test('borrows an explicit adapter', async () => {
    const adapter = createKyselyAdapter(connection(), 'sqlite')
    const acquired = await acquireDatabase({ adapter }, environment)
    expect(acquired.adapter).toBe(adapter)
    await acquired.dispose()
  })

  test('borrows an explicit client without disconnecting it', async () => {
    const { client } = zenstack()
    const acquired = await acquireDatabase({ client }, environment)
    expect(acquired.adapter?.root.client).toBe(client)
    await acquired.dispose()
    await acquired.dispose()
    expect(client.$disconnect).not.toHaveBeenCalled()
  })

  test('passes the environment unchanged and disposes an owned client once', async () => {
    const { client } = zenstack()
    const dispose = mock(async () => {})
    const createClient = mock(async (selected: Environment) => {
      expect(selected).toBe(environment)
      return { client, dispose }
    })
    const acquired = await acquireDatabase({ createClient }, environment)
    expect(acquired.adapter?.root.client).toBe(client)
    await Promise.all([acquired.dispose(), acquired.dispose()])
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test('shares an in-flight disposer and preserves its failure', async () => {
    const { client } = zenstack()
    let rejectDisposal!: (error: Error) => void
    const completion = new Promise<void>((_, reject) => {
      rejectDisposal = reject
    })
    const dispose = mock(() => completion)
    const acquired = await acquireDatabase(
      { createClient: () => ({ client, dispose }) },
      environment,
    )
    const first = acquired.dispose()
    const second = acquired.dispose()
    expect(first).toBe(second)
    const error = new Error('disposal failed')
    rejectDisposal(error)
    await expect(first).rejects.toBe(error)
    await expect(acquired.dispose()).rejects.toBe(error)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test('preserves factory errors', async () => {
    const error = new Error('factory failed')
    await expect(
      acquireDatabase(
        {
          createClient: async () => {
            throw error
          },
        },
        environment,
      ),
    ).rejects.toBe(error)
  })

  test.each([null, {}, { $qb: connection() }])(
    'rejects invalid borrowed clients',
    async (client) => {
      await expect(acquireDatabase({ client }, environment)).rejects.toThrow(
        'Expected a configured ZenStack V3 client',
      )
    },
  )

  test('rejects conflicting configuration sources', async () => {
    const { client } = zenstack()
    const config = { client, adapter: createKyselyAdapter(connection(), 'sqlite') }
    await expect(acquireDatabase(config as unknown as ZenlevConfig, environment)).rejects.toThrow(
      'Configure exactly one',
    )
  })

  test.each([undefined, { client: {} }])('requires a factory disposer', async (owned) => {
    const config = { createClient: () => owned } as unknown as ZenlevConfig
    await expect(acquireDatabase(config, environment)).rejects.toThrow('explicit dispose function')
  })

  test('disposes a factory result when client initialization fails', async () => {
    const dispose = mock(async () => {})
    await expect(
      acquireDatabase({ createClient: () => ({ client: {}, dispose }) }, environment),
    ).rejects.toThrow('Expected a configured ZenStack V3 client')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test('disposes a factory result when its dialect is unsupported', async () => {
    const dispose = mock(async () => {})
    await expect(
      acquireDatabase(
        {
          createClient: () => ({ client: zenstack('unsupported').client, dispose }),
        },
        environment,
      ),
    ).rejects.toThrow('Unsupported database dialect')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test('reports initialization and cleanup errors together', async () => {
    const error = new Error('cleanup failed')
    const config = {
      createClient: () => ({
        client: {},
        dispose: () => {
          throw error
        },
      }),
    }
    try {
      await acquireDatabase(config, environment)
      throw new Error('Expected initialization to fail')
    } catch (failure) {
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors[1]).toBe(error)
    }
  })
})
