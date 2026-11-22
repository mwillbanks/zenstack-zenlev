import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import * as readline from 'node:readline/promises'
import * as tuil from '@mwillbanks/tuil'
import { parseCli, runCli, type CliDependencies } from '../src/cli'
import { renderTerminal } from '../src/cli-render'
import type { Zenlev } from '../src/engine'

beforeEach(() => {
  setSystemTime(new Date('2026-11-21T00:00:00Z'))
  spyOn(performance, 'now').mockReturnValue(0)
})
afterEach(() => {
  mock.restore()
  setSystemTime()
})

function harness(result: unknown = { status: 'ok' }) {
  const calls: { method: string; options: unknown }[] = []
  const call = (method: string) =>
    mock(async (options: unknown) => {
      calls.push({ method, options })
      return result
    })
  const close = mock(async () => {})
  const client = {
    environment: { name: 'test', cwd: '/project' },
    close,
    db: { push: call('push') },
    migrate: Object.fromEntries(
      [
        'create',
        'apply',
        'rollback',
        'status',
        'tree',
        'remove',
        'reshape',
        'resolve',
        'recover',
      ].map((name) => [name, call(name)]),
    ),
  } as unknown as Zenlev
  const create = mock(async () => client)
  const output: string[] = []
  const errors: string[] = []
  const dependencies: CliDependencies = {
    create,
    stdout: (text) => {
      output.push(text)
    },
    stderr: (text) => {
      errors.push(text)
    },
    tty: false,
  }
  return { calls, client, create, close, output, errors, dependencies }
}

