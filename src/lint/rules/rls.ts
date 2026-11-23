import type { LintNode } from '../types'
import {
  configuredRule,
  isTrue,
  booleanValue,
  strings,
  matches,
  tableIdentity,
  selected,
  defineRule,
  report,
  stringList,
} from './shared'

interface RlsState {
  anchor: LintNode
  enabled?: boolean
  forced?: boolean
  policies: Map<string, LintNode>
}

const rls = defineRule('Check configured PostgreSQL native row security.', (context, config) => {
  const states = new Map<string, RlsState>()
  for (const node of context.nodes) {
    if (node.dialect !== 'postgresql' || !['table', 'policy', 'rls'].includes(node.kind)) continue
    const key = tableIdentity(node)
    let state = states.get(key)
    if (!state) {
      state = { anchor: node, policies: new Map() }
      states.set(key, state)
    }
    if (node.kind === 'table') {
      state.anchor = node
      if (node.action === 'create') {
        state.enabled = false
        state.forced = false
      }
      if (node.action === 'drop') states.delete(key)
    } else if (node.kind === 'rls') {
      state.anchor = node
      if (node.enabled !== undefined) state.enabled = node.enabled
      if (node.forced !== undefined) state.forced = node.forced
      if (node.action === 'enable') state.enabled = true
      if (node.action === 'disable') state.enabled = false
      if (node.action === 'force') state.forced = true
      if (node.action === 'no-force') state.forced = false
    } else {
      const previous = state.policies.get(node.name)
      if (node.action === 'drop') state.policies.delete(node.name)
      else if (node.action === 'alter' && previous) {
        const updated = { ...previous }
        for (const [key, value] of Object.entries(node)) {
          if (value !== undefined) Object.assign(updated, { [key]: value })
        }
        state.policies.set(node.name, updated)
      } else state.policies.set(node.name, node)
    }
  }
  const evaluated = new Set<string>()
  return {
    '*': (node) => {
      if (node.dialect !== 'postgresql' || (node.kind === 'table' && node.action === 'drop')) return
      const key = tableIdentity(node)
      if (evaluated.has(key)) return
      const state = states.get(key)
      if (!state) return
      evaluated.add(key)
      const anchor = node
      const tables = strings(config.tables)
      if (
        !selected(anchor, config) ||
        (tables.length && !tables.some((pattern) => matches(tableIdentity(anchor), pattern)))
      )
        return
      if (config.enabled !== false) {
        if (state.enabled === undefined) context.gap('RLS enabled state is unavailable.', anchor)
        else if (!state.enabled)
          report(context, anchor, 'Enable row-level security on ' + tableIdentity(anchor) + '.')
      }
      if (config.force === true) {
        if (state.forced === undefined) context.gap('RLS forced state is unavailable.', anchor)
        else if (!state.forced)
          report(context, anchor, 'Force row-level security on ' + tableIdentity(anchor) + '.')
      }
      const policies = [...state.policies.values()]
      for (const policy of policies) {
        const unknownOperation = policy.action === 'alter' && policy.command === undefined
        const operation = policy.command?.toLowerCase() ?? 'all'
        if (config.explicitWriteCheck === true) {
          if (unknownOperation || (policy.action === 'alter' && policy.check === undefined))
            context.gap('Prior policy write-check state is unavailable.', policy)
          else if (['insert', 'update', 'all'].includes(operation) && policy.check == null)
            report(context, policy, 'Declare an explicit WITH CHECK predicate.')
        }
        if (config.explicitUsing === true) {
          if (unknownOperation || (policy.action === 'alter' && policy.using === undefined))
            context.gap('Prior policy visibility state is unavailable.', policy)
          else if (
            ['select', 'update', 'delete', 'all'].includes(operation) &&
            policy.using == null
          )
            report(context, policy, 'Declare an explicit USING predicate.')
        }
        if (config.noBroad === true && (isTrue(policy.using) || isTrue(policy.check)))
          report(context, policy, 'Replace the unrestricted row-security predicate.')
        const allowedRoles = strings(config.allowedRoles)
        if (allowedRoles.length) {
          if (policy.action === 'alter' && policy.roles === undefined)
            context.gap('Prior policy role scope is unavailable.', policy)
          else if ((policy.roles ?? ['public']).some((role) => !allowedRoles.includes(role)))
            report(context, policy, 'Scope this policy to an allowed role.')
        }
      }
      if (config.defaultDeny === true) return
      if (
        strings(config.commands).length &&
        policies.some(
          (policy) =>
            policy.action === 'alter' &&
            (policy.command === undefined ||
              policy.roles === undefined ||
              policy.using === undefined ||
              policy.check === undefined),
        )
      ) {
        context.gap('Operation coverage requires the prior ALTER POLICY state.', anchor)
        return
      }
      const roles = strings(config.roles)
      for (const command of strings(config.commands)) {
        for (const role of roles.length ? roles : ['public']) {
          const applicable = policies.filter((policy) => {
            const policyCommand = policy.command?.toLowerCase() ?? 'all'
            return (
              (policyCommand === 'all' || policyCommand === command.toLowerCase()) &&
              (policy.roles ?? ['public']).some(
                (policyRole) => policyRole.toLowerCase() === 'public' || policyRole === role,
              )
            )
          })
          const effective = applicable.some(
            (policy) =>
              policy.permissive !== false &&
              (command === 'insert' || command === 'update'
                ? (policy.check ??
                  (policy.command?.toLowerCase() === 'insert' ? undefined : policy.using))
                : policy.using) != null,
          )
          if (!effective)
            report(
              context,
              anchor,
              'Provide an applicable permissive ' + command + ' policy for role ' + role + '.',
            )
        }
      }
    },
  }
})

export const rlsRules = {
  'postgres/rls': configuredRule(rls, {
    tables: stringList,
    enabled: booleanValue,
    force: booleanValue,
    explicitWriteCheck: booleanValue,
    explicitUsing: booleanValue,
    noBroad: booleanValue,
    allowedRoles: stringList,
    defaultDeny: booleanValue,
    roles: stringList,
    commands: {
      type: 'array',
      uniqueItems: true,
      items: { enum: ['select', 'insert', 'update', 'delete'] },
    },
  }),
}
