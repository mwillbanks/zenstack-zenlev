import type { LintGap, LintNode } from '../types'
import { identity } from '../../identity'
import {
  columnList,
  groups,
  identifier,
  keyword,
  position,
  words,
  topLevel,
  typeName,
  serialType,
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
    const opening = keyword(tokens[item.end], '(') ? item.end : -1
    if (opening < 0 || position(topLevel(tokens), 'AS') >= 0) {
      gaps.push({
        message: 'CREATE TABLE AS or inherited columns require catalog inspection.',
        source: node.source,
        identity: node.identity,
      })
      return
    }
    const definitions = groups(tokens, opening)
    for (const definition of definitions) extractDefinition(definition)
    if (position(tokens, 'INHERITS') >= 0)
      gaps.push({
        message: 'Inherited columns require catalog inspection.',
        source: node.source,
        identity: node.identity,
      })
    const pk = nodes.find(
      (candidate) =>
        candidate.kind === 'primary-key' &&
        candidate.table === item.name &&
        candidate.schema === item.schema,
    )
    const tableSurface = topLevel(tokens)
    const without = position(tableSurface, 'WITHOUT')
    const withoutRowid = without >= 0 && keyword(tableSurface[without + 1], 'ROWID')
    const strictKey = dialect !== 'sqlite' || withoutRowid || position(tableSurface, 'STRICT') >= 0
    for (const column of nodes)
      if (
        column.kind === 'column' &&
        column.table === item.name &&
        column.schema === item.schema &&
        pk?.columns?.includes(column.name) &&
        strictKey
      )
        Object.assign(column, { nullable: false })
    if (dialect === 'sqlite' && pk?.columns?.length === 1 && !withoutRowid) {
      const column = nodes.find(
        (candidate) => candidate.kind === 'column' && candidate.name === pk.columns![0],
      )
      const definition = definitions.find((part) => part[0]?.value === column?.name)
      if (
        column?.type?.toLowerCase() === 'integer' &&
        !/\bPRIMARY\s+KEY\s+DESC\b/i.test(words(definition ?? []))
      )
        Object.assign(column, { sequential: true, nullable: false })
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
      ['EXCLUDE', 'exclusion'],
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
          ...(constraintKind === 'unique' ? { unique: true } : {}),
          generated: constraint === undefined,
          explicit: constraint !== undefined,
          identity: identity(
            item.schema,
            item.name,
            name ||
              [
                constraintKind,
                node.source?.path,
                node.source?.line,
                node.source?.column,
                first.start,
              ].join(':'),
          ),
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
    const surface = topLevel(definition)
    const serialDefault =
      dialect === 'mysql'
        ? surface.find(
            (token, index) =>
              definition.indexOf(token) > current + 1 &&
              keyword(token, 'SERIAL') &&
              keyword(surface[index + 1], 'DEFAULT') &&
              keyword(surface[index + 2], 'VALUE'),
          )
        : undefined
    const boundary = definition.findIndex(
      (token, index) =>
        token === serialDefault ||
        (index > current &&
          surface.includes(token) &&
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
          ].some((word) => keyword(token, word))),
    )
    const type = typeName(definition.slice(current + 1, boundary < 0 ? undefined : boundary))
    const defaultToken = surface.find(
      (token, index) => keyword(token, 'DEFAULT') && surface[index - 1] !== serialDefault,
    )
    const defaultIndex = defaultToken ? definition.indexOf(defaultToken) : -1
    const defaultEnd = definition.findIndex(
      (token, index) =>
        index > defaultIndex &&
        surface.includes(token) &&
        ['NOT', 'PRIMARY', 'REFERENCES', 'UNIQUE', 'CHECK', 'CONSTRAINT'].some((word) =>
          keyword(token, word),
        ),
    )
    const serial = serialType(type, dialect) || serialDefault !== undefined
    const explicitMysqlNull =
      dialect === 'mysql' &&
      surface.some(
        (token, index) =>
          keyword(token, 'NULL') &&
          !['DEFAULT', 'NOT', 'SET'].some((word) => keyword(surface[index - 1], word)),
      )
    const notNull = surface.some(
      (token, index) => keyword(token, 'NOT') && keyword(surface[index + 1], 'NULL'),
    )
    make('column', column, {
      table: item.name,
      schema: item.schema,
      type,
      identity: identity(item.schema, item.name, column.name),
      nullable:
        !notNull &&
        !(dialect !== 'sqlite' && position(surface, 'PRIMARY') >= 0) &&
        !(serial && !explicitMysqlNull),
      sequential:
        serial ||
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
            (defaultEnd < 0 || offset + current + 1 < defaultEnd) &&
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
    const addInline = (
      kind: string,
      operation: string,
      extra: Partial<LintNode> = {},
      implicit = false,
    ) => {
      for (const [index, token] of definition.entries()) {
        if (
          !surface.includes(token) ||
          !(
            keyword(token, operation) ||
            (implicit && index === current + 1 && position(surface, operation) < 0)
          )
        )
          continue
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
            explicit: named !== undefined,
            identity: identity(
              item.schema,
              item.name,
              name ||
                [
                  kind,
                  column.name,
                  node.source?.path,
                  node.source?.line,
                  node.source?.column,
                  token.start,
                ].join(':'),
            ),
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
    addInline('unique', 'UNIQUE', { unique: true }, dialect === 'mysql' && serial)
  }

  return { extractTable, extractDefinition }
}
