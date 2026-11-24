import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadDocument } from '@zenstackhq/language'
import {
  isArrayExpr,
  isDataModel,
  isDataSource,
  isEnum,
  isReferenceExpr,
  type AstNode,
  type DataFieldAttribute,
  type DataModelAttribute,
  type Expression,
  type Model,
} from '@zenstackhq/language/ast'
import {
  getAllFields,
  getAttributeArg,
  getDataSourceProvider,
  getLiteral,
} from '@zenstackhq/language/utils'
import type { Dialect } from '../types'

export interface SchemaSource {
  readonly path: string
  readonly line: number
  readonly column: number
}

export interface SchemaDiagnostic {
  readonly code: string
  readonly message: string
  readonly source: SchemaSource
}

export type ColumnDefault =
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'sql'; readonly sql: string }

export interface SchemaColumn {
  readonly name: string
  readonly field: string
  readonly type: string
  readonly nullable: boolean
  readonly autoIncrement: boolean
  readonly array: boolean
  readonly default?: ColumnDefault
  readonly enumName?: string
  readonly enumNamespace?: string
}

export interface SchemaIndex {
  readonly name?: string
  readonly columns: readonly string[]
  readonly unique: boolean
  readonly constraint?: boolean
}

export type ReferentialAction = 'Cascade' | 'Restrict' | 'NoAction' | 'SetNull' | 'SetDefault'

export interface SchemaForeignKey {
  readonly name?: string
  readonly columns: readonly string[]
  readonly targetTable: string
  readonly targetNamespace?: string
  readonly targetColumns: readonly string[]
  readonly onDelete?: ReferentialAction
  readonly onUpdate?: ReferentialAction
}

export interface SchemaTable {
  readonly name: string
  readonly namespace?: string
  readonly model: string
  readonly isView: boolean
  readonly columns: readonly SchemaColumn[]
  readonly primaryKey: readonly string[]
  readonly primaryKeyName?: string
  readonly indexes: readonly SchemaIndex[]
  readonly foreignKeys: readonly SchemaForeignKey[]
}

export interface SchemaEnum {
  readonly name: string
  readonly namespace?: string
  readonly values: readonly string[]
}

export interface SchemaModel {
  readonly dialect: Dialect
  readonly sourcePath: string
  readonly namespaces: readonly string[]
  readonly tables: readonly SchemaTable[]
  readonly enums: readonly SchemaEnum[]
  readonly unsupported: readonly SchemaDiagnostic[]
  readonly warnings: readonly string[]
}

export interface LoadSchemaOptions {
  readonly cwd: string
  readonly schema?: string
  readonly excludeViews?: boolean
}

type Attribute = DataFieldAttribute | DataModelAttribute
type AttributeTarget = { readonly attributes: readonly Attribute[] }

async function existing(path: string): Promise<'file' | 'directory' | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function resolveSchemaPath(cwd: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    const path = resolve(cwd, explicit)
    if ((await existing(path)) !== 'file') throw new Error('Schema file not found: ' + path)
    return path
  }
  const packagePath = resolve(cwd, 'package.json')
  if ((await existing(packagePath)) === 'file') {
    const pkg: { zenstack?: { schema?: unknown } } = await Bun.file(packagePath).json()
    const configured = pkg.zenstack?.schema
    if (configured !== undefined) {
      if (typeof configured !== 'string' || !configured.trim()) {
        throw new TypeError('package.json zenstack.schema must be a nonempty path')
      }
      const path = resolve(cwd, configured)
      const file = (await existing(path)) === 'directory' ? resolve(path, 'schema.zmodel') : path
      if ((await existing(file)) !== 'file') throw new Error('Schema file not found: ' + file)
      return file
    }
  }
  for (const candidate of ['schema.zmodel', 'zenstack/schema.zmodel']) {
    const path = resolve(cwd, candidate)
    if ((await existing(path)) === 'file') return path
  }
  throw new Error('Schema file not found in schema.zmodel or zenstack/schema.zmodel')
}

