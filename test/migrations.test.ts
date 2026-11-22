import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  authorMigration,
  discoverMigrations,
  hashMigrationContent,
  verifyMigrationFile,
} from '../src/migrations'

const firstId = 'a12345678901234567890123'
const secondId = 'b12345678901234567890123'
const createdAt = '2026-11-21T12:00:00.000Z'
const runtime = {
  now: () => new Date(createdAt),
  createId: () => firstId,
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(import.meta.dir, '.zenlev-migrations-'))
})

afterEach(async () => {
  mock.restore()
  setSystemTime()
  await rm(directory, { recursive: true, force: true })
})

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: firstId, name: 'first_change', namespace: 'default', createdAt, ...overrides }
}

async function fixture(
  meta: Record<string, unknown> = metadata(),
  options: { name?: string; handlers?: string; prefix?: string } = {},
): Promise<string> {
  const filePath = join(directory, options.name ?? `${firstId}_first_change.ts`)
  await writeFile(
    filePath,
    `${options.prefix ?? ''}\nexport const meta = ${JSON.stringify(meta)}\n${options.handlers ?? 'export async function up() {}'}\n`,
  )
  return filePath
}

describe('migration hashes', () => {
  test.each(['sha256', 'sha512', 'sha1', 'md5'] as const)('supports %s', (algorithm) => {
    expect(hashMigrationContent('migration\n', { algorithm })).toBe(
      createHash(algorithm).update('migration\n').digest('hex'),
    )
  })

  test('normalizes CRLF by default and preserves requested original bytes', () => {
    expect(hashMigrationContent(Buffer.from('a\r\nb\n'))).toBe(hashMigrationContent('a\nb\n'))
    expect(hashMigrationContent('a\r\nb', { normalizeLineEndings: false })).not.toBe(
      hashMigrationContent('a\nb'),
    )
  })

  test('hashes original non-ASCII bytes while normalizing CRLF', () => {
    const before = Buffer.from([255, 13, 10, 128])
    const after = Buffer.from([255, 10, 128])
    expect(hashMigrationContent(before)).toBe(createHash('sha256').update(after).digest('hex'))
  })

  test('rejects unknown hash algorithms', () => {
    expect(() => hashMigrationContent('', { algorithm: 'bogus' as 'sha256' })).toThrow(
      'Unsupported hash algorithm',
    )
  })
})

