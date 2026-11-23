import type { StatementRange } from '../source/sql'

export async function postgresStatements(text: string): Promise<StatementRange[]> {
  const { parse } = await import('libpg-query')
  const parsed = await parse(text)
  const bytes = Buffer.from(text)
  return (parsed.stmts ?? []).map((statement) => {
    const offset = statement.stmt_location ?? 0
    const start = bytes.subarray(0, offset).toString().length
    const length = statement.stmt_len ?? 0
    return {
      start,
      end: length ? start + bytes.subarray(offset, offset + length).toString().length : text.length,
    }
  })
}