export function attr(target: AttributeTarget, name: string): Attribute | undefined {
  return target.attributes.find((item) => item.decl.$refText === name)
}

export function arg(attribute: Attribute | undefined, name: string): Expression | undefined {
  return attribute && getAttributeArg(attribute, name)
}

export function literal(attribute: Attribute | undefined, name: string): string | undefined {
  const value = getLiteral<unknown>(arg(attribute, name))
  return typeof value === 'string' ? value : undefined
}

export function mapped(target: AttributeTarget, fallback: string, model = false): string {
  return literal(attr(target, model ? '@@map' : '@map'), 'name') ?? fallback
}

function namespace(target: AttributeTarget, dialect: Dialect): string | undefined {
  return (
    literal(attr(target, '@@schema'), 'map') ?? (dialect === 'postgresql' ? 'public' : undefined)
  )
}

export function references(expression: Expression | undefined): string[] {
  if (!expression || !isArrayExpr(expression)) return []
  return expression.items.map((item) => (isReferenceExpr(item) ? item.target.$refText : ''))
}

function source(node: AstNode, fallback: string): SchemaSource {
  const cst = node.$cstNode
  const root = cst?.root.astNode as AstNode & { $document?: { uri: { fsPath: string } } }
  return {
    path: root?.$document?.uri.fsPath ?? fallback,
    line: (cst?.range.start.line ?? 0) + 1,
    column: (cst?.range.start.character ?? 0) + 1,
  }
}

export const defaultTypes: Record<Dialect, Readonly<Record<string, string>>> = {
  sqlite: {
    String: 'text',
    Boolean: 'boolean',
    Int: 'integer',
    BigInt: 'bigint',
    Float: 'real',
    Decimal: 'decimal',
    DateTime: 'datetime',
    Bytes: 'blob',
    Json: 'json',
  },
  postgresql: {
    String: 'text',
    Boolean: 'boolean',
    Int: 'integer',
    BigInt: 'bigint',
    Float: 'double precision',
    Decimal: 'decimal(65,30)',
    DateTime: 'timestamp(3)',
    Bytes: 'bytea',
    Json: 'jsonb',
  },
  mysql: {
    String: 'varchar(191)',
    Boolean: 'boolean',
    Int: 'integer',
    BigInt: 'bigint',
    Float: 'double',
    Decimal: 'decimal(65,30)',
    DateTime: 'datetime(3)',
    Bytes: 'longblob',
    Json: 'json',
  },
}

export function nativeType(attribute: Attribute): string | undefined {
  const name = attribute.decl.$refText.slice('@db.'.length)
  const aliases: Record<string, string> = {
    VarChar: 'varchar',
    Char: 'char',
    Text: 'text',
    TinyText: 'tinytext',
    MediumText: 'mediumtext',
    LongText: 'longtext',
    Uuid: 'uuid',
    Citext: 'citext',
    Xml: 'xml',
    Inet: 'inet',
    Boolean: 'boolean',
    Int: 'integer',
    Integer: 'integer',
    SmallInt: 'smallint',
    BigInt: 'bigint',
    TinyInt: 'tinyint',
    MediumInt: 'mediumint',
    UnsignedInt: 'integer unsigned',
    UnsignedSmallInt: 'smallint unsigned',
    UnsignedBigInt: 'bigint unsigned',
    UnsignedTinyInt: 'tinyint unsigned',
    UnsignedMediumInt: 'mediumint unsigned',
    Real: 'real',
    DoublePrecision: 'double precision',
    Double: 'double',
    Float: 'float',
    Decimal: 'decimal',
    Money: 'money',
    Date: 'date',
    Time: 'time',
    Timetz: 'timetz',
    Timestamp: 'timestamp',
    Timestamptz: 'timestamptz',
    DateTime: 'datetime',
    Year: 'year',
    Json: 'json',
    JsonB: 'jsonb',
    ByteA: 'bytea',
    Binary: 'binary',
    VarBinary: 'varbinary',
    Blob: 'blob',
    TinyBlob: 'tinyblob',
    MediumBlob: 'mediumblob',
    LongBlob: 'longblob',
    Bit: 'bit',
    VarBit: 'varbit',
    Oid: 'oid',
  }
  const base = aliases[name]
  if (!base) return undefined
  const parameters = attribute.args.map(({ value }) => getLiteral<unknown>(value))
  if (
    parameters.some((item) => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)
  )
    return undefined
  return base + (parameters.length > 0 ? '(' + parameters.join(',') + ')' : '')
}

