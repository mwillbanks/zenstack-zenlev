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
      if (!required.length && !checks.length) report(context, node, 'Add a table CHECK constraint.')
      for (const name of required) {
        if (!checks.some((check) => matches(check.name, name)))
          report(context, node, 'Add CHECK constraint ' + name + '.')
      }
    },
  }),
)

export const constraintsRules = {
  'constraints/required-check': configuredRule(requiredCheck, { names: stringList }),
}
