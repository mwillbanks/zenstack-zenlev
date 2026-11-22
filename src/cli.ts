#!/usr/bin/env bun
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { version as packageVersion } from '../package.json'
import { createZenlev, type Zenlev } from './engine'
import type { ApplyOptions, ApplyResult, ZenlevConfig, ZenlevSettings } from './types'
import type { PushResult } from './schema-commands'
import type { StatusEntry } from './inspection'
import type { CreateOptions, RemoveOptions, StatusOptions, TreeOptions } from './inspection'
import type { RollbackOptions } from './rollback'
import type { ResolveOptions, ReshapeOptions } from './execution'
import type { RecoveryOptions } from './store'

const globalStrings = [
  'config',
  'cwd',
  'env',
  'schema',
  'migrations-dir',
  'store-location',
  'store-schema-name',
  'store-database-name',
  'store-table-name',
  'store-lock-table-name',
  'hash-algorithm',
  'otel-service-name',
  'otel-exporter',
  'otel-otlp-endpoint',
]
const globalBooleans = ['json', 'hash-normalize-line-endings', 'otel']
const commandFlags = {
  'db push': [
    'dry-run',
    'sql',
    'create-migration',
    'name',
    'format',
    'exclude-views',
    'namespace',
    'drop-missing-tables',
  ],
  'migrate create': [
    'name',
    'namespace',
    'depends-on',
    'supersedes',
    'empty',
    'from-schema',
    'to-db',
    'format',
    'drop-missing-tables',
  ],
  'migrate apply': [
    'namespace',
    'from',
    'to',
    'only',
    'tags',
    'dry-run',
    'plan-only',
    'no-transaction',
    'continue-on-failure',
  ],
  'migrate rollback': ['id', 'namespace', 'name', 'dry-run', 'format', 'cascade', 'compensate'],
  'migrate status': ['namespace', 'mismatched-only', 'show-resolved'],
  'migrate tree': ['namespace', 'format', 'show-supersedes'],
  'migrate remove': ['id', 'namespace', 'all', 'dry-run', 'force'],
  'migrate reshape': ['id', 'accept', 'drop', 'reason', 'actor'],
  'migrate resolve': ['id', 'hash', 'reason', 'actor'],
  'migrate recover': ['action', 'owner', 'id', 'attempt-id', 'actor', 'reason', 'evidence'],
} as const
type Command = keyof typeof commandFlags
const stringFlags = new Set([
  ...globalStrings,
  'name',
  'namespace',
  'depends-on',
  'supersedes',
  'from-schema',
  'from',
  'to',
  'only',
  'tags',
  'id',
  'accept',
  'drop',
  'reason',
  'actor',
  'hash',
  'drop-missing-tables',
  'action',
  'owner',
  'attempt-id',
  'evidence',
])
const camel = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
type CommandOptions = Record<string, string | boolean | readonly string[]>

export interface CliInvocation {
  readonly command: Command | undefined
  readonly config: ZenlevSettings
  readonly configPath?: string
  readonly options: CommandOptions
  readonly json: boolean
  readonly help: boolean
  readonly version: boolean
}

function commandHint(args: readonly string[]): string {
  const words: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith('-')) {
      words.push(arg)
      if (words.length === 2) break
    } else if (arg.startsWith('--') && !arg.includes('=')) {
      const flag = arg.slice(2)
      if (
        stringFlags.has(flag) ||
        (flag === 'format' && ['text', 'mermaid'].includes(args[index + 1] ?? ''))
      )
        index++
    }
  }
  return words.join(' ')
}

function choice(value: unknown, values: readonly string[], flag: string): void {
  if (value !== undefined && !values.includes(String(value))) {
    throw new TypeError('--' + flag + ' must be one of ' + values.join(', '))
  }
}

function required(options: CommandOptions, keys: readonly string[]): void {
  for (const key of keys) {
    if (typeof options[key] !== 'string' || !String(options[key]).trim()) {
      throw new TypeError(
        '--' + key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()) + ' is required',
      )
    }
  }
}

