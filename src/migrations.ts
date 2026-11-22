import { createId } from '@paralleldrive/cuid2'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  HashAlgorithm,
  MigrationCtx,
  MigrationIdentity,
  MigrationMeta,
  Warning,
} from './types'

export interface HashSettings {
  readonly algorithm?: HashAlgorithm
  readonly normalizeLineEndings?: boolean
}

export interface LoadedMigration extends MigrationIdentity {
  readonly up: (context: MigrationCtx) => void | Promise<void>
  readonly down?: (context: MigrationCtx) => void | Promise<void>
}

export interface AuthorMigrationInput {
  readonly name: string
  readonly namespace?: string
  readonly dependsOn?: readonly string[]
  readonly supersedes?: readonly string[]
  readonly tags?: readonly string[]
  readonly custom?: Readonly<Record<string, unknown>>
  readonly rollback?: MigrationMeta['rollback']
  readonly warnings?: readonly Warning[]
  readonly upBody?: string
  readonly downBody?: string
  readonly format?: boolean
  readonly hashing?: HashSettings
}

export interface AuthorMigrationRuntime {
  readonly now?: () => Date
  readonly createId?: () => string
  readonly validate?: (identity: MigrationIdentity) => void
}

const nativeRequire = createRequire(import.meta.url)
const idPattern = /^[a-z][a-z0-9]{1,31}$/
const namePattern = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/
const algorithms = new Set<string>(['sha256', 'sha512', 'sha1', 'md5'])
const warningCodes = new Set<string>([
  'DROP_TABLE',
  'DROP_COLUMN',
  'TYPE_NARROWING',
  'UNIQUE_CONSTRAINT',
  'DESTRUCTIVE_DATA',
  'REDUCED_TRANSACTION_SAFETY',
  'ACTIVE_DEPENDENTS',
  'UNSUPPORTED_SCHEMA',
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) {
    throw new TypeError(
      'Migration IDs must be CUID2 strings containing 2 to 32 lowercase characters',
    )
  }
}