describe('CLI argument parsing', () => {
  test('maps every global override without injecting defaults', () => {
    const parsed = parseCli([
      '--config',
      'custom.ts',
      '--cwd',
      '/project',
      '--env',
      'production',
      '--schema',
      'data.zmodel',
      '--migrations-dir',
      'changes',
      '--json',
      '--store-location',
      'schema',
      '--store-schema-name',
      'history',
      '--store-database-name',
      'database',
      '--store-table-name',
      'entries',
      '--store-lock-table-name',
      'lock',
      '--hash-algorithm',
      'sha512',
      '--hash-normalize-line-endings',
      '--otel',
      '--otel-service-name',
      'migration',
      '--otel-exporter',
      'otlp',
      '--otel-otlp-endpoint',
      'http://localhost:4318',
      'migrate',
      'status',
    ])
    expect(parsed.configPath).toBe('custom.ts')
    expect(parsed.json).toBe(true)
    expect(parsed.config).toEqual({
      cwd: '/project',
      env: 'production',
      schema: 'data.zmodel',
      migrationsDir: 'changes',
      store: {
        location: 'schema',
        schemaName: 'history',
        databaseName: 'database',
        tableName: 'entries',
        lockTableName: 'lock',
      },
      hashing: { algorithm: 'sha512', normalizeLineEndings: true },
      telemetry: {
        opentelemetry: {
          enabled: true,
          serviceName: 'migration',
          exporter: 'otlp',
          otlpEndpoint: 'http://localhost:4318',
        },
      },
    })
    expect(parseCli(['migrate', 'status']).config).toEqual({})
  })

  test('handles command-dependent format and list flags', () => {
    expect(
      parseCli([
        '--config',
        'tree',
        'migrate',
        'tree',
        '--format=mermaid',
        '--namespace',
        'pre,post',
        '--show-supersedes',
      ]).options,
    ).toEqual({ format: 'mermaid', namespace: ['pre', 'post'], showSupersedes: true })
    expect(
      parseCli([
        'migrate',
        'create',
        '--name',
        'example',
        '--namespace',
        'pre',
        '--depends-on',
        'aaa,bbb,aaa',
        '--supersedes',
        'ccc',
        '--format',
      ]).options,
    ).toEqual({
      name: 'example',
      namespace: 'pre',
      dependsOn: ['aaa', 'bbb'],
      supersedes: ['ccc'],
      format: true,
    })
    expect(parseCli(['migrate', 'remove', '--id', 'aaa,bbb', '--all']).options).toEqual({
      id: ['aaa', 'bbb'],
      all: true,
    })
    expect(parseCli(['migrate', 'rollback', '--id', 'aaa', '--cascade']).options.mode).toBe(
      'cascade',
    )
    expect(parseCli(['migrate', 'rollback', '--id', 'aaa', '--compensate']).options.mode).toBe(
      'compensate',
    )
  })

  test('maps apply selection and safety controls', () => {
    expect(
      parseCli([
        'migrate',
        'apply',
        '--namespace',
        'pre,post',
        '--only',
        'aaa,bbb',
        '--tags',
        'seed,data',
        '--from',
        'aaa',
        '--to',
        'bbb',
        '--dry-run',
        '--plan-only',
        '--no-transaction',
        '--continue-on-failure',
      ]).options,
    ).toEqual({
      namespace: ['pre', 'post'],
      only: ['aaa', 'bbb'],
      tags: ['seed', 'data'],
      from: 'aaa',
      to: 'bbb',
      dryRun: true,
      planOnly: true,
      noTransaction: true,
      continueOnFailure: true,
    })
  })

  test('maps db push and schema-based creation controls', () => {
    expect(
      parseCli([
        'db',
        'push',
        '--dry-run',
        '--sql',
        '--create-migration',
        '--name',
        'example',
        '--format',
        '--exclude-views',
        '--namespace',
        'pre',
        '--drop-missing-tables=skip',
      ]).options,
    ).toEqual({
      dryRun: true,
      sql: true,
      createMigration: true,
      name: 'example',
      format: true,
      excludeViews: true,
      namespace: 'pre',
      dropMissingTables: 'skip',
    })
    expect(
      parseCli([
        'migrate',
        'create',
        '--name',
        'example',
        '--empty',
        '--from-schema',
        'old.zmodel',
        '--to-db',
        '--drop-missing-tables',
        'apply',
      ]).options,
    ).toEqual({
      name: 'example',
      empty: true,
      fromSchema: 'old.zmodel',
      toDb: true,
      dropMissingTables: 'apply',
    })
  })

  test.each([
    ['migrate', 'status', '--mismatched-only', '--show-resolved'],
    [
      'migrate',
      'reshape',
      '--id',
      'aaa',
      '--accept',
      'abc',
      '--reason',
      'reviewed',
      '--actor',
      'operator',
    ],
    [
      'migrate',
      'resolve',
      '--id',
      'aaa',
      '--hash',
      'abc',
      '--reason',
      'reviewed',
      '--actor',
      'operator',
    ],
    [
      'migrate',
      'recover',
      '--action',
      'release-lock',
      '--owner',
      'owner',
      '--actor',
      'operator',
      '--reason',
      'reviewed',
      '--evidence',
      'stopped',
    ],
    [
      'migrate',
      'recover',
      '--action',
      'retry',
      '--id',
      'aaa',
      '--attempt-id',
      'attempt',
      '--actor',
      'operator',
      '--reason',
      'reviewed',
      '--evidence',
      'reconciled',
    ],
  ])('accepts inspection and recovery arguments %#', (...args: unknown[]) => {
    expect(
      parseCli(args.filter((arg): arg is string => typeof arg === 'string')).command,
    ).toBeDefined()
  })

  test.each([
    ['db', 'pull'],
    ['unknown'],
    ['constructor'],
    ['migrate', 'status', '--unexpected'],
    ['migrate', 'apply', '--only', 'aaa,'],
    ['migrate', 'create'],
    ['migrate', 'resolve'],
    ['migrate', 'rollback', '--id', 'aaa'],
    ['migrate', 'rollback', '--id', 'aaa', '--cascade', '--compensate'],
    ['migrate', 'tree', '--format', 'json'],
    ['db', 'push', '--drop-missing-tables', 'maybe'],
    ['migrate', 'status', '--hash-algorithm', 'invalid'],
    ['migrate', 'status', '--store-location', 'invalid'],
    ['migrate', 'status', '--otel-exporter', 'invalid'],
    [
      'migrate',
      'recover',
      '--action',
      'retry',
      '--actor',
      'operator',
      '--reason',
      'x',
      '--evidence',
      'x',
    ],
    [
      'migrate',
      'recover',
      '--action',
      'invalid',
      '--actor',
      'operator',
      '--reason',
      'x',
      '--evidence',
      'x',
    ],
  ])('rejects malformed arguments %#', (...args: unknown[]) => {
    expect(() => parseCli(args.filter((arg): arg is string => typeof arg === 'string'))).toThrow()
  })
})

