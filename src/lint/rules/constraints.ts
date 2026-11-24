import {
  configuredRule,
  strings,
  matches,
  selected,
  sameTable,
  defineTableRule,
  report,
  stringList,
} from './shared'

const requiredCheck = defineTableRule(
  'Require configured table CHECK constraints.',
  (context, config) => ({
    table(node) {
      if (!selected(node, config) || node.action === 'drop') return
      const required = strings(config.names)
      const checks = context.nodes.filter(
        (candidate) =>
          candidate.kind === 'check' && sameTable(candidate, node) && candidate.action !== 'drop',
      )
      if (!required.length && !checks.length) {
        if (node.checksKnown === false)
          context.gap('Table CHECK constraints are unavailable.', node)
        else report(context, node, 'Add a table CHECK constraint.')
      }
      const missing = required.filter(
        (name) => !checks.some((check) => check.nameKnown !== false && matches(check.name, name)),
      )
      if (!missing.length) return
      if (node.checksKnown === false || checks.some((check) => check.nameKnown === false))
        return context.gap('Table CHECK constraint names are unavailable.', node)
      for (const name of missing) report(context, node, 'Add CHECK constraint ' + name + '.')
    },
  }),
)

export const constraintsRules = {
  'constraints/required-check': configuredRule(requiredCheck, { names: stringList }),
}
