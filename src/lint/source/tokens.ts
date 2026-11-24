import type { LintSource, LintNode } from '../types'

export interface Token {
  text: string
  value: string
  start: number
  end: number
  quoted: boolean
}
export function sourceAt(source: LintSource, text: string, start: number, end = start): LintSource {
  const before = text.slice(0, start).split('\n')
  const after = text.slice(0, end).split('\n')
  return {
    ...source,
    line: source.line + before.length - 1,
    column: before.length === 1 ? source.column + start : before.at(-1)!.length + 1,
    endLine: source.line + after.length - 1,
    endColumn: after.length === 1 ? source.column + end : after.at(-1)!.length + 1,
  }
}

export function tokenize(text: string, dialect: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const start = index
    const rest = text.slice(index)
    const ignored = /^(?:\s+|--[^\r\n]*)/.exec(rest)
    if (ignored) {
      index += ignored[0].length
      continue
    }
    if (rest.startsWith('/*')) {
      let depth = 1
      index += 2
      while (index < text.length && depth) {
        if (text.slice(index, index + 2) === '/*') {
          depth++
          index += 2
        } else if (text.slice(index, index + 2) === '*/') {
          depth--
          index += 2
        } else index++
      }
      continue
    }
    const dollar = /^\$(?:[a-z_]\w*)?\$/i.exec(rest)
    if (dollar) {
      const end = text.indexOf(dollar[0], index + dollar[0].length)
      index = end < 0 ? text.length : end + dollar[0].length
    } else if (["'", '"', String.fromCharCode(96), '['].includes(rest[0]!)) {
      const close = text[index] === '[' ? ']' : text[index]!
      index++
      while (index < text.length) {
        if (text[index] === close) {
          index++
          if (text[index] !== close) break
        }
        index++
      }
    } else {
      const word = /^[\p{L}_][\p{L}\p{N}_$]*|^\d+(?:\.\d+)?/u.exec(rest)
      index += word ? word[0].length : 1
    }
    const raw = text.slice(start, index)
    const quoted = ['"', String.fromCharCode(96), '['].includes(raw[0]!)
    const value = quoted
      ? raw.slice(1, -1).replace(/""|\x60\x60|\]\]/g, (pair) => pair[0]!)
      : dialect === 'postgresql'
        ? raw.toLowerCase()
        : raw
    tokens.push({ text: raw, value, start, end: index, quoted })
  }
  return tokens
}

export function words(tokens: readonly Token[]): string {
  return tokens.map((token) => token.text).join(' ')
}

export function keyword(token: Token | undefined, value: string): boolean {
  return token !== undefined && !token.quoted && token.value.toUpperCase() === value
}

export function position(tokens: readonly Token[], value: string): number {
  return tokens.findIndex((token) => keyword(token, value))
}

export function identifier(
  tokens: readonly Token[],
  start: number,
):
  | {
      name: string
      schema?: string
      token: Token
      end: number
    }
  | undefined {
  const first = tokens[start]
  if (!first || (!first.quoted && !/^[\p{L}_\p{N}]/u.test(first.text))) return
  if (keyword(tokens[start + 1], '.') && tokens[start + 2]) {
    return {
      name: tokens[start + 2]!.value,
      schema: first.value,
      token: tokens[start + 2]!,
      end: start + 3,
    }
  }
  return { name: first.value, token: first, end: start + 1 }
}

export function groups(tokens: readonly Token[], start: number): Token[][] {
  const result: Token[][] = []
  let depth = 0
  let group: Token[] = []
  for (const token of tokens.slice(start + 1)) {
    if (keyword(token, ')') && depth === 0) {
      if (group.length) result.push(group)
      break
    }
    if (keyword(token, ',') && depth === 0) {
      result.push(group)
      group = []
      continue
    }
    if (keyword(token, '(')) depth++
    if (keyword(token, ')')) depth--
    group.push(token)
  }
  return result
}

export function columnList(tokens: readonly Token[], start: number): string[] {
  const opening = tokens.findIndex((token, index) => index >= start && keyword(token, '('))
  return opening < 0
    ? []
    : groups(tokens, opening)
        .map((group) => group[0]?.value ?? '')
        .filter(Boolean)
}

/** Tokens outside expression groups, preserving their original offsets. */
export function topLevel(tokens: readonly Token[]): Token[] {
  let depth = 0
  return tokens.filter((token) => {
    if (keyword(token, ')')) depth--
    const outside = depth === 0
    if (keyword(token, '(')) depth++
    return outside
  })
}

/** Types whose database expansion supplies a sequence and implicit NOT NULL. */
export function serialType(type: string, dialect: string | undefined): boolean {
  if (dialect === 'postgresql')
    return /^(?:smallserial|serial|bigserial|serial2|serial4|serial8)$/i.test(type)
  return dialect === 'mysql' && /^serial$/i.test(type)
}

export function typeName(tokens: readonly Token[]): string {
  return words(tokens).replace(/\s*([(),.[\]])\s*/g, '$1')
}

export type EmitNode = (
  kind: string,
  item: NonNullable<ReturnType<typeof identifier>>,
  values?: Partial<LintNode>,
) => LintNode
