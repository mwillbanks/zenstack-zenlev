import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ZenStackClient } from '@zenstackhq/orm'
import type { SchemaDef } from '@zenstackhq/schema'
import { sql } from 'kysely'
import { createZenStackAdapter } from '../../src/database'
import { createBunSqliteDialect } from '../fixtures/sqlite'

const schema = {
  provider: { type: 'sqlite' },
  plugins: {},
  models: {
    Account: {
      name: 'Account',
      attributes: [
        { name: '@@map', args: [{ name: 'name', value: { kind: 'literal', value: 'accounts' } }] },
      ],
      fields: {
        id: { name: 'id', type: 'Int', id: true },
        label: {
          name: 'label',
          type: 'String',
          attributes: [
            {
              name: '@map',
              args: [{ name: 'name', value: { kind: 'literal', value: 'display_name' } }],
            },
          ],
        },
      },
      idFields: ['id'],
      uniqueFields: { id: { type: 'Int' } },
    },
  },
} as const satisfies SchemaDef

function createFixture() {
  const database = new Database(':memory:')
  database.run('CREATE TABLE accounts (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL)')
  database.run('CREATE TABLE zenlev_migrations (id TEXT PRIMARY KEY, hash TEXT NOT NULL)')
  const client = new ZenStackClient(schema, { dialect: createBunSqliteDialect(database) })
  return { database, client, adapter: createZenStackAdapter(client) }
}

describe('ZenStack transaction integration', () => {
  let fixture: ReturnType<typeof createFixture>

  beforeEach(() => {
    fixture = createFixture()
  })

  afterEach(async () => {
    await fixture.client.$disconnect()
  })

  test('commits ORM, mapped Kysely, DDL, and physical ledger writes together', async () => {
    const result = await fixture.adapter.transaction(async (session) => {
      const ctx = {
        db: { kysely: session.kysely, schema: session.kysely.schema },
        zenstack: { client: session.client },
      }
      expect(ctx.zenstack.client).not.toBe(fixture.client)
      expect(ctx.db.kysely.isTransaction).toBe(true)
      expect(session.physical).toBe(ctx.db.kysely)

      await ctx.zenstack.client.account.create({ data: { id: 1, label: 'ORM' } })
      await ctx.db.kysely.insertInto('Account').values({ id: 2, label: 'Kysely' }).execute()
      await ctx.db.schema.createTable('created_in_transaction').addColumn('id', 'integer').execute()
      await sql`INSERT INTO zenlev_migrations (id, hash) VALUES (${'commit'}, ${'hash-commit'})`.execute(
        session.physical,
      )
      return 'committed'
    })

    expect(result).toBe('committed')
    expect(fixture.database.query('SELECT * FROM accounts ORDER BY id').all()).toEqual([
      { id: 1, display_name: 'ORM' },
      { id: 2, display_name: 'Kysely' },
    ])
    expect(fixture.database.query('SELECT * FROM zenlev_migrations').all()).toEqual([
      { id: 'commit', hash: 'hash-commit' },
    ])
    expect(
      fixture.database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('created_in_transaction'),
    ).toEqual({ name: 'created_in_transaction' })
    expect(await fixture.client.account.count()).toBe(2)
  })

  test('rolls back ORM, mapped Kysely, DDL, and physical ledger writes together', async () => {
    const failure = new Error('abort the complete migration')

    await expect(
      fixture.adapter.transaction(async (session) => {
        await session.client.account.create({ data: { id: 1, label: 'ORM' } })
        await session.kysely.insertInto('Account').values({ id: 2, label: 'Kysely' }).execute()
        await session.kysely.schema
          .createTable('rolled_back_table')
          .addColumn('id', 'integer')
          .execute()
        await sql`INSERT INTO zenlev_migrations (id, hash) VALUES (${'rollback'}, ${'hash-rollback'})`.execute(
          session.physical,
        )
        expect(
          (
            await sql<{ count: number }>`SELECT COUNT(*) AS count FROM zenlev_migrations`.execute(
              session.physical,
            )
          ).rows,
        ).toEqual([{ count: 1 }])
        throw failure
      }),
    ).rejects.toBe(failure)

    expect(fixture.database.query('SELECT * FROM accounts').all()).toEqual([])
    expect(fixture.database.query('SELECT * FROM zenlev_migrations').all()).toEqual([])
    expect(
      fixture.database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('rolled_back_table'),
    ).toBeNull()
    expect(await fixture.client.account.count()).toBe(0)
  })

  test('rejects an already transactional client as a root for mutation', async () => {
    await fixture.client.$transaction(async (transactionClient) => {
      const adapter = createZenStackAdapter(transactionClient)
      expect(adapter.root.kysely.isTransaction).toBe(true)
      await expect(adapter.transaction(async () => undefined)).rejects.toThrow()
    })

    expect(fixture.database.query('SELECT * FROM accounts').all()).toEqual([])
    expect(fixture.database.query('SELECT * FROM zenlev_migrations').all()).toEqual([])
  })
})
