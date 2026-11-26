import Schema from 'typebox/schema'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { identity as qualifiedIdentity } from '../identity'
import { resolveIndexDrops } from './indexes'
import { builtinPresets, builtinRules } from './rules'
import type {
  LintConfig,
  LintDiagnostic,
  LintException,
  LintGap,
  LintInput,
  LintNode,
  LintOptions,
  LintResult,
  LintRule,
  LintRulePlugin,
  LintRuleSetting,
  LintSelector,
  LintSeverity,
  LintSource,
} from './types'

type Setting = { readonly severity: LintSeverity; readonly options: readonly unknown[] }
interface RuleGroup {
  readonly id: string
  readonly rule: LintRule
  readonly setting: Setting
  readonly selectors: readonly {
    readonly match: (node: LintNode) => boolean
    readonly setting: Setting
  }[]
}

export interface LintBatch extends LintInput {
  readonly context?: readonly LintNode[]
}

const severity = new Set(['off', 'warn', 'error'])
const origins = new Set(['zmodel', 'sql', 'migration', 'catalog', 'application'])
const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export function lintOptions(options: LintOptions): void {
  if (options.live !== undefined && typeof options.live !== 'boolean')
    throw new TypeError('lint live must be a boolean')
  if (
    options.maxWarnings !== undefined &&
    (!Number.isSafeInteger(options.maxWarnings) || options.maxWarnings < 0)
  )
    throw new TypeError('--max-warnings requires a nonnegative integer')
}

function record(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(label + ' must be an object')
}

function strings(values: unknown, label: string): void {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim()))
    throw new TypeError(label + ' must contain nonempty strings')
}

function selector(entry: LintSelector, cwd: string): (node: LintNode) => boolean {
  for (const key of ['files', 'kinds', 'origins', 'dialects', 'identities'] as const)
    if (entry[key] !== undefined) strings(entry[key], 'lint override ' + key)
  if (entry.origins?.some((origin) => !origins.has(origin)))
    throw new TypeError('Invalid lint override origin')
  const files = entry.files?.map((glob) => new Bun.Glob(glob))
  const identities = entry.identities?.map((glob) => new Bun.Glob(glob))
  return (node) =>
    (!files ||
      (!!node.source &&
        files.some((glob) => glob.match(relativeSource(cwd, node.source!).path)))) &&
    (!identities || identities.some((glob) => glob.match(identity(node)))) &&
    (!entry.kinds || entry.kinds.includes(node.kind)) &&
    (!entry.origins || entry.origins.includes(node.origin)) &&
    (!entry.dialects || (!!node.dialect && entry.dialects.includes(node.dialect)))
}

function relativeSource(cwd: string, source: LintSource): LintSource {
  return isAbsolute(source.path) ? { ...source, path: relative(cwd, source.path) } : source
}

function identity(node: LintNode): string {
  if (node.identity) return node.identity
  const tableName = node.table === node.name ? undefined : node.table
  return (
    qualifiedIdentity(
      node.schema,
      ...[tableName, node.name].filter((part): part is string => Boolean(part)),
    ) + (node.signature === undefined ? '' : '(' + node.signature + ')')
  )
}

function fingerprint(
  source: LintSource,
  ruleId: string,
  objectId: string,
  fileHash?: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        source.path,
        source.line,
        source.column,
        source.endLine,
        source.endColumn,
        source.fingerprint ?? fileHash,
        ruleId,
        objectId,
      ]),
    )
    .digest('hex')
}

