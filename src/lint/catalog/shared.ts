import type { Kysely, RawBuilder } from 'kysely'
import type { LintNode } from '../types'

export const columnCapabilities = [
  'column:type',
  'column:nullability',
  'column:default',
  'column:generated',
  'column:sequential',
] as const

export const keyCapabilities = [
  'primary-key:columns',
  'foreign-key:target',
  'index:columns',
] as const

export async function rows<T>(db: Kysely<any>, query: RawBuilder<T>): Promise<T[]> {
  return (await query.execute(db)).rows
}

export function identity(schema: string | undefined, ...names: string[]): string {
  return [...(schema ? [schema] : []), ...names].join('.')
}

export function grouped<T>(values: readonly T[], key: (value: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const name = key(value)
    const group = groups.get(name) ?? []
    group.push(value)
    groups.set(name, group)
  }
  return [...groups.values()]
}

export function node(
  dialect: string,
  kind: string,
  name: string,
  schema?: string,
  table?: string,
): LintNode {
  return {
    kind,
    name,
    dialect,
    origin: 'catalog',
    ...(schema === undefined ? {} : { schema }),
    ...(table === undefined ? {} : { table }),
    identity: identity(schema, ...(table === undefined ? [] : [table]), name),
  }
}
