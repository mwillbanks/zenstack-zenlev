import { AsyncLocalStorage } from 'node:async_hooks'
import type { Span, SpanExporter, ReadableSpan } from './telemetry-types'
import type { Attributes, Reporter, ReporterSpan, ZenlevSettings } from './types'

type TelemetryOptions = NonNullable<ZenlevSettings['telemetry']>['opentelemetry']
type TraceAttributes = Record<string, string | number | boolean>

const noop = () => {}
const silentSpan: ReporterSpan = {
  setAttribute: noop,
  addEvent: noop,
  recordException: noop,
  end: noop,
}

export const silentReporter: Reporter = {
  async span(_name, callback) {
    return callback(silentSpan)
  },
  event: noop,
  info: noop,
  warn: noop,
  error: noop,
}

const attributeKeys = new Set(['code', 'status', 'durationMs', 'zenlev.migration.id'])
function safe(attributes: Attributes | undefined): TraceAttributes {
  const result: TraceAttributes = {}
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (!attributeKeys.has(key)) continue
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
      result[key] = value
    if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value)) result[key] = value
  }
  return result
}

function eventName(name: string): string {
  return /^[a-z][a-z0-9_.-]{0,63}$/i.test(name) ? name : 'zenlev.event'
}

function consoleExporter(write: (line: string) => void): SpanExporter {
  return {
    export(spans: ReadableSpan[], result) {
      try {
        for (const span of spans) {
          write(
            JSON.stringify({
              name: span.name,
              traceId: span.spanContext().traceId,
              attributes: span.attributes,
              status: span.status.code,
              events: span.events.map(({ name, attributes }) => ({ name, attributes })),
            }) + '\n',
          )
        }
        result({ code: 0 })
      } catch (error) {
        result({ code: 1, error: error instanceof Error ? error : new Error(String(error)) })
      }
    },
    async shutdown() {},
  }
}

export async function createTelemetry(
  options: TelemetryOptions,
  write: (line: string) => void = (line) => {
    process.stderr.write(line)
  },
) {
  if (!options?.enabled) return { reporter: silentReporter, close: async () => {} }

  const [{ BasicTracerProvider, SimpleSpanProcessor }, { resourceFromAttributes }, api] =
    await Promise.all([
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/api'),
    ])
  const exporter =
    options.exporter === 'otlp'
      ? new (await import('@opentelemetry/exporter-trace-otlp-http')).OTLPTraceExporter(
          options.otlpEndpoint === undefined ? {} : { url: options.otlpEndpoint },
        )
      : consoleExporter(write)
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': options.serviceName ?? 'zenlev' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const tracer = provider.getTracer('zenlev')
  const local = new AsyncLocalStorage<Span>()

  const reportEvent = (name: string, attributes: Attributes | undefined) => {
    const event = eventName(name)
    const active = local.getStore()
    if (active) active.addEvent(event, safe(attributes))
    else tracer.startSpan(event, { attributes: safe(attributes) }).end()
  }

  const reporter: Reporter = {
    async span(name, callback) {
      const parent = local.getStore()
      const span = tracer.startSpan(
        eventName(name),
        {},
        parent ? api.trace.setSpan(api.ROOT_CONTEXT, parent) : api.ROOT_CONTEXT,
      )
      const fail = () => {
        span.setStatus({ code: api.SpanStatusCode.ERROR })
        span.addEvent('zenlev.exception')
      }
      let ended = false
      const end = () => {
        if (!ended) {
          ended = true
          span.end()
        }
      }
      const handle: ReporterSpan = {
        setAttribute: (key, value) => {
          span.setAttributes(safe({ [key]: value }))
        },
        addEvent: (event, attributes) => {
          span.addEvent(eventName(event), safe(attributes))
        },
        recordException: fail,
        end,
      }
      try {
        return await local.run(span, () => callback(handle))
      } catch (error) {
        fail()
        throw error
      } finally {
        end()
      }
    },
    event: reportEvent,
    info: (_message, attributes) => reportEvent('zenlev.info', attributes),
    warn: (_message, attributes) => reportEvent('zenlev.warning', attributes),
    error: (_message, attributes) => reportEvent('zenlev.error', attributes),
  }
  return { reporter, close: () => provider.shutdown() }
}
