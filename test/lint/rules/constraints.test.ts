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
