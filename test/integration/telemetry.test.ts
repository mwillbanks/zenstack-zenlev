import { expect, test } from 'bun:test'
import { createTelemetry } from '../../src/telemetry'

test('delivers an OTLP HTTP payload and closes the exporter', async () => {
  const delivered = Promise.withResolvers<{ path: string; body: string }>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      delivered.resolve({ path: new URL(request.url).pathname, body: await request.text() })
      return Response.json({})
    },
  })
  try {
    const telemetry = await createTelemetry({
      enabled: true,
      exporter: 'otlp',
      otlpEndpoint: new URL('/v1/traces', server.url).href,
    })
    await telemetry.reporter.span('migration.test', (span) => span.setAttribute('status', 'ok'))
    await telemetry.close()
    const result = await delivered.promise
    expect(result.path).toBe('/v1/traces')
    expect(result.body).toContain('migration.test')
  } finally {
    await server.stop(true)
  }
})
