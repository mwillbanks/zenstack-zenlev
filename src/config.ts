import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ClientFactory, HashAlgorithm, ZenlevConfig } from './types'

const configNames = ['zenlev.config.ts', 'zenlev.config.js', 'zenlev.config.json']
const nested = ['store', 'namespaces', 'diff', 'hashing', 'telemetry', 'lint'] as const
const connectionKeys = ['adapter', 'client', 'createClient', 'clientModule'] as const
const algorithms: readonly HashAlgorithm[] = ['sha256', 'sha512', 'sha1', 'md5']

type Layer = Record<string, unknown>

export type ResolvedProjectConfig = ZenlevConfig & {
  readonly cwd: string
  readonly env: string
  readonly migrationsDir: string
  readonly lintPluginBase?: string
}

function object(value: unknown, label: string): Layer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(label + ' must be an object')
  }
  return value as Layer
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function implicitConfig(cwd: string): Promise<string | undefined> {
  for (const name of configNames) {
    const path = resolve(cwd, name)
    if (await isFile(path)) return path
  }
}

async function packageLayer(path: string): Promise<Layer> {
  if (!(await isFile(path))) return {}
  const manifest = object(await Bun.file(path).json(), 'package.json')
  return manifest.zenlev === undefined ? {} : object(manifest.zenlev, 'package.json zenlev')
}

async function dedicatedLayer(path: string): Promise<Layer> {
  if (!(await isFile(path))) throw new Error('Zenlev config file not found: ' + path)
  if (path.endsWith('.json')) return object(await Bun.file(path).json(), path)
  if (!path.endsWith('.js') && !path.endsWith('.ts')) {
    throw new Error('Zenlev config must use .ts, .js, or .json: ' + path)
  }
  const namespace: { default?: unknown } = await import(pathToFileURL(path).href)
  return object(namespace.default, path + ' default export')
}

function merge(base: Layer, override: Layer): Layer {
  const merged = { ...base, ...override }
  for (const group of nested) {
    if (base[group] === undefined && override[group] === undefined) continue
    const low = object(base[group] ?? {}, group)
    const high = object(override[group] ?? {}, group)
    merged[group] = { ...low, ...high }
    if (group === 'lint' && (low.rules !== undefined || high.rules !== undefined)) {
      merged[group] = {
        ...low,
        ...high,
        rules: {
          ...object(low.rules ?? {}, 'lint.rules'),
          ...object(high.rules ?? {}, 'lint.rules'),
        },
      }
    }
    if (
      group === 'telemetry' &&
      (low.opentelemetry !== undefined || high.opentelemetry !== undefined)
    ) {
      merged[group] = {
        opentelemetry: {
          ...object(low.opentelemetry ?? {}, 'opentelemetry'),
          ...object(high.opentelemetry ?? {}, 'opentelemetry'),
        },
      }
    }
  }
  if (connectionKeys.some((key) => override[key] !== undefined)) {
    for (const key of connectionKeys) {
      if (override[key] === undefined) delete merged[key]
    }
  }
  return merged
}

function validate(settings: Layer): void {
  for (const key of ['cwd', 'env', 'migrationsDir', 'schema'] as const) {
    const value = settings[key]
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError(key + ' must be a nonempty string')
    }
  }
  const hashing = object(settings.hashing ?? {}, 'hashing')
  if (hashing.algorithm !== undefined && !algorithms.includes(hashing.algorithm as HashAlgorithm)) {
    throw new TypeError('Unsupported hash algorithm: ' + String(hashing.algorithm))
  }
  if (
    hashing.normalizeLineEndings !== undefined &&
    typeof hashing.normalizeLineEndings !== 'boolean'
  ) {
    throw new TypeError('hashing.normalizeLineEndings must be a boolean')
  }
  const diff = object(settings.diff ?? {}, 'diff')
  if (diff.excludeViews !== undefined && typeof diff.excludeViews !== 'boolean') {
    throw new TypeError('diff.excludeViews must be a boolean')
  }
  const telemetry = object(settings.telemetry ?? {}, 'telemetry')
  const otel = object(telemetry.opentelemetry ?? {}, 'telemetry.opentelemetry')
  if (otel.enabled !== undefined && typeof otel.enabled !== 'boolean') {
    throw new TypeError('telemetry.opentelemetry.enabled must be a boolean')
  }
  if (otel.exporter !== undefined && otel.exporter !== 'console' && otel.exporter !== 'otlp') {
    throw new TypeError('telemetry.opentelemetry.exporter must be console or otlp')
  }
  if (settings.clientModule !== undefined && typeof settings.clientModule !== 'string') {
    throw new TypeError('clientModule must be a project module path')
  }
  if (connectionKeys.filter((key) => settings[key] !== undefined).length > 1) {
    throw new TypeError('Configure one database adapter, client, or client factory')
  }
}

export async function loadProjectConfig(
  overrides: ZenlevConfig = {},
  explicitConfig?: string,
  options: { readonly loadClientModule?: boolean; readonly lintCatalogConnection?: boolean } = {},
): Promise<ResolvedProjectConfig> {
  const initialCwd = resolve(overrides.cwd ?? process.cwd())
  const packagePath = resolve(initialCwd, 'package.json')
  const dedicatedPath = explicitConfig
    ? resolve(initialCwd, explicitConfig)
    : await implicitConfig(initialCwd)
  const fromPackage = await packageLayer(packagePath)
  const dedicated = dedicatedPath ? await dedicatedLayer(dedicatedPath) : {}
  const combined = merge(merge(fromPackage, dedicated), { ...overrides })
  validate(combined)
  if (
    options.loadClientModule !== false &&
    !(options.lintCatalogConnection && (combined.lint as ZenlevConfig['lint'])?.catalog?.connect) &&
    typeof combined.clientModule === 'string'
  ) {
    const owner =
      dedicated.clientModule !== undefined && dedicatedPath ? dedicatedPath : packagePath
    const modulePath = resolve(dirname(owner), combined.clientModule)
    const namespace: { default?: unknown } = await import(pathToFileURL(modulePath).href)
    if (typeof namespace.default !== 'function') {
      throw new TypeError('Client module must default-export a factory: ' + modulePath)
    }
    combined.createClient = namespace.default as ClientFactory<unknown>
    delete combined.clientModule
  }
  const cwd = overrides.cwd ?? (combined.cwd as string | undefined) ?? '.'
  const resolvedCwd = overrides.cwd === undefined ? resolve(initialCwd, cwd) : initialCwd
  const hasLintPlugins = (layer: Layer) =>
    Object.hasOwn(object(layer.lint ?? {}, 'lint'), 'plugins')
  const lintPluginBase = hasLintPlugins({ ...overrides })
    ? resolvedCwd
    : dedicatedPath && hasLintPlugins(dedicated)
      ? dirname(dedicatedPath)
      : initialCwd
  return {
    ...combined,
    cwd: resolvedCwd,
    ...(combined.lint === undefined ? {} : { lintPluginBase }),
    env: (combined.env as string | undefined) ?? process.env.NODE_ENV ?? 'development',
    migrationsDir: resolve(
      resolvedCwd,
      (combined.migrationsDir as string | undefined) ?? 'migrations',
    ),
    ...(typeof combined.schema === 'string'
      ? { schema: resolve(resolvedCwd, combined.schema) }
      : {}),
  } as ResolvedProjectConfig
}

export function defineConfig<const Config extends ZenlevConfig>(config: Config): Config {
  return config
}