describe('migration discovery', () => {
  test('returns no migrations for an absent directory without creating it', async () => {
    const absent = join(directory, 'absent')
    expect(await discoverMigrations(absent)).toEqual([])
    expect(await readdir(directory)).toEqual([])
    await expect(discoverMigrations(absent, { algorithm: 'invalid' as 'sha256' })).rejects.toThrow(
      'Unsupported hash algorithm',
    )
  })

  test('loads sorted TypeScript migrations with frozen metadata and optional down', async () => {
    await fixture(
      metadata({ id: secondId, name: 'second_change', createdAt: '2026-11-21T12:00:00Z' }),
      {
        name: `${secondId}_second_change.ts`,
        handlers: 'export async function up() {}\nexport function down() {}',
      },
    )
    await fixture()
    await writeFile(join(directory, 'types.d.ts'), 'export declare const ignored: string')
    await writeFile(join(directory, 'notes.md'), 'ignored')
    await mkdir(join(directory, 'nested'))
    const migrations = await discoverMigrations(directory)
    expect(migrations.map((migration) => migration.id)).toEqual([firstId, secondId])
    expect(migrations[0]?.dependsOn).toEqual([])
    expect(migrations[0]?.custom).toEqual({})
    expect(migrations[0]?.warnings).toEqual([])
    expect(migrations[0]?.down).toBeUndefined()
    expect(typeof migrations[1]?.down).toBe('function')
    expect(Object.isFrozen(migrations[0])).toBe(true)
    expect(Object.isFrozen(migrations[0]?.dependsOn)).toBe(true)
    await expect(verifyMigrationFile(migrations[0]!)).resolves.toBeUndefined()
    await migrations[0]!.up({} as never)
    await migrations[1]!.down?.({} as never)
  })

  test('preserves declared graph, namespace, warning, and rollback metadata', async () => {
    const rollback = { mode: 'compensate', target: secondId, reversals: [secondId] }
    const warning = {
      code: 'ACTIVE_DEPENDENTS',
      message: 'Review dependents',
      details: { count: 2 },
    }
    await fixture(
      metadata({
        namespace: 'predeploy',
        dependsOn: [secondId],
        supersedes: [secondId],
        tags: ['release'],
        custom: { ticket: 'x' },
        warnings: [warning],
        rollback,
      }),
    )
    const [migration] = await discoverMigrations(directory)
    expect(migration).toMatchObject({
      namespace: 'predeploy',
      dependsOn: [secondId],
      supersedes: [secondId],
      tags: ['release'],
      custom: { ticket: 'x' },
      warnings: [warning],
      rollback,
    })
  })

  test('reloads updated source using its content hash', async () => {
    await fixture(metadata(), {
      handlers: 'export function up(ctx) { ctx.reporter.info("first") }',
    })
    const [first] = await discoverMigrations(directory)
    await fixture(metadata(), {
      handlers: 'export function up(ctx) { ctx.reporter.info("second") }',
    })
    const [second] = await discoverMigrations(directory)
    const info = mock()
    const context = { reporter: { info } }
    expect(first?.hash).not.toBe(second?.hash)
    await first?.up(context as never)
    await second?.up(context as never)
    expect(info.mock.calls).toEqual([['first'], ['second']])
  })

  test('detects source mutation during module evaluation', async () => {
    await fixture(metadata(), {
      prefix:
        "import { appendFile } from 'node:fs/promises'\nawait appendFile(import.meta.path, '\\n// changed\\n')",
    })
    await expect(discoverMigrations(directory)).rejects.toThrow('changed during discovery')
  })

  test('rejects duplicate IDs before evaluating migration modules', async () => {
    await fixture()
    await fixture(metadata({ name: 'duplicate' }), { name: `${firstId}_duplicate.ts` })
    await expect(discoverMigrations(directory)).rejects.toThrow('Duplicate migration ID')
  })

  test.each(['bad.ts', `${firstId}_../bad.ts`, '1abc_bad.ts', `${firstId}_Bad.ts`])(
    'rejects invalid filename %s',
    async (name) => {
      const safeName = name.replaceAll('/', '-')
      await fixture(metadata(), { name: safeName })
      await expect(discoverMigrations(directory)).rejects.toThrow()
    },
  )

  test.each([
    null,
    { id: 1 },
    { name: '../escape' },
    { namespace: '' },
    { createdAt: 3 },
    { createdAt: '2026-02-30T00:00:00Z' },
    { createdAt: '2026-11-21T12:00:00+00:00' },
    { dependsOn: 'bad' },
    { dependsOn: ['bad ID'] },
    { dependsOn: [secondId, secondId] },
    { supersedes: [null] },
    { tags: [1] },
    { custom: [] },
    { warnings: {} },
    { warnings: [{ code: 'UNRECOGNIZED', message: 'warning' }] },
    { warnings: [{ code: 'DROP_TABLE', message: '' }] },
    { warnings: [{ code: 'DROP_TABLE', message: 'warning', details: [] }] },
    { rollback: {} },
    { rollback: { mode: 'cascade', target: 'invalid ID' } },
    { rollback: { mode: 'cascade', target: secondId } },
    { rollback: { mode: 'cascade', target: secondId, reversals: [] } },
  ])('rejects malformed metadata %j', async (invalid) => {
    if (invalid === null) {
      await fixture()
      await writeFile(
        join(directory, `${firstId}_first_change.ts`),
        'export const meta = null; export async function up() {}',
      )
    } else await fixture(metadata(invalid))
    await expect(discoverMigrations(directory)).rejects.toThrow()
  })

  test('rejects filename identity mismatches', async () => {
    await fixture(metadata({ id: secondId }))
    await expect(discoverMigrations(directory)).rejects.toThrow('filename does not match meta')
    await fixture(metadata({ name: 'different' }))
    await expect(discoverMigrations(directory)).rejects.toThrow('filename does not match meta')
  })

  test.each(['export const up = 1', 'export function up() {}\nexport const down = null'])(
    'rejects invalid handlers',
    async (handlers) => {
      await fixture(metadata(), { handlers })
      await expect(discoverMigrations(directory)).rejects.toThrow('must export up')
    },
  )

  test('refuses migration symlinks and directories with a migration extension', async () => {
    const real = await fixture()
    await symlink(real, join(directory, `${secondId}_linked.ts`))
    await expect(discoverMigrations(directory)).rejects.toThrow('regular file')
    await rm(join(directory, `${secondId}_linked.ts`))
    await mkdir(join(directory, `${secondId}_folder.ts`))
    await expect(discoverMigrations(directory)).rejects.toThrow('regular file')
  })

  test('refuses a symlink or file as the migration directory', async () => {
    await mkdir(join(directory, 'real'))
    await symlink(join(directory, 'real'), join(directory, 'linked'))
    await expect(discoverMigrations(join(directory, 'linked'))).rejects.toThrow('regular directory')
    const file = await fixture()
    await expect(discoverMigrations(file)).rejects.toThrow('regular directory')
  })
})