async function register(
  specifiers: LintConfig['plugins'],
  base: string,
): Promise<Map<string, LintRule>> {
  const rules = new Map(Object.entries(builtinRules).map(([id, rule]) => ['zenlev/' + id, rule]))
  const aliases = new Set(['zenlev'])
  if (specifiers === undefined) return rules
  if (!Array.isArray(specifiers)) throw new TypeError('lint plugins must be an array')
  for (const entry of specifiers) {
    if (typeof entry !== 'string') record(entry, 'lint plugin')
    const descriptor = typeof entry === 'string' ? { specifier: entry } : entry
    let plugin: LintRulePlugin
    let alias: string | undefined
    if ('specifier' in descriptor) {
      if (typeof descriptor.specifier !== 'string' || !descriptor.specifier.trim())
        throw new TypeError('Lint plugin specifier must be a nonempty string')
      const file = Bun.resolveSync(descriptor.specifier, base)
      const imported: { default?: LintRulePlugin } = await import(pathToFileURL(file).href)
      plugin = imported.default!
      alias = descriptor.name
    } else plugin = descriptor
    alias ??= plugin?.meta?.name
    if (typeof alias !== 'string' || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(alias) || aliases.has(alias))
      throw new TypeError('Invalid or duplicate lint plugin name: ' + String(alias))
    aliases.add(alias)
    record(plugin?.rules, 'lint plugin rules')
    for (const [id, rule] of Object.entries(plugin.rules)) {
      if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(id) || typeof rule?.create !== 'function')
        throw new TypeError('Invalid lint rule: ' + alias + '/' + id)
      record(rule.meta?.messages, 'lint rule messages')
      if (Object.values(rule.meta.messages).some((message) => typeof message !== 'string'))
        throw new TypeError('Lint rule messages must be strings: ' + alias + '/' + id)
      rules.set(alias + '/' + id, rule)
    }
  }
  return rules
}

function validateConfig(config: LintConfig): void {
  record(config, 'lint')
  for (const key of ['zmodel', 'migrations'] as const)
    if (config[key] !== undefined && typeof config[key] !== 'boolean')
      throw new TypeError('lint.' + key + ' must be a boolean')
  if (
    config.dialect !== undefined &&
    (typeof config.dialect !== 'string' || !config.dialect.trim())
  )
    throw new TypeError('lint.dialect must be a nonempty string')
  for (const key of ['sql', 'source', 'namespaces', 'presets'] as const)
    if (config[key] !== undefined) strings(config[key], 'lint.' + key)
  if (config.rules !== undefined) record(config.rules, 'lint.rules')
  if (config.catalog !== undefined) {
    record(config.catalog, 'lint catalog')
    if (
      typeof config.catalog.dialect !== 'string' ||
      !config.catalog.dialect.trim() ||
      typeof config.catalog.read !== 'function'
    )
      throw new TypeError('Lint catalog must declare a dialect and read method')
  }
  if (config.overrides !== undefined && !Array.isArray(config.overrides))
    throw new TypeError('lint overrides must be an array')
  if (config.exceptions !== undefined && !Array.isArray(config.exceptions))
    throw new TypeError('lint exceptions must be an array')
}

