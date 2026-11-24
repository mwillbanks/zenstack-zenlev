import { expect, test } from 'bun:test'
import { inspect, node, table } from './fixtures'

test('object restrictions distinguish create, cleanup, definite calls, languages, and allowlists', () => {
  const routine = node('function', 'calculate', {
    action: 'create',
    signature: '(integer)',
    language: 'plpgsql',
  })
  expect(inspect('objects/restricted', [routine]).reports).toHaveLength(1)
  expect(inspect('objects/restricted', [{ ...routine, action: 'drop' }]).reports).toHaveLength(0)
  expect(inspect('objects/restricted', [{ ...routine, action: 'call' }]).reports).toHaveLength(0)
  expect(inspect('objects/restricted', [routine], { actions: ['drop'] }).reports).toHaveLength(0)
  expect(
    inspect('objects/restricted', [routine], { allow: ['app.calculate(integer)'] }).reports,
  ).toHaveLength(0)
  expect(inspect('objects/restricted', [routine], { languages: ['sql'] }).reports).toHaveLength(0)
  expect(inspect('objects/restricted', [routine], { kinds: ['view'] }).reports).toHaveLength(0)
  expect(inspect('objects/restricted', [table]).reports).toHaveLength(0)
  expect(
    inspect(
      'objects/restricted',
      [{ ...routine, action: undefined, identity: 'app.calculate(integer)' }],
      { actions: ['existing'] },
    ).reports,
  ).toHaveLength(1)
})

test('stored-object security checks invoker mode and explicit trusted definer paths', () => {
  const routine = node('function', 'calculate', { security: 'definer' })
  expect(inspect('objects/security', [routine], { security: 'invoker' }).reports).toHaveLength(1)
  expect(
    inspect('objects/security', [{ ...routine, security: 'invoker' }], { security: 'invoker' })
      .reports,
  ).toHaveLength(0)
  expect(
    inspect('objects/security', [{ ...routine, security: undefined }], { security: 'invoker' })
      .gaps,
  ).toHaveLength(1)
  expect(
    inspect('objects/security', [routine], { trustedSearchPath: ['pg_catalog'] }).gaps,
  ).toHaveLength(1)
  expect(
    inspect('objects/security', [{ ...routine, searchPath: [] }], {
      trustedSearchPath: ['pg_catalog'],
    }).reports,
  ).toHaveLength(1)
  expect(
    inspect('objects/security', [{ ...routine, searchPath: ['public'] }], {
      trustedSearchPath: ['pg_catalog'],
    }).reports,
  ).toHaveLength(1)
  expect(
    inspect('objects/security', [{ ...routine, searchPath: ['pg_catalog'] }], {
      trustedSearchPath: ['pg_catalog'],
    }).reports,
  ).toHaveLength(0)
  expect(inspect('objects/security', [routine], { publicExecute: false }).gaps).toHaveLength(1)
})

test('trusted search path checks only PostgreSQL routines and reports unavailable security once', () => {
  const options = { trustedSearchPath: ['pg_catalog'] }
  const routine = node('function', 'calculate')
  expect(inspect('objects/security', [routine], options).gaps).toHaveLength(1)
  expect(
    inspect('objects/security', [routine], { ...options, security: 'invoker' }).gaps,
  ).toHaveLength(1)
  const view = node('view', 'accounts', { security: 'definer' })
  const mysql = { ...routine, dialect: 'mysql', security: 'definer' }
  expect(inspect('objects/security', [view, mysql], options).gaps).toHaveLength(0)
  const materialized = { ...view, kind: 'materialized-view' }
  expect(inspect('objects/security', [materialized], { security: 'invoker' }).reports).toHaveLength(
    0,
  )
  expect(
    inspect('objects/security', [{ ...materialized, origin: 'catalog', security: undefined }], {
      security: 'invoker',
    }).gaps,
  ).toHaveLength(0)
})
