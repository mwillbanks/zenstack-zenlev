import { expect, test } from 'bun:test'
import { inspect, node, table, primary, index } from './fixtures'

test('case rules handle mapped storage names, logical names, exclusions, and removal', () => {
  const cases = [
    ['naming/model-case', 'model', 'OrderItem', 'order_item'],
    ['naming/field-case', 'field', 'orderId', 'OrderId'],
    ['naming/table-case', 'table', 'order_items', 'OrderItems'],
    ['naming/column-case', 'column', 'order_id', 'orderId'],
  ] as const
  for (const [rule, kind, valid, invalid] of cases) {
    expect(inspect(rule, [node(kind, valid)]).reports).toHaveLength(0)
    expect(inspect(rule, [node(kind, invalid)]).reports).toHaveLength(1)
    expect(inspect(rule, [node(kind, invalid)], { exclude: ['app.*'] }).reports).toHaveLength(0)
    expect(inspect(rule, [node(kind, invalid, { action: 'drop' })]).reports).toHaveLength(0)
    expect(inspect(rule, [node(kind, invalid, { action: 'call' })]).reports).toHaveLength(0)
  }
  expect(inspect('naming/table-case', [table], { format: 'kebab-case' }).reports).toHaveLength(0)
  expect(
    inspect('naming/table-case', [node('table', 'ORDERS')], { format: 'UPPER_SNAKE_CASE' }).reports,
  ).toHaveLength(0)
  expect(inspect('naming/table-case', [table], { kinds: ['column'] }).reports).toHaveLength(0)
  expect(inspect('naming/table-case', [table], { include: ['other.*'] }).reports).toHaveLength(0)
  expect(() => inspect('naming/table-case', [table], { format: 'unknown' })).toThrow(
    'Unknown identifier format',
  )
})

test('identifier checks combine patterns, prefixes, suffixes, deny lists, and source quoting', () => {
  const invalid = node('table', 'Orders', { spelling: 'Orders', quoted: true })
  const result = inspect('naming/identifier', [invalid], {
    format: 'snake_case',
    prefix: 'tbl_',
    suffix: '_data',
    pattern: '^tbl_',
    deny: ['Order*'],
    reserved: ['ORDERS'],
    quoted: false,
    maxLength: 3,
  })
  expect(result.reports).toHaveLength(1)
  expect(result.messages[0]).toContain('use prefix')
  expect(result.messages[0]).toContain('unquoted')
  expect(inspect('naming/identifier', [node('model', 'Orders')]).reports).toHaveLength(0)
  expect(
    inspect('naming/identifier', [node('function', 'legacy', { action: 'drop' })]).reports,
  ).toHaveLength(0)
  expect(
    inspect('naming/identifier', [node('function', 'legacy', { action: 'call' })]).reports,
  ).toHaveLength(0)
  expect(
    inspect('naming/identifier', [node('table', 'ok', { schema: undefined })], { qualified: true })
      .reports,
  ).toHaveLength(1)
  expect(
    inspect('naming/identifier', [node('table', 'ok', { schema: undefined, origin: 'catalog' })], {
      qualified: true,
      quoted: false,
    }).gaps,
  ).toHaveLength(2)
  expect(inspect('naming/identifier', [node('table', 'é'.repeat(32))]).reports).toHaveLength(1)
  expect(
    inspect('naming/identifier', [node('table', 'a'.repeat(65), { dialect: 'mysql' })]).reports,
  ).toHaveLength(1)
  expect(
    inspect('naming/identifier', [node('table', 'a'.repeat(65), { dialect: 'sqlite' })]).reports,
  ).toHaveLength(0)
  expect(() => inspect('naming/identifier', [table], { maxLength: 0 })).toThrow('positive integer')
})

