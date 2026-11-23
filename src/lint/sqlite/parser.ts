import type { StatementRange } from '../source/sql'

export async function sqliteStatements(text: string): Promise<StatementRange[]> {
  const { parse } = await import('sqlite3-parser')
  const result = parse(text)
  if (result.status === 'error')
    throw new Error(result.errors.map(({ message }) => message).join('\n'))
  return result.root.cmds.map(({ span }) => ({
    start: span.offset,
    end: span.offset + span.length,
  }))
}
