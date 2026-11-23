import {
  configuredRule,
  stringValue,
  booleanValue,
  strings,
  text,
  selected,
  sameTable,
  defineRule,
  defineTableRule,
  report,
  record,
  stringList,
} from './shared'

const requiredColumns = defineTableRule(
  'Require configured columns, types, nullability, and defaults.',
  (context, config) => ({
    table(node) {
      if (!selected(node, config) || node.action === 'drop') return
      const columns = record(config.columns)
      for (const [name, raw] of Object.entries(columns)) {
        const required = record(raw)
        const column = context.nodes.find(
          (candidate) =>
            candidate.kind === 'column' &&
            candidate.name === name &&
            sameTable(candidate, node) &&
            candidate.action !== 'drop',
        )
        if (!column) {
          report(context, node, 'Add required column ' + name + '.')
          continue
        }
        if (required.type !== undefined && column.type !== required.type)
          report(context, column, 'Use type ' + text(required.type) + ' for ' + name + '.')
        if (required.nullable !== undefined && column.nullable !== required.nullable)
          report(
            context,
            column,
            'Set ' + name + ' nullability to ' + String(required.nullable) + '.',
          )
        if (required.default !== undefined && column.default !== required.default)
          report(context, column, 'Use the configured default for ' + name + '.')
      }
    },
  }),
)

const columnConventions = defineRule(
  'Configure type- and selector-based column conventions.',
  (context, config) => ({
    column(node) {
      if (!selected(node, config) || node.action === 'drop') return
      const types = strings(config.types)
      if (types.length && node.type === undefined)
        return context.gap('Column type is unavailable.', node)
      if (types.length && !types.includes(node.type!)) return
      const prefixes = strings(config.prefixes)
      if (prefixes.length && !prefixes.some((prefix) => node.name.startsWith(prefix)))
        report(context, node, 'Use a column prefix from ' + prefixes.join(', ') + '.')
      if (config.suffix !== undefined && !node.name.endsWith(text(config.suffix)))
        report(context, node, 'Use column suffix ' + text(config.suffix) + '.')
      if (strings(config.forbiddenSuffixes).some((suffix) => node.name.endsWith(suffix)))
        report(context, node, 'Remove the prohibited column suffix.')
      const allowed = strings(config.allowedTypes)
      if (allowed.length && node.type !== undefined && !allowed.includes(node.type))
        report(context, node, 'Use a permitted column type: ' + allowed.join(', ') + '.')
    },
  }),
)

export const columnsRules = {
  'columns/required': configuredRule(requiredColumns, {
    columns: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: { type: stringValue, nullable: booleanValue, default: stringValue },
      },
    },
  }),
  'columns/conventions': configuredRule(columnConventions, {
    types: stringList,
    prefixes: stringList,
    suffix: stringValue,
    forbiddenSuffixes: stringList,
    allowedTypes: stringList,
  }),
}
