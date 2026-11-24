import { describe, expect, test } from 'bun:test'
import {
  buildGraph,
  dependentMigrationIds,
  planMigrations,
  resolveMigrationId,
  type RecordedMigration,
} from '../../src/migrate/graph'
import type { MigrationIdentity, MigrationMeta, MigrationStatus } from '../../src/types'

function migration(id: string, changes: Partial<MigrationIdentity> = {}): MigrationIdentity {
  return {
    id,
    name: id,
    namespace: 'default',
    createdAt: '2026-11-21T00:00:00.000Z',
    filePath: `/migrations/${id}_${id}.ts`,
    hash: `hash-${id}`,
    ...changes,
  }
}

function recorded(
  definition: MigrationMeta,
  status: MigrationStatus = 'applied',
  changes: Partial<RecordedMigration> = {},
): RecordedMigration {
  return { meta: definition, hash: `hash-${definition.id}`, status, ...changes }
}

function ids(plan: ReturnType<typeof planMigrations>): string[] {
  return plan.migrations.map((migration) => migration.id)
}

describe('effective dependency graph', () => {
  test('orders shuffled independent branches with lexical ties', () => {
    const local = [migration('c', { dependsOn: ['a', 'b', 'a'] }), migration('b'), migration('a')]
    const first = buildGraph(local)
    const second = buildGraph([...local].reverse(), [])
    expect(first.order).toEqual(['a', 'b', 'c'])
    expect(second.order).toEqual(first.order)
    expect(first.nodes.get('c')?.dependencies).toEqual(['a', 'b'])
    expect(first.nodes.get('a')?.dependents).toEqual(['c'])
    expect(dependentMigrationIds(first, 'a')).toEqual(['c'])
    expect(resolveMigrationId(first, 'b')).toBe('b')
  })

  test('supports an empty graph', () => {
    expect(buildGraph([]).order).toEqual([])
    expect(planMigrations(buildGraph([]))).toEqual({
      migrations: [],
      namespaces: [],
      warnings: [],
      transactional: true,
      blockers: [],
    })
  })

  test('rejects duplicate definitions and stored records', () => {
    const a = migration('a')
    expect(() => buildGraph([a, a])).toThrow('Duplicate migration')
    expect(() => buildGraph([], [recorded(a), recorded(a)])).toThrow('Duplicate history')
  })

  test.each([
    { id: '' },
    { name: '' },
    { namespace: '' },
    { createdAt: 'invalid' },
    { dependsOn: ['a'] },
    { supersedes: ['a'] },
  ])('rejects malformed metadata %j', (changes) => {
    expect(() => buildGraph([migration('a', changes)])).toThrow()
  })

  test.each([
    { dependsOn: ['missing'] },
    { supersedes: ['missing'] },
    { rollback: { mode: 'compensate' as const, target: 'missing', reversals: [] } },
  ])('rejects unknown references %j', (changes) => {
    expect(() => buildGraph([migration('a', changes)])).toThrow('references missing migration')
  })

  test('rejects dependency and supersedes cycles', () => {
    expect(() =>
      buildGraph([migration('a', { dependsOn: ['b'] }), migration('b', { dependsOn: ['a'] })]),
    ).toThrow('dependency graph contains a cycle')
    expect(() =>
      buildGraph([migration('a', { supersedes: ['b'] }), migration('b', { supersedes: ['a'] })]),
    ).toThrow('Supersedes cycle')
  })

  test('protects baseline history and checks the destination dialect', () => {
    const root = migration('old')
    const baseline = migration('base', {
      supersedes: ['old'],
      baseline: {
        dialect: 'sqlite',
        history: [{ id: 'old', expected: { status: 'applied', hash: root.hash } }],
      },
    })
    const graph = buildGraph([baseline])
    expect(resolveMigrationId(graph, 'old')).toBe('base')
    expect(planMigrations(graph, {}, true, 'mysql').blockers).toMatchObject([
      { migrationId: 'base', code: 'BASELINE_HISTORY', message: expect.stringContaining('sqlite') },
    ])
    const split = migration('other', {
      supersedes: ['old'],
      createdAt: '2026-11-21T01:00:00.000Z',
    })
    expect(() => buildGraph([baseline, split])).toThrow('cannot split baseline')
    const replace = migration('other', { supersedes: ['base'] })
    expect(() => buildGraph([baseline, replace])).toThrow('Only another baseline')
  })

  test('rewrites replacements transitively without mutating stored history', () => {
    const a = migration('a')
    const b = migration('b', { supersedes: ['a'], dependsOn: ['a'] })
    const c = migration('c', {
      supersedes: ['b'],
      createdAt: '2026-11-21T01:00:00.000Z',
    })
    const child = migration('child', { dependsOn: ['a'] })
    const record = recorded(a)
    const graph = buildGraph([child, b, c], [record])
    expect(graph.order).toEqual(['c', 'child'])
    expect(graph.nodes.get('child')?.dependencies).toEqual(['c'])
    expect(graph.nodes.get('a')?.record).toBe(record)
    expect(graph.nodes.get('a')?.status).toBe('applied')
    expect(graph.nodes.get('a')?.supersededBy).toBe('c')
    expect(resolveMigrationId(graph, 'a')).toBe('c')
    expect(dependentMigrationIds(graph, 'a')).toEqual(['child'])
    expect(ids(planMigrations(graph))).toEqual(['c', 'child'])
    expect(record.meta.supersedes).toBeUndefined()
  })

  test('selects the newest replacement, using lexical ID for timestamp ties', () => {
    const a = migration('a')
    const b = migration('b', { supersedes: ['a'], createdAt: '2026-11-21T02:00:00Z' })
    const c = migration('c', { supersedes: ['a'], createdAt: '2026-11-21T01:00:00Z' })
    const d = migration('d', { supersedes: ['a'], createdAt: '2026-11-21T02:00:00Z' })
    expect(resolveMigrationId(buildGraph([d, c, b, a]), 'a')).toBe('d')
    expect(resolveMigrationId(buildGraph([a, b, c, d]), 'a')).toBe('d')
  })

  test('rejects a cycle introduced by rewriting a replacement dependency', () => {
    expect(() =>
      buildGraph([migration('a'), migration('b', { supersedes: ['a'], dependsOn: ['a'] })]),
    ).toThrow('dependency graph contains a cycle')
  })

  test('keeps rollback reversals as history without requiring application first', () => {
    const a = migration('a')
    const rollback = migration('r', {
      supersedes: ['a'],
      rollback: { mode: 'compensate', target: 'a', reversals: ['a'] },
    })
    expect(ids(planMigrations(buildGraph([a, rollback])))).toEqual(['r'])
    expect(ids(planMigrations(buildGraph([rollback], [recorded(a)])))).toEqual(['r'])
  })

  test('rejects unknown selection IDs', () => {
    const graph = buildGraph([migration('a')])
    expect(() => resolveMigrationId(graph, 'missing')).toThrow('Unknown migration')
    expect(() => planMigrations(graph, { from: 'missing' })).toThrow('Unknown migration')
    expect(() => planMigrations(graph, { to: 'missing' })).toThrow('Unknown migration')
    expect(() => planMigrations(graph, { only: ['missing'] })).toThrow('Unknown migration')
  })
})

