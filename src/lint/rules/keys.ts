import {
  configuredRule,
  strings,
  text,
  matches,
  selected,
  sameTable,
  defineRule,
  defineTableRule,
  report,
  stringList,
} from './shared'
import { template, namingTemplate } from './inflection'

const primaryName = defineRule(
  'Require the configured single-column primary key name.',
  (context, config) => ({
    'primary-key'(node) {
      if (!selected(node, config) || node.action === 'drop' || node.columns?.length !== 1) return
      const expected = template(text(config.template, 'id'), node, config)
      if (node.columns[0] !== expected)
        report(context, node, 'Name the primary key column ' + expected + '.')
    },
  }),
)

const noSequential = defineTableRule(
  'Reject database-generated sequential primary keys.',
  (context, config) => ({
    table(table) {
      const primaryKeys = context.nodes.filter(
        (node) => node.kind === 'primary-key' && sameTable(node, table),
      )
      for (const column of context.nodes) {
        if (column.kind !== 'column' || !sameTable(column, table) || !selected(column, config))
          continue
        if (
          column.sequential === true &&
          primaryKeys.some((key) => key.columns?.includes(column.name))
        ) {
          report(
            context,
            { ...column, source: column.source ?? table.source },
            'Use a distributed or application-assigned primary key.',
          )
        }
      }
    },
  }),
)

const primaryType = defineRule(
  'Configure primary key types and default generators.',
  (context, config) => ({
    column(node) {
      if (!selected(node, config) || node.action === 'drop') return
      if (
        !context.nodes.some(
          (candidate) =>
            candidate.kind === 'primary-key' &&
            sameTable(candidate, node) &&
            candidate.columns?.includes(node.name),
        )
      )
        return
      const allowed = strings(config.types)
      if (allowed.length && node.type === undefined)
        context.gap('Primary key type is unavailable.', node)
      else if (allowed.length && !allowed.includes(node.type!))
        report(context, node, 'Use a permitted primary key type: ' + allowed.join(', ') + '.')
      const defaults = strings(config.defaults)
      if (
        defaults.length &&
        (node.default === undefined || !defaults.some((pattern) => matches(node.default!, pattern)))
      )
        report(context, node, 'Use a permitted primary key default generator.')
    },
  }),
)

const foreignIndex = defineTableRule(
  'Require indexes covering foreign key leading columns.',
  (context, config) => ({
    table(table) {
      const related = context.nodes.filter((node) => sameTable(node, table))
      for (const node of related) {
        if (node.kind !== 'foreign-key' || !selected(node, config)) continue
        if (!node.columns?.length) {
          context.gap('Foreign key column order is unavailable.', node)
          continue
        }
        const covered = related.some(
          (candidate) =>
            ['index', 'unique', 'primary-key'].includes(candidate.kind) &&
            candidate.partial !== true &&
            node.columns!.every((column, index) => candidate.columns?.[index] === column),
        )
        if (!covered) {
          report(
            context,
            { ...node, source: node.source ?? table.source },
            'Add an index beginning with ' + node.columns.join(', ') + '.',
          )
        }
      }
    },
  }),
)

export const keysRules = {
  'keys/primary-name': configuredRule(primaryName, namingTemplate),
  'keys/no-sequential': configuredRule(noSequential, {}),
  'keys/primary-type': configuredRule(primaryType, { types: stringList, defaults: stringList }),
  'keys/foreign-key-index': configuredRule(foreignIndex, {}),
}