export async function createLintRunner(config: LintConfig, cwd: string, base = cwd) {
  validateConfig(config)
  const rules = await register(config.plugins, base)
  const defaults: Record<string, LintRuleSetting> = {}
  for (const name of config.presets ?? ['recommended']) {
    if (!Object.hasOwn(builtinPresets, name)) throw new TypeError('Unknown lint preset: ' + name)
    Object.assign(defaults, builtinPresets[name]!.rules)
  }
  Object.assign(defaults, config.rules)
  const disabled: Setting = { severity: 'off', options: [] }
  const validators = new Map<string, ReturnType<typeof Schema.Compile>>()
  const decode = (id: string, value: LintRuleSetting): Setting => {
    const rule = rules.get(id)
    if (!rule) throw new TypeError('Unknown lint rule: ' + id)
    const [level, ...options] =
      typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
    if (typeof level !== 'string' || !severity.has(level))
      throw new TypeError('Invalid severity for ' + id)
    const schema = rule.meta.schema ?? []
    if (!Array.isArray(schema)) throw new TypeError('Invalid lint option schema for ' + id)
    if (options.length > schema.length) throw new TypeError('Invalid lint options for ' + id)
    if (options.length) {
      let validator = validators.get(id)
      if (!validator) {
        validator = Schema.Compile({ type: 'array', items: schema, additionalItems: false })
        validators.set(id, validator)
      }
      const [valid, errors] = validator.Errors(options)
      if (!valid)
        throw new TypeError(
          'Invalid lint options for ' +
            id +
            ': ' +
            errors.map(({ instancePath, message }) => instancePath + ' ' + message).join(', '),
        )
    }
    return { severity: level as LintSeverity, options }
  }
  const settings = new Map(Object.entries(defaults).map(([id, value]) => [id, decode(id, value)]))
  const overrides = (config.overrides ?? []).map((entry) => {
    record(entry, 'lint override')
    record(entry.rules, 'lint override rules')
    return {
      match: selector(entry, cwd),
      rules: new Map(Object.entries(entry.rules).map(([id, value]) => [id, decode(id, value)])),
    }
  })
  const groups: RuleGroup[] = []
  for (const [id, rule] of rules) {
    const setting = settings.get(id) ?? disabled
    const selectors = overrides.flatMap((entry) => {
      const override = entry.rules.get(id)
      return override ? [{ match: entry.match, setting: override }] : []
    })
    if (setting.severity !== 'off' || selectors.length)
      groups.push({ id, rule, setting, selectors })
  }
  const exceptions = config.exceptions ?? []
  const exceptionKeys = new Set<string>()
  for (const exception of exceptions) {
    record(exception, 'lint exception')
    if (
      !rules.has(exception.ruleId) ||
      typeof exception.reason !== 'string' ||
      !exception.reason.trim() ||
      (exception.identity === undefined && exception.fingerprint === undefined) ||
      (exception.identity !== undefined &&
        (typeof exception.identity !== 'string' || !exception.identity.trim())) ||
      (exception.fingerprint !== undefined &&
        (typeof exception.fingerprint !== 'string' ||
          !/^[0-9a-f]{64}$/.test(exception.fingerprint)))
    )
      throw new TypeError('Invalid lint exception: ' + String(exception.ruleId))
    const key = JSON.stringify([exception.ruleId, exception.identity, exception.fingerprint])
    if (exceptionKeys.has(key)) throw new TypeError('Duplicate lint exception: ' + exception.ruleId)
    exceptionKeys.add(key)
  }

  return async (
    batches: readonly LintBatch[],
    options: LintOptions = {},
    files = 0,
  ): Promise<LintResult> => evaluate(groups, batches, cwd, exceptions, options, files)
}

