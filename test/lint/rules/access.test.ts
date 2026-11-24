import { expect, test } from 'bun:test'
import { inspect, node, table } from './fixtures'

const rlsState = node('rls', 'orders', { table: 'orders', enabled: true, forced: true })
const policy = node('policy', 'tenant_policy', {
  table: 'orders',
  command: 'all',
  permissive: true,
  roles: ['app_role'],
  using: "tenant_id = current_setting('app.tenant')",
  check: null,
})

test('RLS explicit write convention distinguishes inherited checks and unrestricted predicates', () => {
  expect(
    inspect('postgres/rls', [table, rlsState, policy], {
      commands: ['select', 'insert', 'update', 'delete'],
      roles: ['app_role'],
    }).reports,
  ).toHaveLength(0)
  expect(
    inspect('postgres/rls', [table, rlsState, policy], { explicitWriteCheck: true }).reports,
  ).toHaveLength(1)
  expect(
    inspect('postgres/rls', [table, rlsState, { ...policy, using: null }], { explicitUsing: true })
      .reports,
  ).toHaveLength(1)
  expect(
    inspect('postgres/rls', [table, rlsState, { ...policy, using: '((true))', check: 'TRUE' }], {
      noBroad: true,
    }).reports,
  ).toHaveLength(1)
  expect(
    inspect('postgres/rls', [table, rlsState, policy], { allowedRoles: ['other'] }).reports,
  ).toHaveLength(1)
  expect(
    inspect('postgres/rls', [table, rlsState, { ...policy, roles: undefined }], {
      allowedRoles: ['app_role'],
    }).reports,
  ).toHaveLength(1)
  expect(
    inspect('postgres/rls', [table, rlsState], { defaultDeny: true, commands: ['select'] }).reports,
  ).toHaveLength(0)
})

test('RLS state includes enable, force, disable, no-force, ALTER omissions, and policy drops', () => {
  const enable = { ...rlsState, action: 'enable' as const, forced: undefined }
  const force = { ...rlsState, action: 'force' as const, enabled: undefined }
  expect(inspect('postgres/rls', [table, enable, force], { force: true }).reports).toHaveLength(0)
  const disable = { ...rlsState, action: 'disable' as const, enabled: false }
  expect(inspect('postgres/rls', [table, enable, disable]).reports).toHaveLength(1)
  const noForce = { ...rlsState, action: 'no-force' as const, forced: false }
  expect(
    inspect('postgres/rls', [table, force, noForce], { force: true, enabled: false }).reports,
  ).toHaveLength(1)
  const alter = {
    ...policy,
    action: 'alter' as const,
    command: undefined,
    using: undefined,
    check: undefined,
    roles: ['app_role'],
  }
  expect(
    inspect('postgres/rls', [table, rlsState, policy, alter], {
      commands: ['update'],
      roles: ['app_role'],
    }).reports,
  ).toHaveLength(0)
  expect(
    inspect('postgres/rls', [table, rlsState, policy, { ...alter, roles: ['other'] }], {
      commands: ['update'],
      roles: ['app_role'],
    }).reports,
  ).toHaveLength(1)
  const drop = { ...policy, action: 'drop' as const }
  expect(
    inspect(
      'postgres/rls',
      [table, rlsState, policy, drop],
      { commands: ['select'], roles: ['app_role'] },
      [drop],
    ).reports,
  ).toHaveLength(1)
})

test('RLS coverage respects default deny, command-specific checks, role applicability, and capability gaps', () => {
  expect(inspect('postgres/rls', [table], { force: true }).gaps).toHaveLength(2)
  expect(inspect('postgres/rls', [{ ...table, action: 'create' }]).reports).toHaveLength(1)
  expect(
    inspect(
      'postgres/rls',
      [table, rlsState, { ...policy, command: 'insert', using: 'tenant_id > 0' }],
      { commands: ['insert'] },
    ).reports,
  ).toHaveLength(1)
  expect(
    inspect(
      'postgres/rls',
      [table, rlsState, { ...policy, roles: ['public'], check: 'tenant_id > 0' }],
      { commands: ['update'], roles: ['other'] },
    ).reports,
  ).toHaveLength(0)
  expect(
    inspect('postgres/rls', [table, rlsState, { ...policy, permissive: false }], {
      commands: ['select'],
      roles: ['app_role'],
    }).reports,
  ).toHaveLength(1)
  expect(
    inspect('postgres/rls', [table, rlsState, policy], { tables: ['other.*'] }).reports,
  ).toHaveLength(0)
  expect(
    inspect('postgres/rls', [node('table', 'items', { dialect: 'sqlite' })]).reports,
  ).toHaveLength(0)
  expect(
    inspect('postgres/rls', [node('column', 'id', { table: 'unknown' })]).reports,
  ).toHaveLength(0)
})