describe('migration verification', () => {
  test('detects modified migration content and invalid declared hashes', async () => {
    await fixture()
    const [migration] = await discoverMigrations(directory)
    await expect(verifyMigrationFile({ ...migration!, hash: 'invalid' })).rejects.toThrow(
      'Invalid sha256',
    )
    await writeFile(migration!.filePath, 'changed')
    await expect(verifyMigrationFile(migration!)).rejects.toThrow('hash mismatch')
    await expect(verifyMigrationFile({ ...migration!, name: 'another' })).rejects.toThrow(
      'filename does not match meta',
    )
  })

  test('uses the selected hashing and line ending settings', async () => {
    const file = await fixture()
    const original = await readFile(file, 'utf8')
    await writeFile(file, original.replaceAll('\n', '\r\n'))
    const [migration] = await discoverMigrations(directory, { algorithm: 'sha512' })
    expect(migration!.hash).toHaveLength(128)
    await expect(verifyMigrationFile(migration!, { algorithm: 'sha512' })).resolves.toBeUndefined()
    await expect(
      verifyMigrationFile(migration!, { algorithm: 'sha512', normalizeLineEndings: false }),
    ).rejects.toThrow('hash mismatch')
  })

  test('refuses nonregular files and symlink replacements at execution time', async () => {
    await fixture()
    const [migration] = await discoverMigrations(directory)
    const real = join(directory, 'real.txt')
    await writeFile(real, await readFile(migration!.filePath))
    await rm(migration!.filePath)
    await symlink(real, migration!.filePath)
    await expect(verifyMigrationFile(migration!)).rejects.toThrow()
    await rm(migration!.filePath)
    await mkdir(migration!.filePath)
    await expect(verifyMigrationFile(migration!)).rejects.toThrow('regular file')
  })
})