function validateStrings(value: unknown, label: string, ids = false): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${label} must be an array of nonempty strings`)
  }
  if (new Set(value).size !== value.length)
    throw new TypeError(`${label} contains duplicate entries`)
  if (ids) value.forEach(validateId)
}

function validateMeta(value: unknown): asserts value is MigrationMeta {
  if (!record(value)) throw new TypeError('Migration meta must be an object')
  validateId(value.id)
  if (typeof value.name !== 'string' || !namePattern.test(value.name)) {
    throw new TypeError(
      'Migration names must start with a lowercase letter and use letters, digits, _ or -',
    )
  }
  if (typeof value.namespace !== 'string' || !value.namespace.trim()) {
    throw new TypeError('Migration namespace must be a nonempty string')
  }
  if (typeof value.createdAt !== 'string')
    throw new TypeError('Migration createdAt must be a UTC timestamp')
  const date = new Date(value.createdAt)
  if (
    !Number.isFinite(date.getTime()) ||
    (date.toISOString() !== value.createdAt &&
      date.toISOString().replace('.000Z', 'Z') !== value.createdAt)
  ) {
    throw new TypeError('Migration createdAt must be a valid ISO UTC timestamp')
  }
  validateStrings(value.dependsOn, 'dependsOn', true)
  validateStrings(value.supersedes, 'supersedes', true)
  validateStrings(value.tags, 'tags')
  if (value.custom !== undefined && !record(value.custom)) {
    throw new TypeError('Migration custom must be an object')
  }
  if (value.warnings !== undefined) {
    if (
      !Array.isArray(value.warnings) ||
      value.warnings.some(
        (warning) =>
          !record(warning) ||
          typeof warning.code !== 'string' ||
          !warningCodes.has(warning.code) ||
          typeof warning.message !== 'string' ||
          !warning.message.trim() ||
          (warning.details !== undefined && !record(warning.details)),
      )
    ) {
      throw new TypeError('Migration warnings must contain supported codes and nonempty messages')
    }
  }
  if (value.rollback !== undefined) {
    const rollback = value.rollback
    if (!record(rollback) || !['cascade', 'compensate'].includes(String(rollback.mode))) {
      throw new TypeError('Migration rollback must specify cascade or compensate')
    }
    validateId(rollback.target)
    validateStrings(rollback.reversals, 'rollback.reversals', true)
    if (!Array.isArray(rollback.reversals) || !rollback.reversals.includes(rollback.target)) {
      throw new TypeError('Migration rollback reversals must include its target')
    }
  }
}

export function hashMigrationContent(
  content: string | Buffer,
  settings: HashSettings = {},
): string {
  const algorithm = settings.algorithm ?? 'sha256'
  if (!algorithms.has(algorithm)) throw new TypeError(`Unsupported hash algorithm: ${algorithm}`)
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
  const hash = createHash(algorithm)
  return (
    settings.normalizeLineEndings === false
      ? hash.update(bytes)
      : hash.update(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
  ).digest('hex')
}

async function readRegularFile(filePath: string): Promise<Buffer> {
  if (!(await lstat(filePath)).isFile()) {
    throw new TypeError(`Migration is not a regular file: ${filePath}`)
  }
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat({ bigint: true })
    const entry = await lstat(filePath, { bigint: true })
    if (
      !opened.isFile() ||
      !entry.isFile() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino
    ) {
      throw new TypeError(`Migration is not a regular file: ${filePath}`)
    }
    return await file.readFile()
  } finally {
    await file.close()
  }
}

function snapshotMeta(meta: MigrationMeta): MigrationMeta {
  return Object.freeze({
    ...meta,
    dependsOn: Object.freeze([...(meta.dependsOn ?? [])]),
    supersedes: Object.freeze([...(meta.supersedes ?? [])]),
    tags: Object.freeze([...(meta.tags ?? [])]),
    custom: Object.freeze({ ...meta.custom }),
    warnings: Object.freeze([...(meta.warnings ?? [])]),
  })
}

function fileIdentity(fileName: string): { id: string; name: string } {
  const separator = fileName.indexOf('_')
  const id = fileName.slice(0, separator)
  const name = fileName.slice(separator + 1, -3)
  validateId(id)
  if (separator < 1 || !namePattern.test(name)) {
    throw new TypeError(`Invalid migration filename: ${fileName}`)
  }
  return { id, name }
}

async function migrationDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TypeError(`Migrations directory must be a regular directory: ${directory}`)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function discoverMigrations(
  directory: string,
  hashing: HashSettings = {},
): Promise<LoadedMigration[]> {
  hashMigrationContent('', hashing)
  const root = resolve(directory)
  if (!(await migrationDirectory(root))) return []
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile()) throw new TypeError(`Migration must be a regular file: ${entry.name}`)
    const { id } = fileIdentity(entry.name)
    if (ids.has(id)) throw new TypeError(`Duplicate migration ID: ${id}`)
    ids.add(id)
  }
  const migrations: LoadedMigration[] = []
  for (const entry of entries) {
    const filePath = join(root, entry.name)
    const before = await readRegularFile(filePath)
    const url = pathToFileURL(filePath)
    // Bun caches ESM by resolved path, including imports with different URL queries.
    delete nativeRequire.cache[nativeRequire.resolve(filePath)]
    url.searchParams.set('zenlev', hashMigrationContent(before, { normalizeLineEndings: false }))
    const module: unknown = await import(url.href)
    const after = await readRegularFile(filePath)
    if (!before.equals(after)) throw new Error(`Migration changed during discovery: ${filePath}`)
    if (!record(module)) throw new TypeError(`Invalid migration module: ${filePath}`)
    validateMeta(module.meta)
    const expected = fileIdentity(entry.name)
    if (module.meta.id !== expected.id || module.meta.name !== expected.name) {
      throw new TypeError(`Migration filename does not match meta: ${entry.name}`)
    }
    if (
      typeof module.up !== 'function' ||
      (module.down !== undefined && typeof module.down !== 'function')
    ) {
      throw new TypeError(`Migration must export up and may export down functions: ${entry.name}`)
    }
    migrations.push(
      Object.freeze({
        ...snapshotMeta(module.meta),
        filePath,
        hash: hashMigrationContent(before, hashing),
        up: module.up as LoadedMigration['up'],
        ...(module.down === undefined
          ? {}
          : { down: module.down as NonNullable<LoadedMigration['down']> }),
      }),
    )
  }
  return migrations
}

export async function verifyMigrationFile(
  migration: MigrationIdentity,
  hashing: HashSettings = {},
): Promise<void> {
  const algorithm = hashing.algorithm ?? 'sha256'
  const expectedLength = hashMigrationContent('', hashing).length
  if (!new RegExp(`^[a-f0-9]{${expectedLength}}$`).test(migration.hash)) {
    throw new TypeError(`Invalid ${algorithm} migration hash for ${migration.id}`)
  }
  const identity = fileIdentity(basename(migration.filePath))
  if (identity.id !== migration.id || identity.name !== migration.name) {
    throw new TypeError(`Migration filename does not match meta: ${migration.filePath}`)
  }
  const hash = hashMigrationContent(await readRegularFile(migration.filePath), hashing)
  if (hash !== migration.hash) throw new Error(`Migration hash mismatch: ${migration.id}`)
}

function formatSource(source: string, filePath: string): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'fmt', '--no-script', '--stdin-filepath', filePath],
    stdin: Buffer.from(source),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`Migration formatting failed: ${new TextDecoder().decode(result.stderr)}`)
  }
  return new TextDecoder().decode(result.stdout)
}

export async function authorMigration(
  directory: string,
  input: AuthorMigrationInput,
  runtime: AuthorMigrationRuntime = {},
): Promise<MigrationIdentity> {
  const meta = {
    id: (runtime.createId ?? createId)(),
    name: input.name,
    namespace: input.namespace ?? 'default',
    createdAt: (runtime.now ?? (() => new Date()))().toISOString(),
    dependsOn: input.dependsOn ?? [],
    supersedes: input.supersedes ?? [],
    tags: input.tags ?? [],
    custom: input.custom ?? {},
    ...(input.rollback === undefined ? {} : { rollback: input.rollback }),
    ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
  }
  validateMeta(meta)
  hashMigrationContent('', input.hashing)
  const root = resolve(directory)
  const filePath = join(root, `${meta.id}_${meta.name}.ts`)
  let source = `import type { MigrationCtx, MigrationMeta } from '@mwillbanks/zenstack-zenlev'\n\nexport const meta = ${JSON.stringify(meta, null, 2)} satisfies MigrationMeta\n\nexport async function up(ctx: MigrationCtx) {\n${input.upBody ?? '  void ctx'}\n}\n`
  if (input.downBody !== undefined)
    source += `\nexport async function down(ctx: MigrationCtx) {\n${input.downBody}\n}\n`
  if (input.format) source = formatSource(source, filePath)
  const identity = Object.freeze({
    ...snapshotMeta(meta),
    filePath,
    hash: hashMigrationContent(source, input.hashing),
  })
  runtime.validate?.(identity)
  await mkdir(root, { recursive: true })
  await migrationDirectory(root)
  const temporary = join(root, `.${basename(filePath)}.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx')
  try {
    await file.writeFile(source)
    await file.close()
    await link(temporary, filePath)
  } finally {
    try {
      await file.close()
    } finally {
      await unlink(temporary)
    }
  }
  return identity
}
