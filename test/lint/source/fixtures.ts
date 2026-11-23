import { expect } from 'bun:test'
import type { LintInput } from '../../../src/lint/types'

export const source = { path: 'schema.sql', line: 1, column: 1 }

export function node(input: LintInput, kind: string, name?: string) {
  const result = input.nodes.find(
    (item) => item.kind === kind && (name === undefined || item.name === name),
  )
  expect(result).toBeDefined()
  return result!
}
