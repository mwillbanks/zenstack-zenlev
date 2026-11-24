import { createHash } from 'node:crypto'
import { isDataModel, isEnum, type AstNode, type DataModel } from '@zenstackhq/language/ast'
import { getAllFields, getDataSourceProvider, getLiteral } from '@zenstackhq/language/utils'
import {
  arg,
  attr,
  defaultTypes,
  loadResolvedZModel,
  literal,
  mapped,
  nativeType,
  projectResolvedZModel,
  references,
  type LoadSchemaOptions,
  type ResolvedZModel,
} from '../schema/model'
import type { LintInput, LintNode, LintSource } from './types'
import { identity } from '../identity'

function location(node: AstNode, fallback: string, hashes: WeakMap<object, string>): LintSource {
  const cst = node.$cstNode
  const root = cst?.root.astNode as AstNode & { $document?: { uri: { fsPath: string } } }
  const range = cst?.range
  let fingerprint = cst && hashes.get(cst.root)
  if (cst && !fingerprint) {
    fingerprint = createHash('sha256').update(cst.root.fullText).digest('hex')
    hashes.set(cst.root, fingerprint)
  }
  return {
    path: root?.$document?.uri.fsPath ?? fallback,
    line: (range?.start.line ?? 0) + 1,
    column: (range?.start.character ?? 0) + 1,
    ...(range ? { endLine: range.end.line + 1, endColumn: range.end.character + 1 } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  }
}

export async function readZModelLintInput(
  options: LoadSchemaOptions,
  optional = false,
): Promise<LintInput> {
  const loaded = await loadResolvedZModel(options).catch((error: unknown) => {
    if (
      optional &&
      error instanceof Error &&
      error.message === 'Schema file not found in schema.zmodel or zenstack/schema.zmodel'
    )
      return undefined
    throw error
  })
  return loaded ? inspectResolvedZModel(loaded) : { nodes: [], gaps: [] }
}

export function inspectResolvedZModel(loaded: ResolvedZModel): LintInput {
  const { model, path } = loaded
  const projected = projectResolvedZModel(loaded)
  const dialect = getDataSourceProvider(model)
  const types =
    dialect === 'sqlite' || dialect === 'postgresql' || dialect === 'mysql'
      ? defaultTypes[dialect]
      : {}
  const hashes = new WeakMap<object, string>()
  const nodes: LintNode[] = []
  const gaps: LintInput['gaps'][number][] = []
  const namespace = (target: { attributes: DataModel['attributes'] }) =>
    literal(attr(target, '@@schema'), 'map') ?? (dialect === 'postgresql' ? 'public' : undefined)
  const emit = (node: AstNode, evidence: Omit<LintNode, 'source' | 'origin'>) =>
    nodes.push({
      ...evidence,
      identity:
        evidence.identity ??
        identity(
          evidence.schema,
          ...(evidence.table && !['table', 'view', 'model'].includes(evidence.kind)
            ? [evidence.table]
            : []),
          evidence.name,
        ),
      dialect,
      source: location(node, path, hashes),
      origin: 'zmodel',
    })

  const schemas = new Set<string>()
  for (const declaration of model.declarations) {
    if (isEnum(declaration)) {
      emit(attr(declaration, '@@map') ?? declaration, {
        kind: 'enum',
        name: mapped(declaration, declaration.name, true),
        schema: namespace(declaration),
      })
      for (const field of declaration.fields)
        emit(attr(field, '@map') ?? field, {
          kind: 'enum-value',
          name: mapped(field, field.name),
          table: mapped(declaration, declaration.name, true),
          schema: namespace(declaration),
        })
    }
    if (!isDataModel(declaration) || attr(declaration, '@@ignore')) continue

    const table = mapped(declaration, declaration.name, true)
    const schema = namespace(declaration)
    const scope = { table, schema }
    if (schema && !schemas.has(schema)) {
      schemas.add(schema)
      emit(attr(declaration, '@@schema') ?? declaration, { kind: 'schema', name: schema })
    }
    emit(declaration, { ...scope, kind: 'model', name: declaration.name })
    emit(attr(declaration, '@@map') ?? declaration, {
      ...scope,
      kind: declaration.isView ? 'view' : 'table',
      name: table,
      logicalName: declaration.name,
      explicit: Boolean(attr(declaration, '@@map')),
    })

    const fields = getAllFields(declaration, true).filter((field) => !attr(field, '@ignore'))
    const physical = new Map(fields.map((field) => [field.name, mapped(field, field.name)]))
    const mapFields = (names: readonly string[]) => names.map((name) => physical.get(name) ?? name)
    const composite = attr(declaration, '@@id')
    const fieldIds = fields.filter((field) => attr(field, '@id'))
    const primary = composite
      ? mapFields(references(arg(composite, 'fields')))
      : fieldIds.map((field) => mapped(field, field.name))
    if (!declaration.isView && primary.length) {
      const explicitName =
        literal(composite, 'map') ??
        literal(fieldIds[0] ? attr(fieldIds[0], '@id') : undefined, 'map')
      emit(composite ?? attr(fieldIds[0]!, '@id') ?? declaration, {
        ...scope,
        kind: 'primary-key',
        name: explicitName ?? (dialect === 'postgresql' ? table + '_pkey' : 'PRIMARY'),
        nameKnown: explicitName !== undefined || dialect === 'postgresql' || dialect === 'mysql',
        explicit: explicitName !== undefined,
        columns: primary,
      })
    }

    for (const [index, attribute] of declaration.attributes.entries()) {
      const name = attribute.decl.$refText
      if (name === '@@index' || name === '@@unique') {
        const indexName = literal(attribute, 'map') ?? literal(attribute, 'name')
        emit(attribute, {
          ...scope,
          kind: name === '@@unique' ? 'unique' : 'index',
          name: indexName ?? table,
          nameKnown: indexName !== undefined,
          explicit: indexName !== undefined,
          unique: name === '@@unique',
          columns: mapFields(references(arg(attribute, 'fields'))),
          partial: false,
        })
      }
      if (name === '@@allow' || name === '@@deny') {
        const command = getLiteral(arg(attribute, 'operation') ?? attribute.args[0]?.value)
        const expression = arg(attribute, 'condition') ?? attribute.args[1]?.value
        if (typeof command === 'string') {
          emit(attribute, {
            ...scope,
            kind: 'zenstack-policy',
            identity: identity(schema, table, name + '#' + (index + 1)),
            name,
            command,
            permissive: name === '@@allow',
            using: expression?.$cstNode?.text,
          })
        }
      }
    }

    for (const field of fields) {
      emit(field, { ...scope, kind: 'field', name: field.name })
      const target = field.type.reference?.ref
      if (target && isDataModel(target)) {
        const relation = attr(field, '@relation')
        const local = references(arg(relation, 'fields'))
        if (local.length) {
          const referenced = new Map(
            getAllFields(target, true).map((item) => [item.name, mapped(item, item.name)]),
          )
          const name = literal(relation, 'map')
          emit(relation ?? field, {
            ...scope,
            kind: 'foreign-key',
            name: name ?? field.name,
            nameKnown: name !== undefined,
            explicit: name !== undefined,
            columns: mapFields(local),
            targetTable: mapped(target, target.name, true),
            targetSchema: namespace(target),
            targetColumns: references(arg(relation, 'references')).map(
              (item) => referenced.get(item) ?? item,
            ),
          })
        } else if (
          field.type.array &&
          getAllFields(target, true).some(
            (other) => other.type.array && other.type.reference?.ref === declaration,
          )
        ) {
          gaps.push({
            source: location(field, path, hashes),
            identity: identity(schema, table),
            message: 'Inspect the generated join table in the live catalog',
          })
        }
        continue
      }
      if (attr(field, '@computed') || (target && !isEnum(target))) continue
      const name = mapped(field, field.name)
      const native = field.attributes.find((item) => item.decl.$refText.startsWith('@db.'))
      const type =
        (native && nativeType(native)) ??
        (target && isEnum(target)
          ? dialect === 'sqlite'
            ? 'text'
            : dialect === 'mysql'
              ? 'enum(' +
                target.fields
                  .map((item) => "'" + mapped(item, item.name).replaceAll("'", "''") + "'")
                  .join(',') +
                ')'
              : mapped(target, target.name, true)
          : types[field.type.type ?? ''])
      const projectedColumn = projected.tables
        .find((item) => item.name === table && item.namespace === schema)
        ?.columns.find((item) => item.name === name)
      const expression = arg(attr(field, '@default'), 'value')
      const invocation = expression?.$type === 'InvocationExpr' ? expression : undefined
      const generator = invocation?.function.$refText
      const databaseDefault =
        generator === 'dbgenerated' ? getLiteral(invocation?.args[0]?.value) : undefined
      const persisted = projectedColumn?.default
      const defaultValue = persisted
        ? persisted.kind === 'sql'
          ? persisted.sql
          : typeof persisted.value === 'string'
            ? "'" + persisted.value.replaceAll("'", "''") + "'"
            : String(persisted.value)
        : generator === 'now'
          ? 'CURRENT_TIMESTAMP'
          : typeof databaseDefault === 'string'
            ? databaseDefault
            : generator
              ? undefined
              : expression?.$cstNode?.text
      const sequential =
        generator === 'autoincrement' ||
        (dialect === 'sqlite' &&
          !declaration.isView &&
          primary.length === 1 &&
          primary[0] === name &&
          type?.toLowerCase() === 'integer') ||
        (typeof databaseDefault === 'string' &&
          /^\s*(?:pg_catalog\.)?nextval\s*\(/i.test(databaseDefault))
      emit(attr(field, '@map') ?? field, {
        ...scope,
        kind: 'column',
        name,
        logicalName: field.name,
        type: projectedColumn?.type ?? type,
        default: defaultValue,
        nullable: field.type.optional,
        sequential,
        explicit: Boolean(attr(field, '@map')),
      })
      if (attr(field, '@unique')) {
        const unique = attr(field, '@unique')!
        const uniqueName = literal(unique, 'map')
        emit(unique, {
          ...scope,
          kind: 'unique',
          name: uniqueName ?? name,
          nameKnown: uniqueName !== undefined,
          columns: [name],
          explicit: uniqueName !== undefined,
          unique: true,
          partial: false,
        })
      }
    }
  }

  return { nodes, gaps, dialect, capabilities: ['zmodel'] }
}