test('table inflection supports ordinary nouns, last tokens, irregulars, and uncountables', () => {
  for (const name of ['orders', 'order_categories', 'statuses', 'people']) {
    expect(inspect('naming/table-number', [node('table', name)]).reports).toHaveLength(0)
  }
  expect(inspect('naming/table-number', [node('table', 'person')]).messages[0]).toContain('people')
  expect(inspect('naming/table-number', [table], { form: 'singular' }).messages[0]).toContain(
    'order',
  )
  expect(inspect('naming/table-number', [table], { form: 'unchanged' }).reports).toHaveLength(0)
  expect(
    inspect('naming/table-number', [node('table', 'company_people')], {
      irregular: { person: 'people' },
    }).reports,
  ).toHaveLength(0)
  expect(
    inspect('naming/table-number', [node('table', 'data')], { uncountable: ['data'] }).reports,
  ).toHaveLength(0)
  expect(
    inspect('naming/table-number', [node('table', 'order_data')], { uncountable: ['data'] })
      .reports,
  ).toHaveLength(0)
  expect(
    inspect('naming/table-number', [node('table', 'human')], { irregular: { human: 'humans' } })
      .messages[0],
  ).toContain('humans')
  expect(() => inspect('naming/table-number', [table], { form: 'bad' })).toThrow('form')
})

test('constraint naming supports explicit and generated names with ordered columns', () => {
  expect(
    inspect('naming/constraint', [index], { templates: { index: 'idx_{table}_{columns}' } })
      .reports,
  ).toHaveLength(0)
  expect(
    inspect('naming/constraint', [{ ...index, name: 'bad', explicit: false }], {
      template: 'idx_{table}_{columns}',
      explicit: true,
    }).reports,
  ).toHaveLength(2)
  expect(
    inspect('naming/constraint', [{ ...primary, explicit: true }], { explicit: false }).reports,
  ).toHaveLength(1)
  expect(inspect('naming/constraint', [primary], { explicit: true }).gaps).toHaveLength(1)
  expect(
    inspect('naming/constraint', [{ ...primary, name: '' }], { template: '{table}_pkey' }).gaps,
  ).toHaveLength(1)
  expect(() => inspect('naming/constraint', [index], { explicit: 'yes' })).toThrow('boolean')
})

test('explicit join definitions support side ordering, templates, and key strategy', () => {
  const relation = node('table', 'role_user_relations')
  const key = node('primary-key', '', { table: relation.name, columns: ['id'] })
  const config = {
    joins: [
      {
        table: 'app.*',
        left: 'user',
        right: 'role',
        order: 'lexical',
        template: '{left}_{right}_relations',
        key: 'surrogate',
      },
    ],
  }
  expect(inspect('naming/join-table', [relation, key], config).reports).toHaveLength(0)
  expect(inspect('naming/join-table', [relation], config).reports).toHaveLength(1)
  expect(
    inspect('naming/join-table', [relation, key], {
      joins: [{ table: 'app.*', left: 'user', right: 'role', key: 'composite' }],
    }).reports,
  ).toHaveLength(2)
  expect(
    inspect('naming/join-table', [relation], {
      joins: [{ table: 'other.*', left: 'a', right: 'b' }],
    }).reports,
  ).toHaveLength(0)
  expect(() => inspect('naming/join-table', [relation])).toThrow('joins')
})

test('physical identifier rules distinguish names from authored delimiters and anonymous nodes', () => {
  const quoted = node('column', 'order_id', { spelling: '"order_id"', quoted: true })
  const unquoted = node('column', 'orderid', { spelling: 'OrderId', quoted: false })
  const schema = node('schema', 'app', { origin: 'catalog', schema: undefined })
  const unnamed = node('check', 'CHECK', { generated: true, nameKnown: false })
  expect(
    inspect('naming/identifier', [quoted], { format: 'snake_case', maxLength: 8 }).reports,
  ).toHaveLength(0)
  expect(inspect('naming/identifier', [unquoted], { format: 'snake_case' }).reports).toHaveLength(1)
  expect(inspect('naming/identifier', [quoted], { quoted: false }).reports).toHaveLength(1)
  const ignored = inspect('naming/identifier', [schema, unnamed, node('anonymous-block', 'DO')], {
    format: 'snake_case',
    qualified: true,
  })
  expect(ignored.reports).toHaveLength(0)
  expect(ignored.gaps).toHaveLength(0)
  expect(inspect('naming/constraint', [unnamed], { explicit: true }).reports).toHaveLength(1)
  expect(
    inspect('naming/constraint', [{ ...index, generated: false }], { explicit: true }).gaps,
  ).toHaveLength(0)
})
