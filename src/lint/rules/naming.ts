import type { LintRule } from '../types'
import {
  configuredRule,
  stringList,
  stringValue,
  booleanValue,
  strings,
  text,
  matches,
  tableIdentity,
  selected,
  sameTable,
  defineRule,
  defineTableRule,
  report,
  record,
} from './shared'
import { singular, plural, template, inflections, namingTemplate } from './inflection'

type Format = 'PascalCase' | 'camelCase' | 'snake_case' | 'kebab-case' | 'UPPER_SNAKE_CASE'

function hasFormat(value: string, format: string): boolean {
  const patterns: Record<Format, RegExp> = {
    PascalCase: /^[A-Z][A-Za-z0-9]*$/,
    camelCase: /^[a-z][A-Za-z0-9]*$/,
    snake_case: /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    'kebab-case': /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    UPPER_SNAKE_CASE: /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
  }
  const pattern = patterns[format as Format]
  if (!pattern) throw new TypeError('Unknown identifier format: ' + format)
  return pattern.test(value)
}

function caseRule(kind: string, fallback: Format): LintRule {
  return defineRule('Require the configured identifier case.', (context, config) => ({
    [kind](node) {
      if (!selected(node, config) || node.action === 'drop' || node.action === 'call') return
      const format = text(config.format, fallback)
      if (!hasFormat(node.name, format)) {
        report(context, node, 'Use ' + format + ' for ' + kind + ' ' + node.name + '.')
      }
    },
  }))
}

const identifier = defineRule('Configure physical identifier conventions.', (context, config) => {
  const denied = strings(config.deny)
  const reserved = strings(config.reserved)
  const pattern = config.pattern === undefined ? undefined : new RegExp(text(config.pattern))
  return {
    '*': (node) => {
      if (
        ['model', 'field', 'rls', 'zenstack-policy'].includes(node.kind) ||
        !selected(node, config)
      )
        return
      if (node.action === 'drop' || node.action === 'call') return
      const name = node.spelling ?? node.name
      const failures: string[] = []
      if (config.format !== undefined && !hasFormat(name, text(config.format)))
        failures.push('use ' + text(config.format))
      if (config.prefix !== undefined && !name.startsWith(text(config.prefix)))
        failures.push('use prefix ' + text(config.prefix))
      if (config.suffix !== undefined && !name.endsWith(text(config.suffix)))
        failures.push('use suffix ' + text(config.suffix))
      if (pattern && !pattern.test(name)) failures.push('match ' + text(config.pattern))
      if (denied.some((entry) => matches(name, entry))) failures.push('choose an allowed name')
      if (reserved.some((entry) => entry.toLowerCase() === name.toLowerCase()))
        failures.push('avoid a reserved identifier')
      const limit =
        config.maxLength === undefined
          ? node.dialect === 'postgresql'
            ? 63
            : node.dialect === 'mysql'
              ? 64
              : undefined
          : config.maxLength
      if (
        limit !== undefined &&
        (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)
      )
        throw new TypeError('maxLength must be a positive integer')
      const length =
        node.dialect === 'postgresql'
          ? new TextEncoder().encode(name).length
          : Array.from(name).length
      if (typeof limit === 'number' && length > limit)
        failures.push('stay within ' + limit + ' identifier units')
      if (config.quoted === false) {
        if (node.quoted === true) failures.push('use an unquoted identifier')
        else if (node.quoted === undefined && node.origin === 'catalog')
          context.gap('Catalogs cannot establish authored identifier quoting.', node)
      }
      if (config.qualified === true) {
        if (node.origin === 'catalog')
          context.gap('Catalog identity cannot establish authored qualification.', node)
        else if (!node.schema) failures.push('qualify the object with its schema')
      }
      if (failures.length)
        report(context, node, 'Identifier ' + name + ' must ' + failures.join(', ') + '.')
    },
  }
})

const tableNumber = defineRule('Require configured table inflection.', (context, config) => ({
  table(node) {
    if (!selected(node, config) || node.action === 'drop') return
    const form = text(config.form, 'plural')
    if (form === 'unchanged') return
    if (!['singular', 'plural'].includes(form))
      throw new TypeError('form must be singular, plural, or unchanged')
    const stem = singular(node.name, config)
    const expected = form === 'plural' ? plural(stem, config) : stem
    if (node.name !== expected)
      report(context, node, 'Use ' + form + ' table name ' + expected + '.')
  },
}))

const foreignName = defineRule('Configure foreign key column names.', (context, config) => ({
  'foreign-key'(node) {
    if (!selected(node, config) || node.action === 'drop') return
    if (!node.targetTable || !node.columns)
      return context.gap('Foreign key naming requires resolved target and columns.', node)
    if (node.columns.length !== 1) {
      if (config.composite === 'check') {
        if (!node.targetColumns || node.targetColumns.length !== node.columns.length)
          return context.gap('Composite foreign key targets are unavailable.', node)
        for (let i = 0; i < node.columns.length; i++) {
          const expected = singular(node.targetTable, config) + '_' + node.targetColumns[i]!
          if (node.columns[i] !== expected)
            report(context, node, 'Name foreign key column ' + expected + '.')
        }
      }
      return
    }
    const expected = template(text(config.template, '{targetStem}_id'), node, config)
    if (node.columns[0] !== expected)
      report(context, node, 'Name the foreign key column ' + expected + '.')
  },
}))