test('ZenStack policy declarations handle delegated conditions, broad allows, and post-update', () => {
  const model = node('model', 'Order', { table: 'orders', origin: 'zmodel' })
  const allow = node('zenstack-policy', 'allow', {
    table: 'orders',
    origin: 'zmodel',
    command: 'all',
    permissive: true,
    using: 'check(customer)',
  })
  expect(
    inspect('zenstack/policies', [model, allow], { commands: ['read', 'update'], noBroad: true })
      .reports,
  ).toHaveLength(0)
  expect(
    inspect('zenstack/policies', [model, allow], { commands: ['post-update'], postUpdate: true })
      .reports,
  ).toHaveLength(2)
  expect(
    inspect('zenstack/policies', [model, { ...allow, using: 'true' }], { noBroad: true }).reports,
  ).toHaveLength(1)
  expect(
    inspect('zenstack/policies', [model, { ...allow, permissive: false }], { commands: ['read'] })
      .reports,
  ).toHaveLength(1)
  expect(
    inspect('zenstack/policies', [model, { ...allow, command: 'post-update' }], {
      postUpdate: true,
    }).reports,
  ).toHaveLength(0)
})

test('ALTER POLICY without prior evidence reports gaps while preserving proven facts', () => {
  const unknown = node('policy', 'tenant_policy', {
    table: 'orders',
    action: 'alter',
    using: 'tenant_id > 0',
  })
  const result = inspect('postgres/rls', [table, rlsState, unknown], {
    explicitWriteCheck: true,
    explicitUsing: true,
    allowedRoles: ['app_role'],
    commands: ['select'],
    roles: ['app_role'],
  })
  expect(result.reports).toHaveLength(0)
  expect(result.gaps).toHaveLength(4)
  expect(
    inspect('postgres/rls', [{ ...table, action: 'create' }], { force: true }).reports,
  ).toHaveLength(2)
})

test('separate ZenStack policy identities preserve every authored declaration', () => {
  const model = node('model', 'Order', { table: 'orders', origin: 'zmodel' })
  const broad = node('zenstack-policy', 'allow', {
    table: 'orders',
    origin: 'zmodel',
    identity: 'orders.allow.0',
    command: 'read',
    permissive: true,
    using: 'true',
  })
  const scoped = { ...broad, identity: 'orders.allow.1', using: 'auth() != null' }
  expect(
    inspect('zenstack/policies', [model, broad, scoped], { noBroad: true }).reports,
  ).toHaveLength(1)
})

test('RLS applies kind selectors and recognizes boolean casts without guessing ALTER policy mode', () => {
  const cast = { ...policy, using: 'CAST((TRUE::pg_catalog.bool) AS boolean)' }
  const rules = { kinds: ['policy'], noBroad: true }
  expect(inspect('postgres/rls', [table, rlsState, cast], rules).reports).toHaveLength(1)
  expect(
    inspect('postgres/rls', [table, rlsState, { ...cast, using: 'TRUE AND is_member' }], rules)
      .reports,
  ).toHaveLength(0)
  const altered = { ...policy, action: 'alter' as const, permissive: undefined }
  const commands = { commands: ['select'], roles: ['app_role'] }
  expect(inspect('postgres/rls', [table, rlsState, altered], commands).gaps).toHaveLength(1)
  expect(
    inspect('postgres/rls', [table, rlsState, { ...policy, permissive: false }, altered], commands)
      .reports,
  ).toHaveLength(1)
})
