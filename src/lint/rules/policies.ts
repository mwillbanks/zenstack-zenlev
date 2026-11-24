import type { LintNode } from '../types'
import {
  configuredRule,
  isTrue,
  booleanValue,
  strings,
  selected,
  sameTable,
  defineRule,
  report,
} from './shared'

const zenstackPolicies = defineRule(
  'Check configured ZenStack access policy declarations.',
  (context, config) => ({
    model(node) {
      if (!selected(node, config)) return
      const policies = context.nodes.filter(
        (candidate) => candidate.kind === 'zenstack-policy' && sameTable(candidate, node),
      )
      const hasOperation = (policy: LintNode, command: string) =>
        policy.command?.split(',').some((operation) => {
          const name = operation.trim()
          return name === command || (command !== 'post-update' && name === 'all')
        })
      for (const command of strings(config.commands)) {
        const covered = policies.some(
          (policy) => policy.permissive !== false && hasOperation(policy, command),
        )
        if (!covered) report(context, node, 'Declare a ZenStack allow policy for ' + command + '.')
      }
      if (
        config.postUpdate === true &&
        !policies.some((policy) => hasOperation(policy, 'post-update'))
      )
        report(context, node, 'Declare a ZenStack post-update policy.')
      if (config.noBroad === true) {
        for (const policy of policies) {
          if (policy.permissive !== false && isTrue(policy.using))
            report(context, policy, 'Replace the unconditional ZenStack allow policy.')
        }
      }
    },
  }),
)

export const policiesRules = {
  'zenstack/policies': configuredRule(zenstackPolicies, {
    commands: {
      type: 'array',
      uniqueItems: true,
      items: { enum: ['create', 'read', 'update', 'delete', 'post-update', 'all'] },
    },
    postUpdate: booleanValue,
    noBroad: booleanValue,
  }),
}