export function parseCli(args: readonly string[]): CliInvocation {
  const hint = commandHint(args)
  const flags = Object.hasOwn(commandFlags, hint) ? commandFlags[hint as Command] : []
  const options: NonNullable<ParseArgsConfig['options']> = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'V' },
  }
  for (const flag of [...globalStrings, ...globalBooleans, ...flags]) {
    options[flag] = {
      type:
        stringFlags.has(flag) || (flag === 'format' && hint === 'migrate tree')
          ? 'string'
          : 'boolean',
    }
  }
  const parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true })
  const values = parsed.values
  const commandName = parsed.positionals.join(' ')
  const help = values.help === true || args.length === 0
  const version = values.version === true
  const command = Object.hasOwn(commandFlags, commandName) ? (commandName as Command) : undefined
  if (!help && !version && command === undefined) {
    throw new TypeError('Unknown command ' + JSON.stringify(commandName) + '. Run zenlev --help.')
  }
  const config: Record<string, unknown> = {}
  for (const key of ['cwd', 'env', 'schema', 'migrations-dir']) {
    if (values[key] !== undefined) config[camel(key)] = values[key]
  }
  const store: Record<string, unknown> = {}
  for (const key of globalStrings.filter((flag) => flag.startsWith('store-'))) {
    if (values[key] !== undefined) store[camel(key.slice(6))] = values[key]
  }
  choice(store.location, ['schema', 'database', 'table'], 'store-location')
  if (Object.keys(store).length) config.store = store
  const hashing: Record<string, unknown> = {}
  if (values['hash-algorithm'] !== undefined) hashing.algorithm = values['hash-algorithm']
  choice(hashing.algorithm, ['sha256', 'sha512', 'sha1', 'md5'], 'hash-algorithm')
  if (values['hash-normalize-line-endings'] !== undefined)
    hashing.normalizeLineEndings = values['hash-normalize-line-endings']
  if (Object.keys(hashing).length) config.hashing = hashing
  const telemetry: Record<string, unknown> = {}
  for (const key of ['otel', 'otel-service-name', 'otel-exporter', 'otel-otlp-endpoint']) {
    if (values[key] !== undefined)
      telemetry[key === 'otel' ? 'enabled' : camel(key.slice(5))] = values[key]
  }
  choice(telemetry.exporter, ['console', 'otlp'], 'otel-exporter')
  if (Object.keys(telemetry).length) config.telemetry = { opentelemetry: telemetry }

  const selected: CommandOptions = {}
  for (const flag of flags) {
    const value = values[flag]
    if (value === undefined) continue
    const list =
      ['depends-on', 'supersedes', 'only', 'tags'].includes(flag) ||
      (flag === 'namespace' &&
        ['migrate apply', 'migrate status', 'migrate tree'].includes(hint)) ||
      (flag === 'id' && hint === 'migrate remove')
    if (list) {
      const items = String(value)
        .split(',')
        .map((item) => item.trim())
      if (items.some((item) => !item))
        throw new TypeError('--' + flag + ' requires nonempty comma-separated values')
      selected[camel(flag)] = [...new Set(items)]
    } else selected[camel(flag)] = value as string | boolean
  }
  choice(selected.dropMissingTables, ['apply', 'skip'], 'drop-missing-tables')
  if (command === 'migrate tree') choice(selected.format, ['text', 'mermaid'], 'format')
  if (!help && !version) {
    if (['migrate create'].includes(command!)) required(selected, ['name'])
    if (['migrate rollback', 'migrate reshape', 'migrate resolve'].includes(command!))
      required(selected, ['id'])
    if (command === 'migrate rollback') {
      if (Boolean(selected.cascade) === Boolean(selected.compensate))
        throw new TypeError('Choose exactly one of --cascade or --compensate')
      selected.mode = selected.cascade ? 'cascade' : 'compensate'
      delete selected.cascade
      delete selected.compensate
    }
    if (command === 'migrate recover') {
      required(selected, ['action', 'actor', 'reason', 'evidence'])
      choice(selected.action, ['release-lock', 'applied', 'retry'], 'action')
      required(selected, selected.action === 'release-lock' ? ['owner'] : ['id', 'attemptId'])
    }
  }
  return {
    command,
    config: config as ZenlevSettings,
    options: selected,
    json: values.json === true,
    help,
    version,
    ...(typeof values.config === 'string' ? { configPath: values.config } : {}),
  }
}

