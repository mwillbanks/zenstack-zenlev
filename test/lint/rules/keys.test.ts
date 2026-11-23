import { expect, test } from 'bun:test'
import { inspect, table, primary, id, fk } from './fixtures'

test('single primary key names use physical names and configured templates', () => {
  expect(inspect('keys/primary-name', [primary]).reports).toHaveLength(0)
  const wrong = { ...primary, columns: ['order_id'] }
  expect(inspect('keys/primary-name', [wrong]).reports).toHaveLength(1)
  expect(
    inspect('keys/primary-name', [wrong], { template: '{tableStem}_id' }).reports,
  ).toHaveLength(0)
  expect(
    inspect('keys/primary-name', [{ ...primary, columns: ['left_id', 'right_id'] }]).reports,
  ).toHaveLength(0)
  expect(() => inspect('keys/primary-name', [primary], { template: '{missing}' })).toThrow(
    'Unknown naming template',
  )
})

test('sequential generation is checked for every primary key member and the final state', () => {
  const sequence = { ...id, sequential: true }
  expect(inspect('keys/no-sequential', [table, primary, sequence]).reports).toHaveLength(1)
  expect(inspect('keys/no-sequential', [table, primary, id]).reports).toHaveLength(0)
  expect(inspect('keys/no-sequential', [table, sequence]).reports).toHaveLength(0)
  expect(
    inspect('keys/no-sequential', [
      table,
      primary,
      id,
      { ...id, action: 'alter', sequential: true },
    ]).reports,
  ).toHaveLength(1)
  expect(
    inspect('keys/no-sequential', [table, primary, sequence, { ...table, action: 'drop' }]).reports,
  ).toHaveLength(0)
  expect(
    inspect('keys/no-sequential', [table, primary, sequence, { ...primary, action: 'drop' }])
      .reports,
  ).toHaveLength(0)
  expect(inspect('keys/no-sequential', [sequence, primary]).reports).toHaveLength(0)
  const result = inspect('keys/no-sequential', [table, sequence, primary], undefined, [primary])
  expect(result.reports[0]?.anchor).toBe(primary)
})

test('primary key types and generators remain configurable', () => {
  expect(inspect('keys/primary-type', [primary, id], { types: ['uuid'] }).reports).toHaveLength(0)
  expect(
    inspect('keys/primary-type', [primary, { ...id, type: 'integer' }], { types: ['uuid'] })
      .reports,
  ).toHaveLength(1)
  expect(
    inspect('keys/primary-type', [primary, { ...id, type: undefined }], { types: ['uuid'] }).gaps,
  ).toHaveLength(1)
  expect(
    inspect('keys/primary-type', [primary, id], { defaults: ['gen_random_uuid()'] }).reports,
  ).toHaveLength(1)
  expect(
    inspect('keys/primary-type', [primary, { ...id, default: 'gen_random_uuid()' }], {
      defaults: ['gen_random_uuid*'],
    }).reports,
  ).toHaveLength(0)
  expect(inspect('keys/primary-type', [id], { types: ['uuid'] }).reports).toHaveLength(0)
})

test('foreign key names and composite names use resolved physical targets', () => {
  expect(inspect('naming/foreign-key', [fk]).reports).toHaveLength(0)
  expect(inspect('naming/foreign-key', [{ ...fk, columns: ['bad'] }]).reports).toHaveLength(1)
  expect(inspect('naming/foreign-key', [{ ...fk, targetTable: undefined }]).gaps).toHaveLength(1)
  const composite = {
    ...fk,
    columns: ['customer_id', 'customer_code'],
    targetColumns: ['id', 'code'],
  }
  expect(inspect('naming/foreign-key', [composite]).reports).toHaveLength(0)
  expect(inspect('naming/foreign-key', [composite], { composite: 'check' }).reports).toHaveLength(0)
  expect(
    inspect('naming/foreign-key', [{ ...composite, columns: ['bad', 'customer_code'] }], {
      composite: 'check',
    }).reports,
  ).toHaveLength(1)
  expect(
    inspect('naming/foreign-key', [{ ...composite, targetColumns: [] }], { composite: 'check' })
      .gaps,
  ).toHaveLength(1)
})
