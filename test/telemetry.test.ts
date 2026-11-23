import { expect, mock, test } from 'bun:test'
import { createTelemetry } from '../src/telemetry'

test('reports spans and safe attributes without exposing arbitrary messages or parameters', async () => {
  const lines: string[] = []
  const { reporter, close } = await createTelemetry(
    { enabled: true, exporter: 'console' },
    (line) => {
      lines.push(line)
    },
  )
  try {
    reporter.info('password=secret', { status: 'ready', durationMs: Infinity })
    await expect(
      reporter.span('outer', async (outer) => {
        outer.setAttribute('code', 'VALID_CODE')
        outer.setAttribute('status', 'invalid raw status')
        outer.addEvent('event with private data', { durationMs: 2, parameters: ['secret'] })
        reporter.warn('private warning', { code: false })
        await reporter.span('inner', (inner) => {
          inner.end()
          inner.end()
        })
        reporter.error('private error')
        outer.recordException('private exception')
        throw Error('credential text')
      }),
    ).rejects.toThrow('credential text')
  } finally {
    await close()
  }
  const [info, inner, outer] = lines.map((line) => JSON.parse(line))
  expect(info).toMatchObject({ name: 'zenlev.info', attributes: { status: 'ready' } })
  expect(inner.traceId).toBe(outer.traceId)
  expect(outer).toMatchObject({
    name: 'outer',
    attributes: { code: 'VALID_CODE' },
    status: 2,
    events: [
      { name: 'zenlev.event', attributes: { durationMs: 2 } },
      { name: 'zenlev.warning', attributes: { code: false } },
      { name: 'zenlev.error' },
      { name: 'zenlev.exception' },
      { name: 'zenlev.exception' },
    ],
  })
  expect(lines.join('')).not.toMatch(/password|secret|private|credential|parameters/)
})

test('supports opt-out and isolates a broken telemetry sink', async () => {
  const write = mock(() => {
    throw Error('sink failed')
  })
  const disabled = await createTelemetry({ enabled: false }, write)
  disabled.reporter.event('silent')
  expect(
    await disabled.reporter.span('silent', (span) => {
      span.setAttribute('code', 'SILENT')
      span.addEvent('silent')
      span.recordException('silent')
      span.end()
      return 1
    }),
  ).toBe(1)
  await disabled.close()
  expect(write).not.toHaveBeenCalled()
  const enabled = await createTelemetry({ enabled: true }, write)
  expect(await enabled.reporter.span('enabled', () => 1)).toBe(1)
  await enabled.close()
  expect(write).toHaveBeenCalledTimes(1)
})

test.each([
  ['always_off', undefined, 0],
  ['always_on', undefined, 2],
  ['parentbased_always_off', undefined, 0],
  ['parentbased_always_on', undefined, 2],
  ['traceidratio', '0', 0],
  ['traceidratio', '2', 2],
  ['parentbased_traceidratio', '0', 0],
  ['parentbased_traceidratio', 'invalid', 2],
  [undefined, undefined, 2],
] as const)('honors trace sampler %s with argument %s', async (sampler, argument, count) => {
  const write = mock(() => {})
  const env = {
    ...(sampler === undefined ? {} : { OTEL_TRACES_SAMPLER: sampler }),
    ...(argument === undefined ? {} : { OTEL_TRACES_SAMPLER_ARG: argument }),
  }
  const { reporter, close } = await createTelemetry({ enabled: true }, write, env)
  try {
    reporter.event('standalone')
    await reporter.span('parent', (parent) => parent.addEvent('child-event'))
  } finally {
    await close()
  }
  expect(write).toHaveBeenCalledTimes(count)
})

test('preserves operator-configured trace attribute and event limits', async () => {
  const lines: string[] = []
  const { reporter, close } = await createTelemetry({ enabled: true }, (line) => lines.push(line), {
    OTEL_ATTRIBUTE_COUNT_LIMIT: '1',
    OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: '3',
    OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: 'invalid',
    OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: '2',
    OTEL_SPAN_EVENT_COUNT_LIMIT: '1',
  })
  try {
    await reporter.span('limited', (span) => {
      span.setAttribute('status', 'ready')
      span.setAttribute('code', 'OK')
      span.addEvent('first')
      span.addEvent('last')
    })
  } finally {
    await close()
  }
  expect(lines.map((line) => JSON.parse(line))).toMatchObject([
    { name: 'limited', attributes: { status: 're' }, events: [{ name: 'last' }] },
  ])
  expect(JSON.parse(lines[0]!).attributes).toEqual({ status: 're' })
})
