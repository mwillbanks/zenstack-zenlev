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
