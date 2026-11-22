import { expect, expectTypeOf, test } from 'bun:test'
import { createPlugins } from '../src/plugins'
import { silentReporter } from '../src/telemetry'
import { createZenlev, definePlugin, type MigrationCtx, type Plan, type Warning } from '../src'

const base = { env: { name: 'test', cwd: '.' }, reporter: silentReporter }
const identity = {
  id: 'aaa',
  name: 'aaa',
  namespace: 'default',
  createdAt: '2026-01-01T00:00:00Z',
  filePath: '/migrations/aaa.ts',
  hash: 'hash',
}
const plan: Plan = {
  migrations: [identity],
  transactional: true,
  blockers: [],
  warnings: [],
  namespaces: ['default'],
}
const warning: Warning = { code: 'DROP_TABLE', message: 'drop a table' }

test('registers hooks in order, scopes extensions, and isolates observer failures', async () => {
  const events: string[] = []
  const first = definePlugin({
    name: 'first',
    decorate: { owner: 'operator' },
    derive: (context) => ({ label: context.owner + ':' + context.env.name }),
    setup(api) {
      api.onInit((context) => {
        events.push(context.label)
      })
      api.onBeforeCommand((_context, command) => {
        events.push(command.name)
      })
      api.onAfterCommand((_context, result) => {
        events.push(result.status)
      })
      api.onPlan((_context, proposed) => ({ ...proposed, warnings: [warning] }))
      api.onBeforeMigration(({ owner }) => {
        events.push(owner)
      })
      api.onAfterMigration((_context, migration) => {
        events.push(migration.id)
        throw new Error('observer')
      })
      api.onWarning((_context, observed) => {
        events.push(observed.code)
      })
      api.onError((_context, error) => {
        events.push(error.message)
      })
      api.onStoreRead((_context, snapshot) => {
        events.push('read:' + snapshot.length)
      })
      api.onStoreWrite((_context, delta) => {
        events.push('write:' + delta.applied.length)
      })
    },
  })
  const second = definePlugin({
    name: 'second',
    decorate: { approved: true },
    setup(api) {
      api.onPlan((_context, proposed) => {
        events.push(proposed.warnings[0]!.code)
      })
      api.onError(() => {
        throw Error('second observer failed')
      })
      api.onBeforeCommand(() => {
        events.push('second')
      })
    },
  })
  const client = await createZenlev({ plugins: [first, second], env: 'test' })
  const definition = client.defineMigration({
    meta: identity,
    up(context) {
      expectTypeOf(context.owner).toEqualTypeOf<'operator'>()
      expectTypeOf(context.label).toEqualTypeOf<string>()
      expectTypeOf(context.approved).toEqualTypeOf<true>()
      expectTypeOf(context.migration.id).toEqualTypeOf<string>()
    },
  })
  expect(definition.meta).toBe(identity)
  await client.close()
  const plugins = await (await createPlugins([first, second])).invocation(base)
  const migration = { ...base, migration: identity } as MigrationCtx
  await plugins.beforeCommand({ name: 'apply', args: [], options: {} })
  expect(await plugins.plan(plan, (proposal) => proposal)).toEqual({ ...plan, warnings: [warning] })
  expect(plan.warnings).toEqual([])
  expect(await plugins.beforeMigration(migration)).toBe(true)
  await plugins.afterMigration(migration, { id: identity.id, status: 'applied', durationMs: 0 })
  await plugins.warning(warning)
  await plugins.storeRead([])
  await plugins.storeWrite({ applied: [identity], rolledBack: [] })
  await plugins.error('command failure')
  await plugins.afterCommand({ status: 'ok', durationMs: 0 })
  expect(events).toEqual([
    'operator:test',
    'apply',
    'second',
    'DROP_TABLE',
    'operator',
    'aaa',
    'observer',
    'DROP_TABLE',
    'read:0',
    'write:1',
    'command failure',
    'ok',
  ])
})

test('rejects duplicate, reserved, and malformed extensions and allows cancellation', async () => {
  const named = (name: string) => definePlugin({ name })
  await expect(createPlugins([named('one'), named('one')])).rejects.toThrow('duplicate')
  await expect(
    createPlugins([definePlugin({ name: 'bad', decorate: { env: 1 } })]),
  ).rejects.toThrow('collision')
  await expect(createPlugins([definePlugin({ name: 'bad', decorate: [] })])).rejects.toThrow(
    'objects',
  )
  const plugin = definePlugin({
    name: 'guard',
    setup(api) {
      api.onBeforeCommand(() => false)
      api.onBeforeMigration(() => false)
    },
  })
  const invocation = await (await createPlugins([plugin])).invocation(base)
  await expect(invocation.beforeCommand({ name: 'apply', args: [], options: {} })).rejects.toThrow(
    'cancelled',
  )
  expect(await invocation.beforeMigration({ ...base, migration: identity } as MigrationCtx)).toBe(
    false,
  )
  const dispose = { called: false }
  await expect(
    createZenlev({
      plugins: [
        definePlugin({
          name: 'bad',
          setup(api) {
            api.onInit(() => {
              throw Error('init')
            })
          },
        }),
      ],
      createClient: async () => {
        dispose.called = true
        throw Error('factory failed')
      },
    }),
  ).rejects.toThrow('factory failed')
  expect(dispose.called).toBe(true)
  await expect(
    createZenlev({
      plugins: [
        definePlugin({
          name: 'bad',
          setup(api) {
            api.onInit(() => {
              throw Error('init')
            })
          },
        }),
      ],
    }),
  ).rejects.toThrow('init')
})