export const helpText = `Usage: zenlev <command> [options]

Commands
  db push
  migrate create | apply | rollback | status | tree | remove | reshape | resolve | recover

Global options
  --config <path>  --cwd <path>  --env <name>  --schema <path>
  --migrations-dir <path>  --store-location <schema|database|table>
  --store-schema-name <name>  --store-database-name <name>
  --store-table-name <name>  --store-lock-table-name <name>
  --hash-algorithm <sha256|sha512|sha1|md5>  --hash-normalize-line-endings
  --otel  --otel-service-name <name>  --otel-exporter <console|otlp>
  --otel-otlp-endpoint <url>  --json  --help  --version

Rollback requires --id and either --cascade or --compensate.
Recovery requires --action, --actor, --reason, and --evidence.
Run zen db pull to introspect a database.
`

export interface CliDependencies {
  readonly create?: (config: ZenlevConfig, configPath?: string) => Promise<Zenlev>
  readonly stdout?: (text: string) => void | Promise<void>
  readonly stderr?: (text: string) => void | Promise<void>
  readonly tty?: boolean
  readonly confirm?: (question: string) => boolean | Promise<boolean>
  readonly render?: (text: string, write: (text: string) => void | Promise<void>) => Promise<void>
}

async function confirm(question: string): Promise<boolean> {
  const input = createInterface({ input: process.stdin, output: process.stderr })
  const controller = new AbortController()
  input.once('SIGINT', () => controller.abort())
  try {
    const response = await input.question(question + ' [y/N] ', { signal: controller.signal })
    return /^(y|yes)$/i.test(response.trim())
  } finally {
    input.close()
  }
}

function human(parsed: CliInvocation, result: unknown): string {
  if (typeof result === 'string') return result
  if (result === undefined) return 'Completed.'
  if (parsed.command === 'db push' && result && typeof result === 'object' && 'changes' in result) {
    const push = result as PushResult
    const { changes } = push
    const statements = changes.operations.flatMap(({ up }) => up.map(({ sql }) => sql + ';'))
    const details = [
      ...changes.blockers.map(({ message }) => 'Blocked · ' + message),
      ...changes.missingTables.map(
        ({ id, referencedBy }) =>
          'Drop candidate · ' +
          id +
          (referencedBy.length ? ' (referenced by ' + referencedBy.join(', ') + ')' : ''),
      ),
      ...changes.warnings.map(({ message }) => 'Warning · ' + message),
    ]
    if (parsed.options.sql)
      return [
        ...details.flatMap((detail) => detail.split('\n').map((line) => '-- ' + line)),
        ...statements,
      ].join('\n')
    return [
      'Schema push · ' + push.status,
      ...(push.error ? [push.error] : []),
      ...details,
      ...statements,
      ...(push.migration ? [push.migration.filePath] : []),
    ].join('\n')
  }
  if (parsed.command === 'migrate status' && Array.isArray(result)) {
    return (
      (result as StatusEntry[])
        .map(({ id, name, namespace, status }) => [status, namespace, id, name].join(' · '))
        .join('\n') || 'No matching migrations.'
    )
  }
  if (
    parsed.command === 'migrate apply' &&
    result &&
    typeof result === 'object' &&
    'plan' in result
  ) {
    const apply = result as ApplyResult
    return [
      'Migration apply · ' + apply.status,
      ...apply.plan.blockers.map(({ message }) => 'Blocked · ' + message),
      ...apply.plan.warnings.map(({ message }) => 'Warning · ' + message),
      ...(apply.status === 'planned'
        ? apply.plan.migrations.map(({ id, name }) => id + ' · ' + name)
        : apply.migrations.map(({ id, status, error }) =>
            [status, id, error].filter(Boolean).join(' · '),
          )),
    ].join('\n')
  }
  return JSON.stringify(result, null, 2)
}