describe('migration authoring', () => {
  test('authors a loadable skeleton using explicit injected ID and clock', async () => {
    const authored = await authorMigration(
      join(directory, 'new'),
      { name: 'first_change' },
      runtime,
    )
    expect(authored).toMatchObject({
      id: firstId,
      name: 'first_change',
      namespace: 'default',
      createdAt,
      dependsOn: [],
      supersedes: [],
      tags: [],
      custom: {},
    })
    const source = await readFile(authored.filePath, 'utf8')
    expect(source).toContain("from '@mwillbanks/zenstack-zenlev'")
    expect(source).toContain('satisfies MigrationMeta')
    const [discovered] = await discoverMigrations(join(directory, 'new'))
    expect(discovered).toMatchObject(authored)
    expect(discovered?.down).toBeUndefined()
    await discovered!.up({} as never)
  })

  test('uses production ID generation with a controlled system clock', async () => {
    setSystemTime(new Date(createdAt))
    const authored = await authorMigration(directory, { name: 'production_id' })
    expect(authored.id).toMatch(/^[a-z][a-z0-9]{23}$/)
    expect(authored.createdAt).toBe(createdAt)
  })

  test('preserves explicit bodies and authoring metadata', async () => {
    const authored = await authorMigration(
      directory,
      {
        name: 'first_change',
        namespace: 'postdeploy',
        dependsOn: [secondId],
        supersedes: [secondId],
        tags: ['repair'],
        custom: { source: 'fixture' },
        warnings: [{ code: 'DESTRUCTIVE_DATA', message: 'Review the reversal' }],
        rollback: { mode: 'cascade', target: secondId, reversals: [secondId] },
        upBody: '  ctx.reporter.info("up")',
        downBody: '  ctx.reporter.info("down")',
        hashing: { algorithm: 'md5', normalizeLineEndings: false },
      },
      runtime,
    )
    expect(authored.hash).toHaveLength(32)
    const [migration] = await discoverMigrations(directory, {
      algorithm: 'md5',
      normalizeLineEndings: false,
    })
    expect(migration?.namespace).toBe('postdeploy')
    const info = mock()
    const context = { reporter: { info } }
    await migration?.up(context as never)
    await migration?.down?.(context as never)
    expect(info.mock.calls).toEqual([['up'], ['down']])
  })

  test('publishes a complete file without overwriting a concurrent migration', async () => {
    const results = await Promise.allSettled([
      authorMigration(directory, { name: 'first_change' }, runtime),
      authorMigration(directory, { name: 'first_change' }, runtime),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await readdir(directory)).toEqual([`${firstId}_first_change.ts`])
    expect(await discoverMigrations(directory)).toHaveLength(1)
  })

  test('cleans an owned temporary file after a failed write', async () => {
    const probe = await open(join(directory, 'probe'), 'wx')
    const prototype = Object.getPrototypeOf(probe)
    await probe.close()
    spyOn(prototype, 'writeFile').mockRejectedValue(new Error('write failed'))
    await expect(authorMigration(directory, { name: 'first_change' }, runtime)).rejects.toThrow(
      'write failed',
    )
    expect(await readdir(directory)).toEqual(['probe'])
  })

  test('validates authoring metadata before creating directories', async () => {
    const absent = join(directory, 'absent')
    await expect(authorMigration(absent, { name: '../escape' }, runtime)).rejects.toThrow()
    await expect(
      authorMigration(
        absent,
        { name: 'first_change' },
        { ...runtime, createId: () => 'not valid' },
      ),
    ).rejects.toThrow()
    await expect(
      authorMigration(
        absent,
        { name: 'first_change', hashing: { algorithm: 'bad' as 'sha256' } },
        runtime,
      ),
    ).rejects.toThrow('Unsupported hash algorithm')
    expect(await readdir(directory)).toEqual([])
  })

  test('rejects a symlink directory without writing through it', async () => {
    await mkdir(join(directory, 'real'))
    await symlink(join(directory, 'real'), join(directory, 'linked'))
    await expect(
      authorMigration(join(directory, 'linked'), { name: 'first_change' }, runtime),
    ).rejects.toThrow('regular directory')
    expect(await readdir(join(directory, 'real'))).toEqual([])
  })

  test('uses Bun formatting only when explicitly requested', async () => {
    const formatter = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from('formatted source'),
      stderr: Buffer.alloc(0),
    } as ReturnType<typeof Bun.spawnSync>)
    const authored = await authorMigration(
      directory,
      { name: 'first_change', format: true },
      runtime,
    )
    expect(await readFile(authored.filePath, 'utf8')).toBe('formatted source')
    expect(formatter).toHaveBeenCalledTimes(1)
    expect(formatter.mock.calls[0]?.[0]).toMatchObject({
      cmd: [process.execPath, 'fmt', '--no-script', '--stdin-filepath', authored.filePath],
    })
  })

  test('reports formatter diagnostics before creating output', async () => {
    spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('bad generated syntax'),
    } as ReturnType<typeof Bun.spawnSync>)
    await expect(
      authorMigration(join(directory, 'absent'), { name: 'first_change', format: true }, runtime),
    ).rejects.toThrow('bad generated syntax')
    expect(await readdir(directory)).toEqual([])
  })
})