const constraintName = defineRule(
  'Configure constraint and index naming templates.',
  (context, config) => ({
    '*': (node) => {
      if (
        !['primary-key', 'foreign-key', 'index', 'unique', 'check', 'exclusion'].includes(
          node.kind,
        ) ||
        !selected(node, config) ||
        node.action === 'drop'
      )
        return
      const templates = record(config.templates)
      if (config.explicit !== undefined && typeof config.explicit !== 'boolean')
        throw new TypeError('explicit must be boolean')
      if (typeof config.explicit === 'boolean') {
        if (node.explicit === undefined)
          context.gap('Explicit constraint naming cannot be established from this evidence.', node)
        else if (node.explicit !== config.explicit)
          report(
            context,
            node,
            config.explicit
              ? 'Name the constraint or index explicitly.'
              : 'Use the database-generated constraint name.',
          )
      }
      const configured = templates[node.kind] ?? config.template
      if (configured === undefined) return
      if (!node.name) return context.gap('The final generated name is unavailable.', node)
      const expected = template(text(configured), node, config)
      if (node.name !== expected)
        report(context, node, 'Name this ' + node.kind + ' ' + expected + '.')
    },
  }),
)

const joinTable = defineTableRule(
  'Configure explicitly selected relationship tables.',
  (context, config) => ({
    table(node) {
      if (!selected(node, config) || node.action === 'drop') return
      if (!Array.isArray(config.joins))
        throw new TypeError('joins must contain explicit relationship table definitions')
      for (const raw of config.joins) {
        const join = record(raw)
        if (!matches(tableIdentity(node), text(join.table))) continue
        const sides = [text(join.left), text(join.right)]
        if (join.order === 'lexical') sides.sort()
        const expected = text(join.template, '{left}_{right}')
          .replaceAll('{left}', sides[0]!)
          .replaceAll('{right}', sides[1]!)
        if (node.name !== expected)
          report(context, node, 'Name this relationship table ' + expected + '.')
        const keys = context.nodes.filter(
          (candidate) =>
            candidate.kind === 'primary-key' &&
            sameTable(candidate, node) &&
            candidate.action !== 'drop',
        )
        if (join.key === 'surrogate' && !keys.some((key) => key.columns?.length === 1))
          report(
            context,
            node,
            'Give the relationship table a single-column surrogate primary key.',
          )
        if (join.key === 'composite' && !keys.some((key) => (key.columns?.length ?? 0) > 1))
          report(context, node, 'Give the relationship table a composite primary key.')
      }
    },
  }),
)

const formatValue = {
  enum: ['PascalCase', 'camelCase', 'snake_case', 'kebab-case', 'UPPER_SNAKE_CASE'],
}

export const namingRules = {
  'naming/model-case': configuredRule(caseRule('model', 'PascalCase'), { format: formatValue }),
  'naming/field-case': configuredRule(caseRule('field', 'camelCase'), { format: formatValue }),
  'naming/table-case': configuredRule(caseRule('table', 'snake_case'), { format: formatValue }),
  'naming/column-case': configuredRule(caseRule('column', 'snake_case'), { format: formatValue }),
  'naming/identifier': configuredRule(identifier, {
    format: formatValue,
    prefix: stringValue,
    suffix: stringValue,
    pattern: stringValue,
    deny: stringList,
    reserved: stringList,
    maxLength: { type: 'integer', minimum: 1 },
    quoted: booleanValue,
    qualified: booleanValue,
  }),
  'naming/table-number': configuredRule(tableNumber, {
    ...inflections,
    form: { enum: ['singular', 'plural', 'unchanged'] },
  }),
  'naming/join-table': configuredRule(joinTable, {
    joins: {
      type: 'array',
      items: {
        type: 'object',
        required: ['table', 'left', 'right'],
        additionalProperties: false,
        properties: {
          table: stringValue,
          left: stringValue,
          right: stringValue,
          template: stringValue,
          order: { enum: ['declared', 'lexical'] },
          key: { enum: ['surrogate', 'composite'] },
        },
      },
    },
  }),
  'naming/foreign-key': configuredRule(foreignName, {
    ...namingTemplate,
    composite: { enum: ['skip', 'check'] },
  }),
  'naming/constraint': configuredRule(constraintName, {
    ...namingTemplate,
    explicit: booleanValue,
    templates: {
      type: 'object',
      additionalProperties: false,
      properties: {
        'primary-key': stringValue,
        'foreign-key': stringValue,
        index: stringValue,
        unique: stringValue,
        check: stringValue,
        exclusion: stringValue,
      },
    },
  }),
}