describe('CLI invocation and output', () => {
  test.each([false, true])(
    'emits warnings before work without polluting JSON: %s',
    async (json) => {
      const h = harness()
      await runCli(['migrate', 'apply', ...(json ? ['--json'] : [])], {
        ...h.dependencies,
        create: async (config) => {
          config.onWarning?.({ code: 'DROP_TABLE', message: 'Drops a table' })
          expect(h.errors).toEqual(json ? [] : ['Warning [DROP_TABLE] Drops a table\n'])
          return h.client
        },
      })
      expect(h.close).toHaveBeenCalledTimes(1)
    },
  )

  test.each(['--help', '--version'])('keeps %s machine output structured', async (flag) => {
    const h = harness()
    expect(await runCli([flag, '--json'], h.dependencies)).toBe(0)
    expect(JSON.parse(h.output[0]!)).toMatchObject({ status: 'ok' })
    expect(h.create).not.toHaveBeenCalled()
  })

  test.each([[], ['--help'], ['-h'], ['--version'], ['-V'], ['migrate', 'rollback', '--help']])(
    'shows help or version without initialization %#',
    async (...args: string[]) => {
      const h = harness()
      expect(await runCli(args, h.dependencies)).toBe(0)
      expect(h.create).not.toHaveBeenCalled()
      expect(h.output).toHaveLength(1)
    },
  )

  test.each([
    { args: ['db', 'push'], method: 'push' },
    { args: ['migrate', 'create', '--name', 'example'], method: 'create' },
    { args: ['migrate', 'apply'], method: 'apply' },
    { args: ['migrate', 'rollback', '--id', 'aaa', '--cascade'], method: 'rollback' },
    { args: ['migrate', 'status'], method: 'status' },
    { args: ['migrate', 'tree'], method: 'tree' },
    { args: ['migrate', 'remove', '--all', '--force'], method: 'remove' },
    { args: ['migrate', 'reshape', '--id', 'aaa', '--drop', 'abc'], method: 'reshape' },
    { args: ['migrate', 'resolve', '--id', 'aaa'], method: 'resolve' },
    {
      args: [
        'migrate',
        'recover',
        '--action',
        'applied',
        '--id',
        'aaa',
        '--attempt-id',
        'attempt',
        '--actor',
        'operator',
        '--reason',
        'reviewed',
        '--evidence',
        'reconciled',
      ],
      method: 'recover',
    },
  ])('dispatches $method and closes the client', async ({ args, method }) => {
    const h = harness()
    expect(await runCli(args, h.dependencies)).toBe(0)
    expect(h.calls[0]?.method).toBe(method)
    expect(h.close).toHaveBeenCalledTimes(1)
    expect(h.output).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test('emits one JSON envelope and bypasses all terminal work', async () => {
    const h = harness({ rows: [1] })
    const render = mock(async () => {})
    const ask = mock(() => true)
    expect(
      await runCli(['db', 'push', '--json'], {
        ...h.dependencies,
        tty: true,
        render,
        confirm: ask,
      }),
    ).toBe(0)
    expect(h.output).toHaveLength(1)
    expect(JSON.parse(h.output[0]!)).toEqual({ status: 'ok', result: { rows: [1] } })
    expect(h.calls[0]?.options).toEqual({})
    expect(render).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  test.each([{ status: 'failed' }, { status: 'partial' }, { plan: { blockers: ['missing'] } }])(
    'returns failure for failed results and plan blockers %#',
    async (result) => {
      const h = harness(result)
      expect(await runCli(['migrate', 'apply', '--json'], h.dependencies)).toBe(1)
      expect(JSON.parse(h.output[0]!).status).toBe('error')
    },
  )

  test('prints schema SQL without terminal frames and returns failure for blocked changes', async () => {
    const result = {
      status: 'planned',
      changes: {
        blockers: [{ message: 'Rewrite manually' }],
        missingTables: [
          { id: 'public.old', referencedBy: ['public.retained'] },
          { id: 'spare', referencedBy: [] },
        ],
        warnings: [{ message: 'Review manual changes' }],
        operations: [{ up: [{ sql: 'CREATE TABLE example (id INTEGER)' }] }],
      },
    }
    const h = harness(result)
    const render = mock(async () => {})
    expect(await runCli(['db', 'push', '--sql'], { ...h.dependencies, render, tty: true })).toBe(1)
    expect(render).not.toHaveBeenCalled()
    expect(h.output[0]).toContain('-- Drop candidate · public.old (referenced by public.retained)')
    expect(h.output[0]).toEndWith('CREATE TABLE example (id INTEGER);\n')
    const blocked = harness({ ...result, status: 'blocked', error: 'Schema changed' })
    expect(await runCli(['db', 'push'], blocked.dependencies)).toBe(1)
    expect(blocked.output[0]).toContain('Schema changed')
    expect(blocked.output[0]).toContain('Blocked · Rewrite manually')
  })

  test('prints status lines and migration plans in plain text', async () => {
    const noRows = harness([])
    expect(await runCli(['migrate', 'status'], noRows.dependencies)).toBe(0)
    expect(noRows.output[0]).toBe('No matching migrations.\n')
    const status = harness([{ status: 'applied', namespace: 'predeploy', id: 'abc', name: 'init' }])
    expect(await runCli(['migrate', 'status'], status.dependencies)).toBe(0)
    expect(status.output[0]).toBe('applied · predeploy · abc · init\n')
    const plan = {
      migrations: [{ id: 'abc', name: 'init' }],
      blockers: [],
      warnings: [{ message: 'Review changes' }],
    }
    const planned = harness({ status: 'planned', plan })
    expect(await runCli(['migrate', 'apply', '--plan-only'], planned.dependencies)).toBe(0)
    expect(planned.output[0]).toContain('abc · init')
    expect(planned.output[0]).toContain('Warning · Review changes')
    const blocked = harness({
      status: 'planned',
      plan: { ...plan, blockers: [{ message: 'A prerequisite is pending' }] },
    })
    expect(await runCli(['migrate', 'apply', '--plan-only'], blocked.dependencies)).toBe(1)
    expect(blocked.output[0]).toContain('Blocked · A prerequisite is pending')
    const applied = harness({ status: 'ok', plan, migrations: [{ id: 'abc', status: 'applied' }] })
    expect(await runCli(['migrate', 'apply'], applied.dependencies)).toBe(0)
    expect(applied.output[0]).toContain('applied · abc')
  })

  test('prints tree strings and void command results', async () => {
    const h = harness('migration tree')
    await runCli(['migrate', 'tree'], h.dependencies)
    expect(h.output).toEqual(['migration tree\n'])
    const empty = harness()
    empty.client.migrate.recover = mock(async () => {})
    await runCli(
      [
        'migrate',
        'recover',
        '--action',
        'release-lock',
        '--owner',
        'owner',
        '--actor',
        'operator',
        '--reason',
        'reviewed',
        '--evidence',
        'stopped',
      ],
      empty.dependencies,
    )
    expect(empty.output).toEqual(['Completed.\n'])
  })

  test('offers per-table and removal confirmations on a TTY', async () => {
    const h = harness()
    const ask = mock((question: string) => (question.includes('keep') ? false : true))
    const render = mock(async (text: string, write: (text: string) => void | Promise<void>) => {
      await write(text)
    })
    await runCli(['db', 'push'], { ...h.dependencies, tty: true, render, confirm: ask })
    const options = h.calls[0]!.options as { confirmDrops: (tables: string[]) => Promise<string[]> }
    expect(await options.confirmDrops(['drop_me', 'keep_me'])).toEqual(['drop_me'])
    await runCli(['migrate', 'remove', '--all'], {
      ...h.dependencies,
      tty: true,
      render,
      confirm: ask,
    })
    const remove = h.calls[1]!.options as { confirm: (items: { id: string }[]) => boolean }
    expect(await remove.confirm([{ id: 'aaa' }])).toBe(true)
    expect(render).toHaveBeenCalledTimes(2)
  })

  test('uses and closes the native confirmation interface', async () => {
    const close = mock(() => {})
    const question = mock(async () => 'YES')
    const once = mock((_event: string, _listener: () => void) => {})
    spyOn(readline, 'createInterface').mockReturnValue({
      question,
      close,
      once,
    } as unknown as ReturnType<typeof readline.createInterface>)
    const h = harness()
    await runCli(['migrate', 'remove', '--all'], {
      ...h.dependencies,
      tty: true,
      render: async () => {},
    })
    const options = h.calls[0]!.options as {
      confirm: (items: { id: string }[]) => Promise<boolean>
    }
    expect(await options.confirm([{ id: 'aaa' }])).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    once.mock.calls[0]![1]()
  })

  test('serializes argument errors even before parsing completes', async () => {
    const h = harness()
    expect(await runCli(['bad', '--json'], h.dependencies)).toBe(1)
    expect(JSON.parse(h.output[0]!).error.message).toContain('Unknown command')
    expect(h.create).not.toHaveBeenCalled()
  })

  test('closes clients after command errors and reports cleanup failures', async () => {
    const h = harness()
    h.client.migrate.status = mock(async () => {
      throw new Error('command failed')
    })
    h.client.close = mock(async () => {
      throw 'close failed'
    })
    expect(await runCli(['migrate', 'status'], h.dependencies)).toBe(1)
    expect(h.errors[0]).toContain('command failed; cleanup failed: close failed')
    const json = harness()
    json.client.migrate.status = mock(async () => {
      throw 'raw failure'
    })
    expect(await runCli(['migrate', 'status', '--json'], json.dependencies)).toBe(1)
    expect(JSON.parse(json.output[0]!).error.message).toBe('raw failure')
    expect(json.close).toHaveBeenCalledTimes(1)
  })

  test('reports initialization and closing failures', async () => {
    const h = harness()
    expect(
      await runCli(['migrate', 'status'], {
        ...h.dependencies,
        create: async () => {
          throw new Error('initialization failed')
        },
      }),
    ).toBe(1)
    expect(h.errors[0]).toContain('initialization failed')
    const closing = harness()
    closing.client.close = mock(async () => {
      throw new Error('close failed')
    })
    expect(await runCli(['migrate', 'status'], closing.dependencies)).toBe(1)
    expect(closing.output).toEqual([])
    expect(closing.errors[0]).toContain('close failed')
  })

  test('uses process streams for default output', async () => {
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true)
    const errors = spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await runCli(['--version'])).toBe(0)
    expect(await runCli(['bad'])).toBe(1)
    expect(output).toHaveBeenCalled()
    expect(errors).toHaveBeenCalled()
  })

  test('lazily renders real TTY results with the cell backend', async () => {
    const h = harness('ready')
    expect(await runCli(['migrate', 'tree'], { ...h.dependencies, tty: true })).toBe(0)
    expect(h.output.join('')).toContain('ready')
  })
})

describe('terminal rendering', () => {
  test('uses a silent host component and stops the application after writing', async () => {
    const create = tuil.createApp
    let stopped = false
    spyOn(tuil, 'createApp').mockImplementation((options) => {
      expect((options.component as () => null)()).toBeNull()
      const app = create(options)
      const stop = app.stop.bind(app)
      app.stop = async () => {
        await stop()
        stopped = true
      }
      return app
    })
    await renderTerminal('ready', () => {
      expect(stopped).toBe(false)
    })
    expect(stopped).toBe(true)
  })

  test('preserves Unicode and multiple rows through cell encoding', async () => {
    const output: string[] = []
    await renderTerminal('Zenlev\n迁移 👩‍💻', (text) => {
      output.push(text)
    })
    expect(output.join('')).toContain('Zenlev\n迁移 👩‍💻')
  })

  test('restores the runtime when output fails', async () => {
    await expect(
      renderTerminal('', () => {
        throw new Error('output failed')
      }),
    ).rejects.toThrow('output failed')
  })
})
