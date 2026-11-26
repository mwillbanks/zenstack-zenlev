import { configuredRule, record, report, selected, type Options } from './shared'

const queryTypes = ['query-builder', 'query-api']
const modes = ['auto', 'zenstack', 'standalone']

function queryRule(
  description: string,
  properties: Readonly<Record<string, object>>,
  violation: (type: string | undefined, command: string | undefined, config: Options) => boolean,
) {
  return configuredRule(
    {
      meta: { description, messages: { violation: '{{message}}' } },
      create(context) {
        const config = record(context.options[0])
        return {
          'application-query': (node) => {
            if (
              node.origin === 'application' &&
              selected(node, config) &&
              violation(node.type, node.command, config)
            ) {
              report(context, node, description + ': ' + node.name)
            }
          },
        }
      },
    },
    properties,
  )
}

export const queryRules = {
  'queries/allowed-types': queryRule(
    'Use an allowed query interface',
    { allow: { type: 'array', uniqueItems: true, items: { enum: queryTypes } } },
    (type, _command, config) => {
      const allowed = (config.allow as readonly string[] | undefined) ?? queryTypes
      return type !== undefined && queryTypes.includes(type) && !allowed.includes(type)
    },
  ),
  'queries/no-direct-kysely': queryRule(
    'Use the ZenStack query builder instead of direct Kysely access',
    { mode: { enum: modes } },
    (type, command, config) =>
      type === 'direct-kysely' &&
      (command === 'low-level' ||
        (config.mode === undefined || config.mode === 'auto' ? command : config.mode) ===
          'zenstack'),
  ),
  'queries/no-raw': queryRule('Use a typed query instead of raw SQL', {}, (type) => type === 'raw'),
  'queries/no-schema-changes': queryRule(
    'Move schema changes to a migration',
    {},
    (type) => type === 'schema-change',
  ),
}
