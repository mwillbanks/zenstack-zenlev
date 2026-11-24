import { expect, test } from 'bun:test'
import { inspect, node, table, fk, index } from './fixtures'

test('foreign key coverage requires full leading key order and rejects partial or dropped indexes', () => {
  expect(inspect('keys/foreign-key-index', [table, fk, index]).reports).toHaveLength(0)
  expect(
    inspect('keys/foreign-key-index', [table, fk, { ...index, partial: true }]).reports,
  ).toHaveLength(1)
  expect(
    inspect('keys/foreign-key-index', [table, fk, { ...index, columns: ['other', 'customer_id'] }])
      .reports,
  ).toHaveLength(1)
  expect(
    inspect('keys/foreign-key-index', [table, { ...fk, columns: undefined }]).gaps,
  ).toHaveLength(1)
  const dropped = { ...index, action: 'drop' as const }
  expect(
    inspect('keys/foreign-key-index', [table, fk, index, dropped], undefined, [dropped]).reports,
  ).toHaveLength(1)
})

test('required table CHECK constraints match configured names', () => {
  const check = node('check', 'positive_total', { table: 'orders' })
  expect(inspect('constraints/required-check', [table, check]).reports).toHaveLength(0)
  expect(inspect('constraints/required-check', [table]).reports).toHaveLength(1)
  expect(
    inspect('constraints/required-check', [table, check], { names: ['positive_*'] }).reports,
  ).toHaveLength(0)
  expect(
    inspect('constraints/required-check', [table, check], { names: ['other'] }).reports,
  ).toHaveLength(1)
})

test('required CHECK rules distinguish missing checks from incomplete metadata', () => {
  const partial = { ...table, checksKnown: false }
  const unavailable = inspect('constraints/required-check', [partial])
  expect(unavailable.reports).toHaveLength(0)
  expect(unavailable.gaps).toHaveLength(1)
  const check = node('check', '', { table: 'orders', nameKnown: false })
  expect(inspect('constraints/required-check', [partial, check]).gaps).toHaveLength(0)
  const unavailableName = inspect('constraints/required-check', [table, check], {
    names: ['total'],
  })
  expect(unavailableName.reports).toHaveLength(0)
  expect(unavailableName.gaps).toHaveLength(1)
})

test('foreign key indexes are checked for every unnamed foreign key', () => {
  const first = { ...fk, name: '' }
  const second = { ...first, columns: ['account_id'], targetTable: 'accounts' }
  const result = inspect('keys/foreign-key-index', [table, second, first, index])
  expect(result.reports).toHaveLength(1)
  expect(result.messages[0]).toContain('account_id')
})
