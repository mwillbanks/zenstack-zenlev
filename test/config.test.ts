import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { loadProjectConfig } from '../src/config'
import type { ZenlevConfig } from '../src'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(import.meta.dir, '.zenlev-config-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function write(path: string, value: unknown): Promise<number> {
  return Bun.write(join(cwd, path), typeof value === 'string' ? value : JSON.stringify(value))
}

test('resolves migration defaults and preserves process environment', async () => {
  const previous = process.env.NODE_ENV
  const config = await loadProjectConfig({ cwd, env: 'selected' })
  expect(config).toEqual({ cwd, env: 'selected', migrationsDir: join(cwd, 'migrations') })
  expect(process.env.NODE_ENV).toBe(previous)
})

test('merges package, config and overrides in that order', async () => {
  await write('package.json', {
    zenlev: {
      env: 'package',
      migrationsDir: 'package-migrations',
      store: { tableName: 'ledger', location: 'table' },
      telemetry: { opentelemetry: { exporter: 'otlp', enabled: false } },
      hashing: { algorithm: 'sha512' },
    },
  })
  await write('zenlev.config.json', {
    env: 'file',
    migrationsDir: 'file-migrations',
    schema: 'schema.zmodel',
    store: { lockTableName: 'locks' },
    telemetry: { opentelemetry: { serviceName: 'project' } },
    hashing: { normalizeLineEndings: false },
  })
  const config = await loadProjectConfig({
    cwd,
    env: 'flag',
    telemetry: { opentelemetry: { enabled: true } },
  })
  expect(config).toMatchObject({
    env: 'flag',
    migrationsDir: join(cwd, 'file-migrations'),
    schema: join(cwd, 'schema.zmodel'),
    store: { tableName: 'ledger', location: 'table', lockTableName: 'locks' },
    telemetry: { opentelemetry: { exporter: 'otlp', enabled: true, serviceName: 'project' } },
    hashing: { algorithm: 'sha512', normalizeLineEndings: false },
  })
})

test('uses Bun for TypeScript and supports an explicit JavaScript config', async () => {
  await write('zenlev.config.ts', 'const env: string = "typed"; export default { env }')
  await write('other.js', 'export default { env: "javascript" }')
  expect((await loadProjectConfig({ cwd })).env).toBe('typed')
  expect((await loadProjectConfig({ cwd }, 'other.js')).env).toBe('javascript')
})

test('loads the factory relative to its declaring configuration', async () => {
  await write('nested/custom.json', { clientModule: './client.ts' })
  await write(
    'nested/client.ts',
    'export default (env: { name: string }) => ({ client: env.name, dispose() {} })',
  )
  const config = await loadProjectConfig({ cwd, env: 'production' }, 'nested/custom.json')
  const owned = await config.createClient?.({ cwd, name: config.env })
  expect(owned?.client).toBe('production')
})

test('accepts a package factory and replaces the connection source from higher layers', async () => {
  await write('package.json', { zenlev: { clientModule: './factory.js' } })
  await write('factory.js', 'export default () => ({ client: "package", dispose() {} })')
  const loaded = await loadProjectConfig({ cwd })
  expect((await loaded.createClient?.({ cwd, name: 'dev' }))?.client).toBe('package')
  const replacement = await loadProjectConfig({ cwd, client: 'provided' })
  expect(replacement.client).toBe('provided')
  expect(replacement.createClient).toBeUndefined()
})

test.each([
  [{ hashing: { algorithm: 'crc32' } }, 'Unsupported hash algorithm'],
  [{ hashing: { normalizeLineEndings: 'false' } }, 'must be a boolean'],
  [{ env: '' }, 'env must be a nonempty string'],
  [{ clientModule: 17 }, 'must be a project module path'],
  [{ client: {}, clientModule: './factory.js' }, 'Configure one database'],
  [{ diff: ['views'] }, 'diff must be an object'],
  [{ diff: { excludeViews: 'false' } }, 'diff.excludeViews must be a boolean'],
  [{ telemetry: { opentelemetry: { enabled: 'false' } } }, 'enabled must be a boolean'],
  [{ telemetry: { opentelemetry: { exporter: 'unknown' } } }, 'exporter must be console or otlp'],
  [[], 'must be an object'],
])('fails invalid configuration %j', async (config, message) => {
  await write('zenlev.config.json', config)
  await expect(loadProjectConfig({ cwd })).rejects.toThrow(message)
})

test('reports unusable files and factory exports', async () => {
  await expect(loadProjectConfig({ cwd }, 'missing.ts')).rejects.toThrow('not found')
  await write('config.txt', '{}')
  await expect(loadProjectConfig({ cwd }, 'config.txt')).rejects.toThrow('must use')
  await write('factory.js', 'export default {}')
  await write('zenlev.config.json', { clientModule: './factory.js' })
  await expect(loadProjectConfig({ cwd })).rejects.toThrow('default-export a factory')
})

test('uses configured cwd when the caller omits it', async () => {
  const actual = await loadProjectConfig({}, join(cwd, 'config.json')).catch((error) => error)
  expect(actual).toBeInstanceOf(Error)
  await write('config.json', { cwd })
  const config = await loadProjectConfig({}, join(cwd, 'config.json'))
  expect(config.cwd).toBe(cwd)
  expect(config.migrationsDir).toBe(join(cwd, 'migrations'))
})

test('validates package configuration objects', async () => {
  await write('package.json', { zenlev: true })
  await expect(loadProjectConfig({ cwd })).rejects.toThrow('package.json zenlev must be an object')
})

test('validates explicitly supplied runtime overrides', async () => {
  const invalid = { cwd, schema: [] } as unknown as ZenlevConfig
  await expect(loadProjectConfig(invalid)).rejects.toThrow('schema must be a nonempty string')
})
