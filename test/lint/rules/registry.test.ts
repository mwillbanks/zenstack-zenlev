import { expect, test } from 'bun:test'
import Ajv from 'ajv'
import { builtinPresets, builtinRules, recommendedLintConfig } from '../../../src/lint/rules'
import { inspect, table } from './fixtures'

test('recommended preset exposes six documented defaults and optional families', () => {
  expect(Object.keys(recommendedLintConfig.rules!)).toHaveLength(6)
  expect(Object.values(recommendedLintConfig.rules!)).toEqual(Array(6).fill('error'))
  expect(builtinPresets.recommended).toBe(recommendedLintConfig)
  expect(Object.keys(builtinPresets)).toEqual(['recommended', 'naming', 'objects', 'access'])
  expect(Object.keys(builtinRules)).toHaveLength(20)
})

test('rule creators reject malformed option primitives and nested mappings', () => {
  expect(() => inspect('naming/table-case', [], null)).toThrow('object')
  expect(() => inspect('naming/table-case', [], [])).toThrow('object')
  expect(() => inspect('naming/table-case', [table], { kinds: 'table' })).toThrow('strings')
  expect(() => inspect('naming/table-case', [table], { format: 1 })).toThrow('strings')
  expect(() => inspect('naming/table-number', [table], { irregular: [] })).toThrow('objects')
})

test('built-in option schemas reject typos and malformed structures before scanning', () => {
  const ajv = new Ajv({ strictTuples: false })
  for (const [name, rule] of Object.entries(builtinRules)) {
    const validate = ajv.compile({ type: 'array', items: rule.meta.schema, additionalItems: false })
    expect(validate([]), name).toBe(true)
    expect(validate([{ unknownOption: true }]), name).toBe(false)
  }
  const cases: [string, unknown][] = [
    ['naming/table-case', { format: 'mixed' }],
    ['naming/table-number', { irregular: { person: 3 } }],
    ['naming/join-table', { joins: [{ table: 'app.*', left: 'a' }] }],
    ['naming/constraint', { templates: { mystery: 'x' } }],
    ['columns/required', { columns: { created_at: { nullable: 'no' } } }],
    ['objects/security', { security: 'owner' }],
    ['postgres/rls', { commands: ['merge'] }],
    ['zenstack/policies', { commands: ['insert'] }],
  ]
  for (const [name, config] of cases) {
    expect(ajv.compile({ type: 'array', items: builtinRules[name]!.meta.schema })([config])).toBe(
      false,
    )
  }
})
