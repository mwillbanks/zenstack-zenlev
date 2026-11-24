import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const entry = resolve(import.meta.dir, '../../src/cli.ts')
const migration = 'migrations/aaa_first.ts'
const meta = { id: 'aaa', name: 'first', namespace: 'default', createdAt: '2026-01-01T00:00:00Z' }

async function run(args: string[], cwd: string, response?: string) {
  let output = ''
  let answered = false
  const decoder = new TextDecoder()
  const displayed = Promise.withResolvers<void>()
  const child = Bun.spawn([process.execPath, entry, ...args], {
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    terminal: {
      rows: 24,
      cols: 100,
      exit() {
        displayed.resolve()
      },
      data(terminal, data) {
        output += decoder.decode(data, { stream: true })
        if (!answered && response !== undefined && output.includes('[y/N]')) {
          answered = true
          terminal.write(response)
        }
      },
    },
  })
  try {
    const status = await child.exited
    await displayed.promise
    return { status, output }
  } finally {
    child.terminal?.close()
  }
}

test('renders a status result through a genuine PTY and restores confirmation after interrupt', async () => {
  const cwd = await mkdtemp(resolve(import.meta.dir, '../.zenlev-terminal-'))
  try {
    const file = resolve(cwd, migration)
    await Bun.write(
      resolve(cwd, 'zenlev.config.ts'),
      `
import { Database } from 'bun:sqlite'
import { Kysely } from 'kysely'
import { createBunSqliteDialect } from '../fixtures/sqlite'
import { createKyselyAdapter } from '../../src'
const db = new Kysely({ dialect: createBunSqliteDialect(new Database(':memory:')) })
export default { adapter: createKyselyAdapter(db, 'sqlite') }
`,
    )
    await Bun.file(file).write(
      'export const meta = ' + JSON.stringify(meta) + '\nexport function up() {}\n',
    )
    const status = await run(['migrate', 'status'], cwd)
    expect(status.status).toBe(0)
    expect(status.output).toContain('pending · default · aaa · first')
    const cancelled = await run(['migrate', 'remove', '--id', 'aaa'], cwd, '\u0003')
    expect(cancelled.status).toBe(1)
    expect(cancelled.output).toContain('Remove migrations aaa?')
    expect(await Bun.file(file).exists()).toBe(true)
    const confirmed = await run(['migrate', 'remove', '--id', 'aaa'], cwd, 'yes\n')
    expect(confirmed.status).toBe(0)
    expect(confirmed.output).toContain('filePath')
    expect(await Bun.file(file).exists()).toBe(false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
