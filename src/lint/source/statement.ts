import type { LintInput, LintNode, LintSource, LintGap } from '../types'
import { tableDefinitions } from './definitions'
import { extractQueryCalls } from './query'
import {
  columnList,
  groups,
  identifier,
  keyword,
  position,
  sourceAt,
  words,
  type Token,
} from './tokens'

export function extractStatement(
  text: string,
  tokens: readonly Token[],
  dialect: string,
  source: LintSource,
): LintInput {
  const nodes: LintNode[] = []
  const gaps: LintGap[] = []
  const action = tokens[0]?.value.toLowerCase()
  const make = (
    kind: string,
    item: NonNullable<ReturnType<typeof identifier>>,
    values: Partial<LintNode> = {},
  ) => {
    const node: LintNode = {
      kind,
      name: item.name,
      dialect,
      schema: item.schema,
      identity: [item.schema, item.name].filter(Boolean).join('.'),
      source: sourceAt(source, text, item.token.start, item.token.end),
      origin: 'sql',
      spelling: item.token.text,
      quoted: item.token.quoted,
      action: action as LintNode['action'],
      ...values,
    }
    nodes.push(node)
    return node
  }
  const objectKinds = new Map([
    ['TABLE', 'table'],
    ['INDEX', 'index'],
    ['FUNCTION', 'function'],
    ['PROCEDURE', 'procedure'],
    ['VIEW', 'view'],
    ['TRIGGER', 'trigger'],
    ['EVENT', 'event'],
    ['SEQUENCE', 'sequence'],
    ['EXTENSION', 'extension'],
    ['SCHEMA', 'schema'],
    ['POLICY', 'policy'],
    ['TYPE', 'enum'],
  ])
  if (action === 'do') {
    make(
      'anonymous-block',
      { name: '<anonymous>', token: tokens[0]!, end: 1 },
      { action: 'create' },
    )
    gaps.push({ message: 'Anonymous block effects require manual review.', source })
    return { nodes, gaps }
  }
  if (action === 'call') {
    const target = identifier(tokens, 1)
    if (target) make('procedure', target, { action: 'call' })
    return { nodes, gaps }
  }
  if (!['create', 'alter', 'drop'].includes(action ?? '')) {
    extractQueryCalls(action, text, tokens, source, make, gaps)
    return { nodes, gaps }
  }
  const typeIndex = tokens.findIndex(
    (token) => !token.quoted && objectKinds.has(token.value.toUpperCase()),
  )
  if (typeIndex < 0)
    return {
      nodes,
      gaps: [{ message: 'SQL object operation is outside supported analysis.', source }],
    }
  const objectKind = tokens[typeIndex]!.value.toUpperCase()
  let nameIndex = typeIndex + 1
  if (objectKind === 'EVENT' && keyword(tokens[nameIndex], 'TRIGGER')) nameIndex++
  while (['IF', 'NOT', 'EXISTS', 'ONLY'].some((word) => keyword(tokens[nameIndex], word)))
    nameIndex++
  const item = identifier(tokens, nameIndex)
  if (!item)
    return { nodes, gaps: [{ message: 'SQL object identity could not be resolved.', source }] }
  let kind = objectKinds.get(objectKind)!
  if (kind === 'view' && position(tokens.slice(0, typeIndex), 'MATERIALIZED') >= 0)
    kind = 'materialized-view'
  if (kind === 'event' && keyword(tokens[typeIndex + 1], 'TRIGGER')) kind = 'event-trigger'
  const replaced = keyword(tokens[1], 'OR') && keyword(tokens[2], 'REPLACE')
  const node = make(kind, item, replaced ? { action: 'replace' } : {})
  if (kind === 'function' || kind === 'procedure') {
    const lang = position(tokens, 'LANGUAGE')
    const security = position(tokens, 'SECURITY')
    const path = position(tokens, 'SEARCH_PATH')
    const signature =
      tokens[item.end]?.value === '('
        ? groups(tokens, item.end)
            .map((argument) => words(argument))
            .join(',')
        : undefined
    Object.assign(node, {
      signature,
      identity: signature === undefined ? node.identity : node.identity + '(' + signature + ')',
      ...(lang < 0 ? {} : { language: tokens[lang + 1]?.value }),
      security:
        security < 0
          ? dialect === 'mysql'
            ? 'definer'
            : 'invoker'
          : tokens[security + 1]?.value.toLowerCase(),
      ...(path < 0
        ? action === 'create'
          ? { searchPath: [] }
          : {}
        : {
            searchPath: tokens
              .slice(path + 2)
              .filter((token) => token.value !== ',')
              .map((token) => token.value),
          }),
    })
    if (action !== 'drop')
      gaps.push({
        message: 'Routine body effects are outside static analysis.',
        source: node.source,
        identity: node.identity,
      })
  }
  if (kind === 'view' || kind === 'materialized-view') {
    const security = position(tokens, 'SECURITY')
    Object.assign(node, {
      security: security >= 0 ? tokens[security + 1]?.value.toLowerCase() : 'definer',
    })
    const invoker = position(tokens, 'SECURITY_INVOKER')
    if (invoker >= 0)
      Object.assign(node, {
        security: keyword(tokens[invoker + 2], 'TRUE') ? 'invoker' : 'definer',
      })
  }
  if (kind === 'policy') {
    const on = identifier(tokens, position(tokens, 'ON') + 1)
    const forIndex = position(tokens, 'FOR')
    const to = position(tokens, 'TO')
    const using = position(tokens, 'USING')
    const check = position(tokens, 'CHECK')
    const predicate = (index: number) => words(groups(tokens, index + 1).flat())
    const predicates: Partial<LintNode> = {}
    if (using >= 0) Object.assign(predicates, { using: predicate(using) })
    else if (action === 'create') Object.assign(predicates, { using: null })
    if (check >= 0) Object.assign(predicates, { check: predicate(check) })
    else if (action === 'create') Object.assign(predicates, { check: null })
    const endRoles = [using, check < 0 ? -1 : check - 1]
      .filter((index) => index > to)
      .sort((a, b) => a - b)[0]
    Object.assign(node, {
      table: on?.name,
      schema: on?.schema,
      ...(forIndex < 0 && action !== 'create'
        ? {}
        : { command: forIndex < 0 ? 'all' : tokens[forIndex + 1]?.value.toLowerCase() }),
      ...(to < 0 && action !== 'create'
        ? {}
        : {
            roles:
              to < 0
                ? ['public']
                : tokens
                    .slice(to + 1, endRoles)
                    .filter((token) => token.value !== ',')
                    .map((token) => token.value),
          }),
      ...predicates,
      permissive: position(tokens, 'RESTRICTIVE') < 0,
      identity: [on?.schema, on?.name, item.name].filter(Boolean).join('.'),
    })
  }
  if (kind === 'table') {
    const { extractTable, extractDefinition } = tableDefinitions(
      tokens,
      dialect,
      item,
      node,
      nodes,
      gaps,
      make,
    )
    if (action === 'create') extractTable()
    if (action === 'alter') {
      const row = position(tokens, 'ROW')
      if (row >= 0 && keyword(tokens[row + 1], 'LEVEL') && keyword(tokens[row + 2], 'SECURITY')) {
        const disabling = keyword(tokens[row - 1], 'DISABLE')
        const force = keyword(tokens[row - 1], 'FORCE')
        const noForce = force && keyword(tokens[row - 2], 'NO')
        make('rls', item, {
          table: item.name,
          action: noForce ? 'no-force' : force ? 'force' : disabling ? 'disable' : 'enable',
          ...(force ? { forced: !noForce } : { enabled: !disabling }),
        })
      } else {
        const add = position(tokens, 'ADD')
        if (add >= 0) {
          const definition = tokens
            .slice(add + 1)
            .filter((token, index) => index !== 0 || !keyword(token, 'COLUMN'))
          extractDefinition(definition)
        } else
          gaps.push({
            message: 'ALTER TABLE state changes require catalog or manual review.',
            source: node.source,
            identity: node.identity,
          })
      }
    }
  }
  if (kind === 'index') {
    const on = position(tokens, 'ON')
    const target = identifier(tokens, on + 1)
    Object.assign(node, {
      table: target?.name,
      schema: target?.schema,
      columns: columnList(tokens, target?.end ?? tokens.length),
      unique: position(tokens.slice(0, typeIndex), 'UNIQUE') >= 0,
      partial: position(tokens, 'WHERE') >= 0,
    })
  }
  return { nodes, gaps }
}
