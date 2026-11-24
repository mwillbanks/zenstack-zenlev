import type { LintGap, LintSource } from '../types'
import { identifier, keyword, sourceAt, type EmitNode, type Token } from './tokens'

export function extractQueryCalls(
  action: string | undefined,
  text: string,
  tokens: readonly Token[],
  source: LintSource,
  make: EmitNode,
  gaps: LintGap[],
): void {
  if (
    [
      'select',
      'insert',
      'update',
      'delete',
      'with',
      'merge',
      'replace',
      'values',
      'table',
    ].includes(action ?? '')
  ) {
    extractExpressionCalls(text, tokens, source, make, gaps, 1)
  }
}

export function extractExpressionCalls(
  text: string,
  tokens: readonly Token[],
  source: LintSource,
  make: EmitNode,
  gaps: LintGap[],
  start = 0,
): void {
  for (let index = start; index < tokens.length; index++) {
    const target = identifier(tokens, index)
    if (!target || !keyword(tokens[target.end], '(')) continue
    const previous = tokens[index - 1]
    if (
      previous?.value === ':' ||
      previous?.value === '.' ||
      ['AS', 'INTO', 'UPDATE', 'TABLE', 'REFERENCES'].some((word) => keyword(previous, word))
    )
      continue
    if (target.schema) make('function', target, { action: 'call' })
    else {
      const syntax = [
        'COUNT',
        'SUM',
        'AVG',
        'MIN',
        'MAX',
        'LOWER',
        'UPPER',
        'LENGTH',
        'ABS',
        'ROUND',
        'CAST',
        'EXTRACT',
        'COALESCE',
        'NULLIF',
        'GREATEST',
        'LEAST',
        'TRIM',
        'SUBSTRING',
        'POSITION',
        'OVERLAY',
        'NORMALIZE',
        'CONVERT',
        'TREAT',
        'IN',
        'ANY',
        'ALL',
        'SOME',
        'EXISTS',
        'VALUES',
        'ROW',
        'ARRAY',
        'OVER',
        'FILTER',
        'PARTITION',
        'GROUPING',
        'ROLLUP',
        'CUBE',
        'MATCH',
        'AGAINST',
        'SELECT',
        'WHERE',
        'HAVING',
        'ON',
        'AND',
        'OR',
        'NOT',
        'WHEN',
        'THEN',
        'ELSE',
        'WITH',
        'DISTINCT',
        'RETURNING',
        'SET',
        'CASE',
      ]
      const expressionStart =
        index === 0 ||
        ['(', ',', '=', '<', '>', '+', '-', '*', '/', '%', '|', '&', '!', '~'].includes(
          previous?.value ?? '',
        ) ||
        [
          'SELECT',
          'CASE',
          'DISTINCT',
          'WHERE',
          'HAVING',
          'ON',
          'WHEN',
          'THEN',
          'ELSE',
          'RETURNING',
          'AND',
          'OR',
          'NOT',
          'BY',
          'SET',
          'VALUES',
          'FROM',
          'JOIN',
        ].some((word) => keyword(previous, word))
      let close = target.end
      let depth = 0
      for (; close < tokens.length; close++) {
        if (keyword(tokens[close], '(')) depth++
        if (keyword(tokens[close], ')') && --depth === 0) break
      }
      if (
        expressionStart &&
        !syntax.some((word) => keyword(target.token, word)) &&
        !(
          keyword(tokens[close + 1], 'AS') &&
          (tokens[close + 2]?.value === '(' ||
            keyword(tokens[close + 2], 'MATERIALIZED') ||
            keyword(tokens[close + 2], 'NOT'))
        )
      )
        gaps.push({
          message:
            'Unqualified function call cannot be resolved without catalog search-path information.',
          source: sourceAt(source, text, target.token.start, target.token.end),
          identity: target.name,
        })
    }
    index = target.end - 1
  }
}
