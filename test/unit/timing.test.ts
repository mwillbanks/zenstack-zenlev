import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { checkTimingFiles, inspectTiming } from '../../scripts/check-unit-timing'

test.each([
  'const later = setTimeout; later(fn, 1)',
  "import { setTimeout as wait } from 'node:timers/promises'",
  "const { setInterval: poll } = require('node:timers')",
  'const { hrtime: now } = process',
  "const pause = Bun['sleep']",
  'const clock = Date; new clock()',
  'const now = Date.now; now()',
  'const now = performance.now',
  'while (ready());',
])('rejects real-time code %#', (source) => {
  expect(inspectTiming('fixture.ts', source).faults.length).toBeGreaterThan(0)
})

test.each([
  "const timestamp = new Date('2026-01-01T00:00:00Z')",
  'const deferred = Promise.withResolvers<void>(); deferred.resolve()',
  'await clock.advanceBy(1000)',
  'const now = () => 123',
  "await Promise.resolve('done')",
])('accepts deterministic code %#', (source) => {
  expect(inspectTiming('fixture.ts', source).faults).toEqual([])
})

test('discovers source imports, exports, and dynamic imports for helper traversal', () => {
  const source = "import { wait } from './helper'; export * from './other'; await import('./async')"
  expect(inspectTiming('fixture.ts', source).imports).toEqual(['./helper', './other', './async'])
})

test('separates integration suites from production code using native paths', async () => {
  const integration = resolve(import.meta.dir, '../integration/terminal.test.ts')
  const production = resolve(import.meta.dir, '../../src/engine.ts')
  expect(await checkTimingFiles([integration, production])).toEqual([
    'test/integration/terminal.test.ts: Unit suites cannot import integration fixtures',
  ])
})
