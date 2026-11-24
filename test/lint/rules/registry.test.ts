import { expect, test } from 'bun:test'
import { join } from 'node:path'
import Schema from 'typebox/schema'
import { builtinPresets, builtinRules, recommendedLintConfig } from '../../../src/lint/rules'
import { inspect, table } from './fixtures'

test('recommended preset exposes six documented defaults and optional families', () => {
  expect(Object.keys(recommendedLintConfig.rules!)).toHaveLength(6)
  expect(Object.values(recommendedLintConfig.rules!)).toEqual(Array(6).fill('error'))
  expect(builtinPresets.recommended).toBe(recommendedLintConfig)
  expect(Object.keys(builtinPresets)).toEqual(['recommended', 'naming', 'objects', 'access'])
  expect(Object.keys(builtinRules)).toHaveLength(20)
})

test('documents every built-in rule once and lists every page in navigation', async () => {
  const root = join(import.meta.dir, '../../../website/content/docs/reference')
  const directory = join(root, 'rules')
  const pages = Array.from(new Bun.Glob('*.mdx').scanSync(directory)).sort()
  const navigation = (await Bun.file(join(directory, 'meta.json')).json()).pages as string[]
  expect(navigation.map((slug) => slug + '.mdx').sort()).toEqual(pages)

  const overview = await Bun.file(join(root, 'lint-rules.mdx')).text()
  const rules = await Promise.all(
    pages.map(async (page) => {
      const content = await Bun.file(join(directory, page)).text()
      expect(content).toContain('## Parameters')
      expect(content).toContain('## Example')
      expect(overview).toContain('./reference/rules/' + page.slice(0, -4) + ')')
      return /^\s*'zenlev\/([^']+)':/m.exec(content)?.[1]
    }),
  )
  expect(rules.sort()).toEqual(Object.keys(builtinRules).sort())
})

test('rule creators reject malformed option primitives and nested mappings', () => {
  expect(() => inspect('naming/table-case', [], null)).toThrow('object')
  expect(() => inspect('naming/table-case', [], [])).toThrow('object')
  expect(() => inspect('naming/table-case', [table], { kinds: 'table' })).toThrow('strings')
  expect(() => inspect('naming/table-case', [table], { format: 1 })).toThrow('strings')
  expect(() => inspect('naming/table-number', [table], { irregular: [] })).toThrow('objects')
})

test('built-in option schemas reject typos and malformed structures before scanning', () => {
  for (const [name, rule] of Object.entries(builtinRules)) {
    const validate = Schema.Compile({
      type: 'array',
      items: rule.meta.schema,
      additionalItems: false,
    })
    expect(validate.Check([]), name).toBe(true)
    expect(validate.Check([{ unknownOption: true }]), name).toBe(false)
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
    expect(
      Schema.Compile({ type: 'array', items: builtinRules[name]!.meta.schema }).Check([config]),
    ).toBe(false)
  }
})