function failed(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const object = result as {
    status?: unknown
    blockers?: readonly unknown[]
    plan?: unknown
    changes?: unknown
  }
  return (
    object.status === 'failed' ||
    object.status === 'blocked' ||
    object.status === 'partial' ||
    (Array.isArray(object.blockers) && object.blockers.length > 0) ||
    failed(object.plan) ||
    failed(object.changes)
  )
}

async function invoke(
  client: Zenlev,
  parsed: CliInvocation & { command: Command },
  tty: boolean,
  ask: (question: string) => boolean | Promise<boolean>,
): Promise<unknown> {
  const options: Record<string, unknown> = { ...parsed.options }
  if (tty && (parsed.command === 'db push' || parsed.command === 'migrate create')) {
    options.confirmDrops = async (candidates: readonly string[]) => {
      const accepted: string[] = []
      for (const table of candidates)
        if (await ask('Drop table ' + table + '?')) accepted.push(table)
      return accepted
    }
  }
  switch (parsed.command) {
    case 'db push':
      return client.db.push(options)
    case 'migrate create':
      return client.migrate.create(options as unknown as CreateOptions)
    case 'migrate apply':
      return client.migrate.apply(options as ApplyOptions)
    case 'migrate rollback':
      return client.migrate.rollback(options as unknown as RollbackOptions)
    case 'migrate status':
      return client.migrate.status(options as StatusOptions)
    case 'migrate tree':
      return client.migrate.tree(options as TreeOptions)
    case 'migrate remove':
      if (tty)
        options.confirm = (migrations: readonly { id: string }[]) =>
          ask('Remove migrations ' + migrations.map(({ id }) => id).join(', ') + '?')
      return client.migrate.remove(options as RemoveOptions)
    case 'migrate reshape':
      return client.migrate.reshape(options as unknown as ReshapeOptions)
    case 'migrate resolve':
      return client.migrate.resolve(options as unknown as ResolveOptions)
    case 'migrate recover':
      return client.migrate.recover(options as unknown as RecoveryOptions)
  }
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout =
    dependencies.stdout ??
    ((text: string) => {
      process.stdout.write(text)
    })
  const stderr =
    dependencies.stderr ??
    ((text: string) => {
      process.stderr.write(text)
    })
  const tty = dependencies.tty ?? Boolean(process.stdout.isTTY && process.stdin.isTTY)
  let parsed: CliInvocation | undefined
  let client: Zenlev | undefined
  try {
    parsed = parseCli(args)
    if (parsed.help || parsed.version) {
      const commandHelp = parsed.command
        ? '\nOptions for ' +
          parsed.command +
          '\n  ' +
          commandFlags[parsed.command].map((flag) => '--' + flag).join('  ') +
          '\n'
        : ''
      const result = parsed.version ? packageVersion : helpText + commandHelp
      await stdout(
        parsed.json
          ? JSON.stringify({ status: 'ok', result }) + '\n'
          : result + (parsed.version ? '\n' : ''),
      )
      return 0
    }
    client = await (dependencies.create ?? createZenlev)(
      {
        ...parsed.config,
        onWarning: (warning) => {
          if (!parsed?.json) void stderr('Warning [' + warning.code + '] ' + warning.message + '\n')
        },
      },
      parsed.configPath,
    )
    const result = await invoke(
      client,
      { ...parsed, command: parsed.command! },
      tty && !parsed.json,
      dependencies.confirm ?? confirm,
    )
    await client.close()
    client = undefined
    if (parsed.json)
      await stdout(
        JSON.stringify({ status: failed(result) ? 'error' : 'ok', result: result ?? null }) + '\n',
      )
    else if (tty && !parsed.options.sql) {
      const render = dependencies.render ?? (await import('./cli-render')).renderTerminal
      await render(human(parsed, result), stdout)
    } else await stdout(human(parsed, result) + '\n')
    return failed(result) ? 1 : 0
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    if (client) {
      try {
        await client.close()
      } catch (closeError) {
        message +=
          '; cleanup failed: ' +
          (closeError instanceof Error ? closeError.message : String(closeError))
      }
    }
    const json = parsed?.json ?? args.includes('--json')
    if (json) await stdout(JSON.stringify({ status: 'error', error: { message } }) + '\n')
    else await stderr(message + '\n')
    return 1
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2))