async function evaluate(
  groups: readonly RuleGroup[],
  batches: readonly LintBatch[],
  cwd: string,
  exceptions: readonly LintException[],
  options: LintOptions,
  files: number,
): Promise<LintResult> {
  lintOptions(options)
  const diagnostics: LintDiagnostic[] = []
  const gaps: LintGap[] = []
  const capabilities = new Set<string>()
  const fileHashes = new Map<string, Promise<string | undefined>>()
  let suppressed = 0
  const appliedExceptions = new Set<LintException>()
  for (const batch of batches) {
    const catalog = structuredClone(batch.context ?? [])
    const nodes = resolveIndexDrops(structuredClone(batch.nodes), catalog)
    const relevant = [...catalog, ...nodes]
    const available = batch.capabilities ?? []
    for (const capability of available) capabilities.add(capability)
    for (const gap of batch.gaps)
      gaps.push(gap.source ? { ...gap, source: relativeSource(cwd, gap.source) } : gap)

    for (const { id, rule, setting, selectors } of groups) {
      const partitions = new Map<Setting, LintNode[]>()
      for (const node of nodes) {
        let effective = setting
        for (const entry of selectors) if (entry.match(node)) effective = entry.setting
        if (effective.severity === 'off') continue
        const partition = partitions.get(effective) ?? []
        partition.push(node)
        partitions.set(effective, partition)
      }
      for (const [effective, partition] of partitions) {
        const candidates = new Set(partition)
        const pending: { node: LintNode; message: string }[] = []
        const visitors = rule.create({
          options: effective.options,
          nodes: relevant,
          capabilities: available,
          report({ node, anchor, messageId, data }) {
            if (!candidates.has(anchor ?? node)) return
            const template = Object.hasOwn(rule.meta.messages, messageId)
              ? rule.meta.messages[messageId]
              : undefined
            if (typeof template !== 'string')
              throw new TypeError('Unknown message ' + messageId + ' for ' + id)
            const message = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) =>
              String(data?.[key] ?? key),
            )
            pending.push({
              node: anchor?.source && !node.source ? { ...node, source: anchor.source } : node,
              message,
            })
          },
          gap(message, node, anchor) {
            const target = anchor ?? node
            if (target && !candidates.has(target)) return
            gaps.push({
              message: id + ': ' + message,
              ...(target?.source ? { source: relativeSource(cwd, target.source) } : {}),
              ...(node ? { identity: identity(node) } : {}),
            })
          },
        })
        for (const node of partition) {
          if (Object.hasOwn(visitors, node.kind)) visitors[node.kind]?.(node)
          if (Object.hasOwn(visitors, '*')) visitors['*']?.(node)
        }
        for (const { node, message } of pending) {
          const objectId = identity(node)
          const source = node.source && relativeSource(cwd, node.source)
          let sourceHash: string | undefined
          if (source && !source.fingerprint && !source.path.startsWith('<')) {
            const path = resolve(cwd, source.path)
            let cached = fileHashes.get(path)
            if (!cached) {
              cached = Bun.file(path)
                .arrayBuffer()
                .then(
                  (content) => createHash('sha256').update(new Uint8Array(content)).digest('hex'),
                  () => undefined,
                )
              fileHashes.set(path, cached)
            }
            sourceHash = await cached
          }
          const key = source && fingerprint(source, id, objectId, sourceHash)
          const matching = exceptions.filter(
            (entry) =>
              entry.ruleId === id &&
              (entry.identity === undefined || entry.identity === objectId) &&
              (entry.fingerprint === undefined || entry.fingerprint === key),
          )
          if (matching.length) {
            suppressed += 1
            for (const exception of matching) appliedExceptions.add(exception)
            continue
          }
          diagnostics.push({
            ruleId: id,
            message,
            identity: objectId,
            severity: effective.severity as 'warn' | 'error',
            ...(source ? { source } : {}),
            ...(key ? { fingerprint: key } : {}),
          })
        }
      }
    }
  }
  const order = (item: LintGap) =>
    [
      item.source?.path ?? '',
      item.source?.line.toString().padStart(12, '0') ?? '',
      item.source?.column.toString().padStart(12, '0') ?? '',
      item.identity ?? '',
      item.message,
    ].join('\u0000')
  const findings = unique(
    diagnostics,
    (item) => order(item) + '\u0000' + item.ruleId + '\u0000' + item.severity,
  )
  const coverage = unique(gaps, order)
  const staleExceptions = exceptions.filter((item) => !appliedExceptions.has(item))
  const warnings =
    coverage.length +
    staleExceptions.length +
    findings.filter((item) => item.severity === 'warn').length
  return {
    status:
      findings.some((item) => item.severity === 'error') ||
      warnings > (options.maxWarnings ?? Infinity)
        ? 'failed'
        : 'ok',
    diagnostics: findings,
    coverage: { capabilities: [...capabilities].sort(byText), gaps: coverage },
    suppressed,
    staleExceptions,
    files,
  }
}

function unique<Item>(items: readonly Item[], key: (item: Item) => string): Item[] {
  const distinct = new Map(items.map((item) => [key(item), item]))
  return [...distinct.keys()].sort(byText).map((id) => distinct.get(id)!)
}

export async function testLintRule(
  rule: LintRule,
  input: LintInput,
  options: readonly unknown[] = [],
): Promise<LintResult> {
  const runner = await createLintRunner(
    {
      presets: [],
      plugins: [{ meta: { name: 'test' }, rules: { rule } }],
      rules: { 'test/rule': ['error', ...options] },
    },
    process.cwd(),
  )
  return runner([input])
}