describe('migration plan selection and integrity', () => {
  const a = migration('a', { namespace: 'pre', tags: ['schema'] })
  const b = migration('b', { dependsOn: ['a'], namespace: 'deploy', tags: ['schema', 'data'] })
  const c = migration('c', { dependsOn: ['b'], namespace: 'post', tags: ['data'] })
  const d = migration('d', { namespace: 'deploy' })

  test('intersects graph bounds, namespace, tags, and explicit IDs', () => {
    const graph = buildGraph([d, c, b, a], [recorded(a)])
    const plan = planMigrations(graph, {
      from: 'a',
      to: 'c',
      namespace: ['deploy', 'post'],
      tags: ['schema'],
      only: ['b', 'c', 'd'],
    })
    expect(ids(plan)).toEqual(['b'])
    expect(plan.namespaces).toEqual(['deploy'])
    expect(plan.blockers).toEqual([])
  })

  test('does not implicitly include pending prerequisites from other namespaces', () => {
    const plan = planMigrations(buildGraph([a, b, c]), { namespace: ['post'] })
    expect(ids(plan)).toEqual(['c'])
    expect(plan.blockers).toEqual([
      {
        migrationId: 'c',
        code: 'PENDING_PREREQUISITE',
        message: 'Migration c requires pending migration b outside the selected scope',
      },
    ])
  })

  test('respects inclusive bounds and empty selections', () => {
    const graph = buildGraph([a, b, c, d])
    expect(ids(planMigrations(graph, { from: 'b', to: 'c' }))).toEqual(['b', 'c'])
    expect(ids(planMigrations(graph, { only: [] }))).toEqual([])
    expect(ids(planMigrations(graph, { tags: [] }))).toEqual([])
    expect(ids(planMigrations(graph, { namespace: [] }))).toEqual([])
    expect(ids(planMigrations(graph, { from: 'c', to: 'a' }))).toEqual([])
  })

  test('honors store-only applied dependencies', () => {
    const graph = buildGraph([b], [recorded(a)])
    expect(ids(planMigrations(graph))).toEqual(['b'])
    expect(planMigrations(graph).blockers).toEqual([])
    expect(graph.nodes.get('a')?.local).toBeUndefined()
  })

  test('blocks store-only pending definitions', () => {
    const plan = planMigrations(buildGraph([], [recorded(a, 'pending')]))
    expect(plan.migrations).toEqual([])
    expect(plan.blockers[0]?.message).toContain('no local executable definition')
  })

  test('checks hash integrity on relevant applied dependencies', () => {
    const changed = { ...a, hash: 'changed' }
    const graph = buildGraph([changed, b, d], [recorded(a)])
    expect(planMigrations(graph, { only: ['b'] }).blockers.map((item) => item.code)).toEqual([
      'HASH_MISMATCH',
    ])
    expect(planMigrations(graph, { only: ['d'] }).blockers).toEqual([])
  })

  test('permits resolved hashes and does not schedule applied or rolled-back entries', () => {
    const changed = { ...a, hash: 'accepted' }
    const graph = buildGraph(
      [changed, b, c],
      [recorded(a, 'applied', { acceptedHashes: ['accepted'] }), recorded(b, 'rolled_back')],
    )
    const plan = planMigrations(graph, { only: ['a', 'b'] })
    expect(plan.migrations).toEqual([])
    expect(plan.blockers).toEqual([])
    expect(planMigrations(graph, { only: ['c'] }).blockers[0]?.code).toBe('PENDING_PREREQUISITE')
  })

  test.each(['failed', 'applying'] as const)('blocks unresolved %s attempts', (status) => {
    const plan = planMigrations(buildGraph([a], [recorded(a, status)]))
    expect(plan.blockers[0]?.code).toBe('UNRESOLVED_ATTEMPT')
    expect(ids(plan)).toEqual(['a'])
  })

  test('allows an explicitly recovered retry and blocks explicit unresolved flags', () => {
    expect(
      planMigrations(buildGraph([a], [recorded(a, 'failed', { unresolvedAttempt: false })]))
        .blockers,
    ).toEqual([])
    expect(
      planMigrations(buildGraph([a], [recorded(a, 'pending', { unresolvedAttempt: true })]))
        .blockers[0]?.code,
    ).toBe('UNRESOLVED_ATTEMPT')
  })

  test('does not hide an unresolved attempt behind a superseding migration', () => {
    const replacement = migration('r', { supersedes: ['a'] })
    const graph = buildGraph([replacement], [recorded(a, 'applying')])
    expect(planMigrations(graph, { only: ['r'] }).blockers[0]?.code).toBe('UNRESOLVED_ATTEMPT')
  })

  test('validates execution options and reports reduced transaction safety', () => {
    const graph = buildGraph([
      migration('a', { warnings: [{ code: 'DROP_TABLE', message: 'Drop example' }] }),
    ])
    expect(() => planMigrations(graph, { continueOnFailure: true })).toThrow(
      '--continue-on-failure requires --no-transaction',
    )
    const plan = planMigrations(graph, { continueOnFailure: true, noTransaction: true })
    expect(plan.transactional).toBe(false)
    expect(plan.warnings.map((warning) => warning.code)).toEqual([
      'DROP_TABLE',
      'REDUCED_TRANSACTION_SAFETY',
    ])
    expect(planMigrations(graph, { continueOnFailure: true }, false).transactional).toBe(false)
    expect(planMigrations(buildGraph([]), {}, false).warnings).toEqual([])
  })
})
