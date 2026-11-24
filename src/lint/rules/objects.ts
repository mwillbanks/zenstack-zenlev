import {
  configuredRule,
  booleanValue,
  strings,
  text,
  matches,
  qualified,
  selected,
  defineRule,
  report,
  stringList,
} from './shared'

const restrictedObjects = defineRule('Restrict SQL objects and operations.', (context, config) => {
  const kinds = strings(config.kinds)
  const actions = strings(config.actions)
  const allow = strings(config.allow)
  const languages = strings(config.languages)
  return {
    '*': (node) => {
      if (!selected(node, config)) return
      if (
        kinds.length === 0 &&
        ![
          'function',
          'procedure',
          'view',
          'materialized-view',
          'trigger',
          'event-trigger',
          'event',
          'sequence',
          'extension',
          'anonymous-block',
        ].includes(node.kind)
      )
        return
      const action = node.action ?? 'existing'
      if (actions.length ? !actions.includes(action) : action === 'drop' || action === 'call')
        return
      const identity = node.identity ?? qualified(node) + (node.signature ?? '')
      if (allow.some((pattern) => matches(identity, pattern))) return
      if (languages.length) {
        if (!node.language) return context.gap('Stored-object language is unavailable.', node)
        if (!languages.includes(node.language)) return
      }
      report(context, node, 'Policy prohibits ' + action + ' ' + node.kind + ' ' + identity + '.')
    },
  }
})

const objectSecurity = defineRule(
  'Configure stored-object security and trusted search paths.',
  (context, config) => ({
    '*': (node) => {
      if (
        !['function', 'procedure', 'view', 'trigger', 'event'].includes(node.kind) ||
        !selected(node, config) ||
        node.action === 'drop' ||
        node.action === 'call'
      )
        return
      const routine = node.kind === 'function' || node.kind === 'procedure'
      const trustedPath =
        routine && node.dialect === 'postgresql' && config.trustedSearchPath !== undefined
      const security = node.security?.toLowerCase()
      if ((config.security !== undefined || trustedPath) && security === undefined)
        context.gap('Stored-object execution security is unavailable.', node)
      if (
        config.security !== undefined &&
        security !== undefined &&
        security !== text(config.security)
      )
        report(context, node, 'Use ' + text(config.security) + ' execution security.')
      if (trustedPath && security === 'definer') {
        const trusted = strings(config.trustedSearchPath)
        if (!node.searchPath) context.gap('Definer search_path is unavailable.', node)
        else if (
          !node.searchPath.length ||
          node.searchPath.some((schema) => !trusted.includes(schema))
        )
          report(context, node, 'Set an explicit trusted search_path for the definer routine.')
      }
      if (config.publicExecute === false && routine)
        context.gap('PUBLIC EXECUTE auditing requires grant and role metadata.', node)
    },
  }),
)

export const objectsRules = {
  'objects/restricted': configuredRule(restrictedObjects, {
    actions: stringList,
    allow: stringList,
    languages: stringList,
  }),
  'objects/security': configuredRule(objectSecurity, {
    security: { enum: ['invoker', 'definer'] },
    trustedSearchPath: stringList,
    publicExecute: booleanValue,
  }),
}
