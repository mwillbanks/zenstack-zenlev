import type { StatementRange } from '../source/sql'

export async function mysqlStatements(text: string): Promise<StatementRange[]> {
  const { MySQL } = await import('dt-sql-parser')
  const parser = new MySQL()
  const errors = parser.validate(text)
  if (errors.length) throw new Error(errors.map((error) => error.message).join('\n'))
  return (parser.splitSQLByStatement(text) ?? []).map((slice) => ({
    start: slice.startIndex,
    end: slice.endIndex + 1,
  }))
}
