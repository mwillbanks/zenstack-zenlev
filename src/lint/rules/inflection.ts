import pluralize from 'pluralize'
import type { LintNode } from '../types'
import { record, strings, text, stringValue, stringList, type Options } from './shared'

export function singular(value: string, config: Options): string {
  const irregular = record(config.irregular)
  const offset = value.lastIndexOf('_') + 1
  const word = value.slice(offset)
  const prefix = value.slice(0, offset)
  if (strings(config.uncountable).some((entry) => entry === value || entry === word)) return value
  for (const [single, multiple] of Object.entries(irregular)) {
    if (value === multiple) return single
    if (word === multiple) return prefix + single
  }
  return prefix + pluralize.singular(word)
}

export function plural(value: string, config: Options): string {
  const irregular = record(config.irregular)
  const offset = value.lastIndexOf('_') + 1
  const word = value.slice(offset)
  const prefix = value.slice(0, offset)
  if (strings(config.uncountable).some((entry) => entry === value || entry === word)) return value
  if (typeof irregular[value] === 'string') return irregular[value]
  if (typeof irregular[word] === 'string') return prefix + irregular[word]
  return prefix + pluralize.plural(word)
}

export function template(value: string, node: LintNode, config: Options): string {
  const table = node.table ?? node.name
  const variables: Record<string, string> = {
    name: node.name,
    schema: node.schema ?? '',
    table,
    tableStem: singular(table, config),
    columns: (node.columns ?? []).join(text(config.separator, '_')),
    target: node.targetTable ?? '',
    targetStem: singular(node.targetTable ?? '', config),
    targetColumns: (node.targetColumns ?? []).join(text(config.separator, '_')),
    kind: node.kind,
  }
  return value.replace(/\{([A-Za-z]+)\}/g, (_, key: string) => {
    if (!(key in variables)) throw new TypeError('Unknown naming template variable: ' + key)
    return variables[key]!
  })
}

export const inflections = {
  irregular: { type: 'object', additionalProperties: stringValue },
  uncountable: stringList,
}
export const namingTemplate = { ...inflections, template: stringValue, separator: stringValue }
