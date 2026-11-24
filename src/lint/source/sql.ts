import type { LintGap, LintInput, LintNode, LintSource } from '../types'
import { postgresStatements } from '../postgresql/parser'
import { mysqlStatements } from '../mysql/parser'
import { sqliteStatements } from '../sqlite/parser'
import { extractStatement } from './statement'
import { sourceAt, tokenize } from './tokens'

export interface StatementRange {
  start: number
  end: number
}

const parse = { postgresql: postgresStatements, mysql: mysqlStatements, sqlite: sqliteStatements }

export async function parseSqlLintInput(
  sql: string,
  dialect: string | undefined,
  source: LintSource,
): Promise<LintInput> {
  if (!dialect || !Object.hasOwn(parse, dialect))
    return { nodes: [], gaps: [{ message: 'SQL analysis requires a supported dialect.', source }] }
  const nodes: LintNode[] = []
  const gaps: LintGap[] = []
  let slices: StatementRange[]
  try {
    slices = await parse[dialect as keyof typeof parse](sql)
  } catch (error) {
    return {
      nodes,
      gaps: [
        {
          message:
            'SQL parser could not analyze input: ' +
            (error instanceof Error ? error.message : String(error)),
          source,
        },
      ],
    }
  }
  for (const slice of slices) {
    const text = sql.slice(slice.start, slice.end)
    const input = extractStatement(
      text,
      tokenize(text, dialect),
      dialect,
      sourceAt(source, sql, slice.start),
    )
    nodes.push(...input.nodes)
    gaps.push(...input.gaps)
  }
  return { nodes, gaps, capabilities: ['sql-objects', 'sql-columns', 'sql-constraints'] }
}
