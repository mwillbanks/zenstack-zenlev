import { expect, test } from 'bun:test'
import { inspect, node, table, id } from './fixtures'

test('required columns check type, nullability, default, and state after a drop', () => {
  const config = {
    columns: {
      id: { type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
      created_at: {},
    },
  }
  expect(inspect('columns/required', [table, id], config).reports).toHaveLength(2)
  expect(
    inspect('columns/required', [table, { ...id, type: 'text', nullable: true }], config).reports,
  ).toHaveLength(4)
  const drop = { ...id, action: 'drop' as const }
  const result = inspect('columns/required', [table, id, drop], { columns: { id: {} } }, [drop])
  expect(result.reports).toHaveLength(1)
  expect(result.reports[0]?.anchor).toBe(drop)
  expect(inspect('columns/required', [node('schema', 'app')], config).reports).toHaveLength(0)
})

test('column conventions use explicit types and selectors for business semantics', () => {
  const boolean = node('column', 'active', { table: 'orders', type: 'boolean' })
  expect(
    inspect('columns/conventions', [boolean], { types: ['boolean'], prefixes: ['is_', 'has_'] })
      .reports,
  ).toHaveLength(1)
  expect(
    inspect('columns/conventions', [{ ...boolean, name: 'is_active' }], {
      types: ['boolean'],
      prefixes: ['is_'],
    }).reports,
  ).toHaveLength(0)
  expect(
    inspect('columns/conventions', [id], { types: ['boolean'], prefixes: ['is_'] }).reports,
  ).toHaveLength(0)
  expect(
    inspect('columns/conventions', [{ ...boolean, type: undefined }], { types: ['boolean'] }).gaps,
  ).toHaveLength(1)
  expect(
    inspect('columns/conventions', [node('column', 'amount_json', { type: 'text' })], {
      suffix: '_cents',
      forbiddenSuffixes: ['_json'],
      allowedTypes: ['integer'],
    }).reports,
  ).toHaveLength(3)
})

test('column conventions report evidence gaps for unknown type and nullability', () => {
  const partial = { ...id, origin: 'catalog' as const, type: undefined, nullable: undefined }
  const required = inspect('columns/required', [table, partial], {
    columns: { id: { type: 'uuid', nullable: false } },
  })
  expect(required.reports).toHaveLength(0)
  expect(required.gaps).toHaveLength(2)
  expect(inspect('columns/conventions', [partial], { allowedTypes: ['uuid'] }).gaps).toHaveLength(1)
})
