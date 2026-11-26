import { namingRules } from './rules/naming'
import { keysRules } from './rules/keys'
import { constraintsRules } from './rules/constraints'
import { columnsRules } from './rules/columns'
import { objectsRules } from './rules/objects'
import { rlsRules } from './rules/rls'
import { policiesRules } from './rules/policies'
import { queryRules } from './rules/queries'
import type { LintConfig, LintRule } from './types'

export const builtinRules: Readonly<Record<string, LintRule>> = {
  ...namingRules,
  ...keysRules,
  ...constraintsRules,
  ...columnsRules,
  ...objectsRules,
  ...rlsRules,
  ...policiesRules,
  ...queryRules,
}

export const recommendedLintConfig: LintConfig = {
  rules: {
    'zenlev/naming/model-case': 'error',
    'zenlev/naming/field-case': 'error',
    'zenlev/naming/table-case': 'error',
    'zenlev/naming/column-case': 'error',
    'zenlev/keys/primary-name': 'error',
    'zenlev/keys/no-sequential': 'error',
    'zenlev/queries/allowed-types': 'error',
    'zenlev/queries/no-direct-kysely': 'error',
    'zenlev/queries/no-raw': 'error',
  },
}

export const builtinPresets: Readonly<Record<string, LintConfig>> = {
  recommended: recommendedLintConfig,
  naming: {
    rules: {
      'zenlev/naming/identifier': ['error', { format: 'snake_case' }],
      'zenlev/naming/table-number': ['error', { form: 'plural' }],
      'zenlev/naming/foreign-key': 'error',
    },
  },
  objects: {
    rules: {
      'zenlev/objects/restricted': [
        'error',
        {
          kinds: [
            'function',
            'procedure',
            'view',
            'materialized-view',
            'trigger',
            'event-trigger',
            'event',
            'sequence',
            'anonymous-block',
          ],
        },
      ],
    },
  },
  access: {
    rules: {
      'zenlev/postgres/rls': ['error', { enabled: true, explicitWriteCheck: true, noBroad: true }],
      'zenlev/zenstack/policies': ['error', { noBroad: true }],
    },
  },
}