export async function loadResolvedZModel(options: LoadSchemaOptions) {
  const path = await resolveSchemaPath(options.cwd, options.schema)
  const loaded = await loadDocument(path, [], true)
  if (!loaded.success) throw new Error('Invalid ZModel schema:\n' + loaded.errors.join('\n'))
  return { path, model: loaded.model, warnings: loaded.warnings }
}

export type ResolvedZModel = Awaited<ReturnType<typeof loadResolvedZModel>>

export function projectResolvedZModel(
  { path, model, warnings }: ResolvedZModel,
  excludeViews = true,
): SchemaModel {
  return project(model, path, excludeViews, warnings)
}

export async function loadSchemaModel(options: LoadSchemaOptions): Promise<SchemaModel> {
  return projectResolvedZModel(await loadResolvedZModel(options), options.excludeViews)
}

function project(
  model: Model,
  path: string,
  excludeViews: boolean,
  warnings: readonly string[],
): SchemaModel {
  const provider = getDataSourceProvider(model)
  if (provider !== 'sqlite' && provider !== 'postgresql' && provider !== 'mysql') {
    throw new Error('Unsupported ZModel datasource provider: ' + String(provider))
  }
  const dialect: Dialect = provider
  const unsupported: SchemaDiagnostic[] = []
  const report = (node: AstNode, code: string, message: string) => {
    unsupported.push({ code, message, source: source(node, path) })
  }
  const enums = model.declarations.filter(isEnum).map((item): SchemaEnum => ({
    name: mapped(item, item.name, true),
    ...(namespace(item, dialect) ? { namespace: namespace(item, dialect)! } : {}),
    values: item.fields.map((field) => mapped(field, field.name)),
  }))
  const tables: SchemaTable[] = []
  for (const declaration of model.declarations.filter(isDataModel)) {
    if (declaration.isView) {
      if (!excludeViews)
        report(declaration, 'VIEW_DEFINITION', 'View definitions require an explicit SQL migration')
      continue
    }
    if (declaration.baseModel || attr(declaration, '@@delegate')) {
      report(declaration, 'POLYMORPHIC_MODEL', 'Polymorphic storage requires an explicit migration')
      continue
    }
    const fields = getAllFields(declaration, true)
    const tableName = mapped(declaration, declaration.name, true)
    const tableNamespace = namespace(declaration, dialect)
    const columns: SchemaColumn[] = []
    const indexes: SchemaIndex[] = []
    const foreignKeys: SchemaForeignKey[] = []
    const physicalFields = new Map(fields.map((field) => [field.name, mapped(field, field.name)]))
    const fieldNames = (names: readonly string[]) =>
      names.map((name) => physicalFields.get(name) ?? name)
    const compositeId = attr(declaration, '@@id')
    const primaryKey = compositeId
      ? fieldNames(references(arg(compositeId, 'fields')))
      : fields.filter((field) => attr(field, '@id')).map((field) => mapped(field, field.name))
    const validateIndex = (attribute: Attribute) => {
      const bad = attribute.args.find(
        (item) => !['fields', 'name', 'map'].includes(item.$resolvedParam?.name ?? item.name ?? ''),
      )
      if (
        bad ||
        (arg(attribute, 'fields')?.$type === 'ArrayExpr' &&
          (arg(attribute, 'fields') as { items: Expression[] }).items.some(
            (item) => isReferenceExpr(item) && item.args.length > 0,
          ))
      ) {
        report(
          attribute,
          'INDEX_OPTIONS',
          'Index sort, length, clustering, and algorithm options require an explicit migration',
        )
      }
    }
    if (compositeId) validateIndex(compositeId)
    for (const attribute of declaration.attributes) {
      if (['@@index', '@@unique'].includes(attribute.decl.$refText)) {
        validateIndex(attribute)
        const name = literal(attribute, 'map') ?? literal(attribute, 'name')
        indexes.push({
          ...(name ? { name } : {}),
          columns: fieldNames(references(arg(attribute, 'fields'))),
          unique: attribute.decl.$refText === '@@unique',
        })
      }
      if (attribute.decl.$refText === '@@fulltext')
        report(attribute, 'FULLTEXT_INDEX', 'Full-text indexes require an explicit migration')
    }
    for (const field of fields) {
      const target = field.type.reference?.ref
      if (target && isDataModel(target)) {
        const relation = attr(field, '@relation')
        const localFields = references(arg(relation, 'fields'))
        if (localFields.length > 0) {
          const targetFields = getAllFields(target, true)
          const targetMapping = new Map(
            targetFields.map((item) => [item.name, mapped(item, item.name)]),
          )
          const relationName = literal(relation, 'map')
          const action = (key: 'onDelete' | 'onUpdate') => {
            const expression = arg(relation, key)
            return expression && isReferenceExpr(expression)
              ? (expression.target.$refText as ReferentialAction)
              : undefined
          }
          const onDelete = action('onDelete')
          const onUpdate = action('onUpdate')
          const targetNamespace = namespace(target, dialect)
          foreignKeys.push({
            ...(relationName ? { name: relationName } : {}),
            columns: fieldNames(localFields),
            targetTable: mapped(target, target.name, true),
            ...(targetNamespace ? { targetNamespace } : {}),
            targetColumns: references(arg(relation, 'references')).map(
              (name) => targetMapping.get(name) ?? name,
            ),
            onDelete: onDelete ?? (field.type.optional ? 'SetNull' : 'Restrict'),
            onUpdate: onUpdate ?? 'Cascade',
          })
        } else if (
          field.type.array &&
          getAllFields(target, true).some(
            (item) => item.type.array && item.type.reference?.ref === declaration,
          )
        ) {
          report(
            field,
            'IMPLICIT_MANY_TO_MANY',
            'Implicit many-to-many join tables require an explicit migration',
          )
        }
        continue
      }
      if (attr(field, '@computed')) continue
      let type = defaultTypes[dialect][field.type.type ?? '']
      let enumName: string | undefined
      let enumNamespace: string | undefined
      if (target && isEnum(target)) {
        const definition = enums.find(
          (item) =>
            item.name === mapped(target, target.name, true) &&
            item.namespace === namespace(target, dialect),
        )!
        enumName = definition.name
        enumNamespace = definition.namespace
        type =
          dialect === 'postgresql'
            ? definition.name
            : dialect === 'mysql'
              ? 'enum(' +
                definition.values
                  .map((value) => "'" + value.replaceAll("'", "''") + "'")
                  .join(',') +
                ')'
              : 'text'
      }
      if (!type || field.type.unsupported || (target && !isEnum(target))) {
        report(field, 'COLUMN_TYPE', 'Column type requires an explicit migration: ' + field.name)
        continue
      }
      const native = field.attributes.find((item) => item.decl.$refText.startsWith('@db.'))
      if (native) {
        const override = nativeType(native)
        if (!override)
          report(
            native,
            'NATIVE_TYPE',
            'Native type requires an explicit migration: ' + native.decl.$refText,
          )
        else type = override
      }
      const defaultExpr = arg(attr(field, '@default'), 'value')
      let defaultValue: ColumnDefault | undefined
      let autoIncrement = false
      if (defaultExpr) {
        const value: unknown = getLiteral(defaultExpr)
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          defaultValue = { kind: 'literal', value }
        } else if (defaultExpr.$type === 'NullExpr') {
          defaultValue = { kind: 'literal', value: null }
        } else if (isReferenceExpr(defaultExpr) && defaultExpr.target.ref?.$type === 'EnumField') {
          const member = defaultExpr.target.ref
          defaultValue = { kind: 'literal', value: mapped(member, member.name) }
        } else if (defaultExpr.$type === 'InvocationExpr') {
          const name = defaultExpr.function.$refText
          if (name === 'autoincrement') autoIncrement = true
          else if (name === 'now') defaultValue = { kind: 'sql', sql: 'CURRENT_TIMESTAMP' }
          else if (name === 'dbgenerated' && defaultExpr.args[0]?.value.$type === 'StringLiteral') {
            defaultValue = { kind: 'sql', sql: defaultExpr.args[0].value.value }
          } else if (!['uuid', 'cuid', 'ulid', 'nanoid'].includes(name)) {
            report(
              defaultExpr,
              'DEFAULT_EXPRESSION',
              'Default expression requires an explicit migration: ' + name,
            )
          }
        } else
          report(
            defaultExpr,
            'DEFAULT_EXPRESSION',
            'Default expression requires an explicit migration',
          )
      }
      if (field.type.array && dialect !== 'postgresql')
        report(
          field,
          'ARRAY_COLUMN',
          'Array columns require an explicit migration for this dialect',
        )
      columns.push({
        name: mapped(field, field.name),
        field: field.name,
        type,
        nullable: field.type.optional,
        autoIncrement,
        array: field.type.array,
        ...(defaultValue ? { default: defaultValue } : {}),
        ...(enumName ? { enumName } : {}),
        ...(enumNamespace ? { enumNamespace } : {}),
      })
      const unique = attr(field, '@unique')
      if (unique) {
        validateIndex(unique)
        const name = literal(unique, 'map')
        indexes.push({
          ...(name ? { name } : {}),
          columns: [mapped(field, field.name)],
          unique: true,
        })
      }
    }
    const primaryField = fields.find((field) => attr(field, '@id'))
    const primaryKeyName =
      literal(compositeId, 'map') ??
      literal(primaryField ? attr(primaryField, '@id') : undefined, 'map')
    const duplicate = columns.find(
      (column, index) => columns.findIndex((other) => other.name === column.name) !== index,
    )
    if (duplicate)
      report(declaration, 'DUPLICATE_COLUMN', 'Multiple fields map to column ' + duplicate.name)
    if (tables.some((table) => table.name === tableName && table.namespace === tableNamespace))
      report(declaration, 'DUPLICATE_TABLE', 'Multiple models map to table ' + tableName)
    tables.push({
      name: tableName,
      ...(tableNamespace ? { namespace: tableNamespace } : {}),
      model: declaration.name,
      isView: false,
      columns,
      primaryKey,
      ...(primaryKeyName ? { primaryKeyName } : {}),
      indexes,
      foreignKeys,
    })
  }
  const datasource = model.declarations.find(isDataSource)
  const declaredNamespaces = datasource?.fields.find((field) => field.name === 'schemas')?.value
  const names =
    declaredNamespaces?.$type === 'ConfigArrayExpr'
      ? declaredNamespaces.items
          .filter((item) => item.$type === 'StringLiteral')
          .map((item) => item.value as string)
      : []
  return {
    dialect,
    sourcePath: path,
    namespaces: [
      ...new Set([
        ...names,
        ...tables.flatMap((table) => (table.namespace ? [table.namespace] : [])),
      ]),
    ].sort(),
    tables: tables.sort((a, b) =>
      ((a.namespace ?? '') + '.' + a.name).localeCompare((b.namespace ?? '') + '.' + b.name),
    ),
    enums,
    unsupported,
    warnings,
  }
}
