import type { LintGap, LintNode } from '../types'
import {
  columnList,
  groups,
  identifier,
  keyword,
  position,
  words,
  type Token,
  type EmitNode,
} from './tokens'

export function tableDefinitions(
  tokens: readonly Token[],
  dialect: string,
  item: NonNullable<ReturnType<typeof identifier>>,
  node: LintNode,
  nodes: readonly LintNode[],
  gaps: LintGap[],
  make: EmitNode,
) {
  function extractTable() {
    const opening = tokens.findIndex((token, index) => index >= item.end && token.value === '(')
    if (opening < 0) {
      gaps.push({
        message: 'CREATE TABLE AS or inherited columns require catalog inspection.',
        source: node.source,
        identity: node.identity,
      })
      return
    }
    const definitions = groups(tokens, opening)
    for (const definition of definitions) extractDefinition(definition)
    const pk = nodes.find((candidate) => candidate.kind === 'primary-key')
    if (
      dialect === 'sqlite' &&
      pk?.columns?.length === 1 &&
      !/\bWITHOUT\s+ROWID\b/i.test(words(tokens))
    ) {
      const column = nodes.find(
        (candidate) => candidate.kind === 'column' && candidate.name === pk.columns![0],
      )
      const definition = definitions.find((part) => part[0]?.value === column?.name)
      if (
        column?.type?.toLowerCase() === 'integer' &&
        !/\bPRIMARY\s+KEY\s+DESC\b/i.test(words(definition ?? []))
      )
        Object.assign(column, { sequential: true })
    }
  }

  function extractDefinition(definition: readonly Token[]) {
    let current = 0
    let constraint: Token | undefined
    if (keyword(definition[0], 'CONSTRAINT')) {
      constraint = definition[1]
      current = 2
    }
    const first = definition[current]
    if (!first) return
    const constraintKind = new Map([
      ['PRIMARY', 'primary-key'],
      ['FOREIGN', 'foreign-key'],
      ['UNIQUE', 'unique'],
      ['CHECK', 'check'],
    ]).get(first.value.toUpperCase())
    if (constraintKind && !first.quoted) {
      const name = constraint?.value ?? ''
      const result = make(
        constraintKind,
        { name, token: constraint ?? first, end: 0 },
        {
          table: item.name,
          schema: item.schema,
          columns: columnList(definition, current),
          generated: constraint === undefined,
          identity: [item.schema, item.name, name || constraintKind].filter(Boolean).join('.'),
        },
      )
      const ref = position(definition, 'REFERENCES')
      if (ref >= 0) {
        const target = identifier(definition, ref + 1)
        Object.assign(result, {
          targetTable: target?.name,
          targetSchema: target?.schema,
          targetColumns: columnList(definition, target?.end ?? definition.length),
        })
      }
      return
    }
    const column = identifier(definition, current)
    if (!column) return
    const boundary = definition.findIndex(
      (token, index) =>
        index > current &&
        [
          'PRIMARY',
          'NOT',
          'NULL',
          'DEFAULT',
          'CONSTRAINT',
          'UNIQUE',
          'REFERENCES',
          'CHECK',
          'GENERATED',
          'COLLATE',
          'AUTO_INCREMENT',
        ].some((word) => keyword(token, word)),
    )
    const type = words(definition.slice(current + 1, boundary < 0 ? undefined : boundary))
    const defaultIndex = position(definition, 'DEFAULT')
    const defaultEnd = definition.findIndex(
      (token, index) =>
        index > defaultIndex &&
        ['NOT', 'PRIMARY', 'REFERENCES', 'UNIQUE', 'CHECK', 'CONSTRAINT'].some((word) =>
          keyword(token, word),
        ),
    )
    make('column', column, {
      table: item.name,
      schema: item.schema,
      type,
      identity: [item.schema, item.name, column.name].filter(Boolean).join('.'),
      nullable: !/\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b/i.test(words(definition)),
      sequential:
        ((dialect === 'postgresql' || dialect === 'mysql') &&
          /^(?:smallserial|serial|bigserial|serial2|serial4|serial8)$/i.test(type)) ||
        definition.slice(current + 1).some((token, offset, rest) => {
          if (keyword(rest[offset - 1], 'CONSTRAINT')) return false
          if (dialect === 'mysql' && keyword(token, 'AUTO_INCREMENT')) return true
          if (dialect === 'sqlite' && keyword(token, 'AUTOINCREMENT')) return true
          if (dialect !== 'postgresql') return false
          if (
            keyword(token, 'IDENTITY') &&
            keyword(rest[offset - 1], 'AS') &&
            position(rest.slice(0, offset - 1), 'GENERATED') >= 0
          )
            return true
          return (
            defaultIndex >= 0 &&
            offset + current + 1 > defaultIndex &&
            token.value === 'nextval' &&
            rest[offset + 1]?.value === '(' &&
            (rest[offset - 1]?.value !== '.' || rest[offset - 2]?.value === 'pg_catalog')
          )
        }),
      ...(defaultIndex < 0
        ? {}
        : {
            default: words(
              definition.slice(defaultIndex + 1, defaultEnd < 0 ? undefined : defaultEnd),
            ),
          }),
    })
    const addInline = (kind: string, operation: string, extra: Partial<LintNode> = {}) => {
      for (const [index, token] of definition.entries()) {
        if (!keyword(token, operation)) continue
        const named = keyword(definition[index - 2], 'CONSTRAINT')
          ? definition[index - 1]
          : undefined
        const name = named?.value ?? ''
        make(
          kind,
          { name, token: named ?? column.token, end: 0 },
          {
            table: item.name,
            schema: item.schema,
            columns: [column.name],
            generated: named === undefined,
            identity: [item.schema, item.name, name || kind + ':' + column.name + ':' + index]
              .filter(Boolean)
              .join('.'),
            ...extra,
          },
        )
      }
    }
    addInline('primary-key', 'PRIMARY')
    const ref = position(definition, 'REFERENCES')
    if (ref >= 0) {
      const target = identifier(definition, ref + 1)
      addInline('foreign-key', 'REFERENCES', {
        targetTable: target?.name,
        targetSchema: target?.schema,
        targetColumns: columnList(definition, target?.end ?? definition.length),
      })
    }
    addInline('check', 'CHECK')
    addInline('unique', 'UNIQUE', { unique: true })
  }

  return { extractTable, extractDefinition }
}
