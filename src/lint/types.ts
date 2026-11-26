import type { Kysely } from 'kysely'
import type { Environment } from '../types'

export interface LintSource {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly endLine?: number
  readonly endColumn?: number
  readonly fingerprint?: string
}

export interface LintGap {
  readonly message: string
  readonly source?: LintSource | undefined
  readonly identity?: string | undefined
}

export interface LintNode {
  readonly kind: string
  readonly name: string
  readonly dialect?: string | undefined
  readonly schema?: string | undefined
  readonly table?: string | undefined
  readonly identity?: string | undefined
  readonly source?: LintSource | undefined
  readonly origin: 'zmodel' | 'sql' | 'migration' | 'catalog' | 'application'
  readonly action?:
    | undefined
    | 'create'
    | 'replace'
    | 'alter'
    | 'drop'
    | 'call'
    | 'rename'
    | 'enable'
    | 'disable'
    | 'force'
    | 'no-force'
  readonly logicalName?: string | undefined
  readonly spelling?: string | undefined
  readonly quoted?: boolean | undefined
  readonly generated?: boolean | undefined
  readonly explicit?: boolean | undefined
  readonly nameKnown?: boolean | undefined
  readonly checksKnown?: boolean | undefined
  readonly columns?: readonly string[] | undefined
  readonly type?: string | undefined
  readonly default?: string | undefined
  readonly nullable?: boolean | undefined
  readonly sequential?: boolean | undefined
  readonly unique?: boolean | undefined
  readonly targetTable?: string | undefined
  readonly targetSchema?: string | undefined
  readonly targetColumns?: readonly string[] | undefined
  readonly signature?: string | undefined
  readonly language?: string | undefined
  readonly security?: string | undefined
  readonly searchPath?: readonly string[] | undefined
  readonly partial?: boolean | undefined
  readonly command?: string | undefined
  readonly roles?: readonly string[] | undefined
  readonly using?: string | null | undefined
  readonly check?: string | null | undefined
  readonly enabled?: boolean | undefined
  readonly forced?: boolean | undefined
  readonly permissive?: boolean | undefined
}

export interface LintInput {
  readonly dialect?: string | undefined
  readonly defaultSchema?: string | undefined
  readonly nodes: readonly LintNode[]
  readonly gaps: readonly LintGap[]
  readonly capabilities?: readonly string[] | undefined
}

export interface LintReport {
  readonly node: LintNode
  readonly anchor?: LintNode | undefined
  readonly messageId: string
  readonly data?: Readonly<Record<string, string | number>>
}

export interface LintRuleContext {
  readonly options: readonly unknown[]
  readonly nodes: readonly LintNode[]
  readonly capabilities: readonly string[]
  report(report: LintReport): void
  gap(message: string, node?: LintNode, anchor?: LintNode): void
}

export type LintVisitors = Readonly<Record<string, (node: LintNode) => void>>

export interface LintRule {
  readonly meta: {
    readonly schema?: readonly object[]
    readonly messages: Readonly<Record<string, string>>
    readonly description?: string
  }
  create(context: LintRuleContext): LintVisitors
}

export interface LintRulePlugin {
  readonly meta: { readonly name: string }
  readonly rules: Readonly<Record<string, LintRule>>
}

export type LintPluginSpecifier =
  string | { readonly name?: string; readonly specifier: string } | LintRulePlugin
export type LintSeverity = 'off' | 'warn' | 'error'
export type LintRuleSetting = LintSeverity | readonly [LintSeverity, ...unknown[]]
export type LintRuleSettings = Readonly<Record<string, LintRuleSetting>>

export interface LintSelector {
  readonly files?: readonly string[]
  readonly kinds?: readonly string[]
  readonly origins?: readonly LintNode['origin'][]
  readonly dialects?: readonly string[]
  readonly identities?: readonly string[]
}

export interface LintOverride extends LintSelector {
  readonly rules: LintRuleSettings
}

export interface LintException {
  readonly ruleId: string
  readonly reason: string
  readonly identity?: string
  readonly fingerprint?: string
}

export interface LintCatalogContext {
  readonly physical: Kysely<any>
  readonly dialect: string
  readonly namespaces?: readonly string[] | undefined
}

export interface LintCatalogProvider {
  readonly dialect: string
  connect?(
    environment: Environment,
  ):
    | { readonly physical: Kysely<any>; dispose(): void | Promise<void> }
    | Promise<{ readonly physical: Kysely<any>; dispose(): void | Promise<void> }>
  read(context: LintCatalogContext): LintInput | Promise<LintInput>
}

export interface LintConfig {
  readonly presets?: readonly string[]
  readonly rules?: LintRuleSettings
  readonly dialect?: string
  readonly zmodel?: boolean
  readonly migrations?: boolean
  readonly sql?: readonly string[]
  readonly source?: readonly string[]
  readonly namespaces?: readonly string[]
  readonly overrides?: readonly LintOverride[]
  readonly plugins?: readonly LintPluginSpecifier[]
  readonly exceptions?: readonly LintException[]
  readonly catalog?: LintCatalogProvider
}

export interface LintOptions {
  readonly live?: boolean
  readonly maxWarnings?: number
}

export interface LintDiagnostic extends LintGap {
  readonly ruleId: string
  readonly severity: Exclude<LintSeverity, 'off'>
  readonly fingerprint?: string
}

export interface LintResult {
  readonly status: 'ok' | 'failed'
  readonly diagnostics: readonly LintDiagnostic[]
  readonly coverage: { readonly capabilities: readonly string[]; readonly gaps: readonly LintGap[] }
  readonly suppressed: number
  readonly staleExceptions: readonly LintException[]
  readonly files: number
}
