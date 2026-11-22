import { existsSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { parseSync } from 'oxc-parser'

type Token = { type: string; start: number; [key: string]: unknown }
const sourceExtension = /^\.[cm]?[jt]sx?$/
const realTimers = new Set([
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
  'requestIdleCallback',
  'setTimeoutPromise',
  'sleep',
  'sleepSync',
  'nanoseconds',
  'hrtime',
  'performance',
])
const timerModule = /^(?:node:)?(?:timers(?:\/promises)?|perf_hooks)$/
const fixtures = /(?:^|\/)test\/integration(?:\/|$)/
const root = resolve(import.meta.dir, '..')

function token(value: unknown): Token | undefined {
  return value && typeof value === 'object' && 'type' in value ? (value as Token) : undefined
}

function name(value: unknown): string | undefined {
  const node = token(value)
  const name = node?.name ?? node?.value
  return typeof name === 'string' ? name : undefined
}

export function inspectTiming(file: string, source: string) {
  const { program, errors } = parseSync(file, source)
  const imports: string[] = []
  const faults: string[] = errors.map((error) => error.message)
  const report = (node: Token, message: string) => {
    faults.push(source.slice(0, node.start).split('\n').length + ': ' + message)
  }
  function visit(node: Token, parent?: Token): void {
    if (node.importKind === 'type' || node.exportKind === 'type') return
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ImportExpression' ||
      (node.type === 'CallExpression' && name(node.callee) === 'require')
    ) {
      const specifier = name(node.source ?? (node.arguments as unknown[] | undefined)?.[0])
      if (specifier !== undefined) {
        if (timerModule.test(specifier))
          report(node, 'Use an injected clock or a deterministic timer')
        if (specifier.startsWith('.')) imports.push(specifier)
      }
    }
    const spyTarget =
      parent?.type === 'CallExpression' &&
      name(parent.callee) === 'spyOn' &&
      (parent.arguments as unknown[])[0] === node
    if (!spyTarget && node.type === 'Identifier' && realTimers.has(String(node.name))) {
      report(node, 'Use an injected clock or a deterministic timer instead of ' + node.name)
    }
    if (!spyTarget && node.type === 'Identifier' && node.name === 'Date') {
      if (parent?.type === 'TSAnnotation' || parent?.type === 'TSTypeReference') return
      const fixed =
        parent?.type === 'NewExpression' &&
        parent.callee === node &&
        (parent.arguments as unknown[]).length > 0
      if (!fixed) report(node, 'Construct dates from fixed input or an injected clock')
    }
    if (node.type === 'MemberExpression' && node.computed) {
      const property = name(node.property)
      if (property && (realTimers.has(property) || property === 'Date'))
        report(node, 'Access a deterministic time abstraction')
    }
    if (node.type === 'WhileStatement' && token(node.body)?.type === 'EmptyStatement')
      report(node, 'Use a deferred gate instead of busy-waiting')
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        const next = token(child)
        if (next) visit(next, node)
      }
    }
  }
  visit(program as unknown as Token)
  return { imports, faults }
}

function resolveImport(parent: string, specifier: string): string | undefined {
  const base = resolve(dirname(parent), specifier)
  const renamed = base.replace(/\.[cm]?jsx?$/, '.ts')
  return [base, renamed, base + '.ts', base + '.tsx', resolve(base, 'index.ts')].find(
    (candidate) => sourceExtension.test(extname(candidate)) && existsSync(candidate),
  )
}

export async function checkTimingFiles(entries: readonly string[]) {
  const checked = new Set<string>()
  const faults: string[] = []
  async function visit(file: string) {
    if (checked.has(file)) return
    checked.add(file)
    const label = relative(root, file)
    if (fixtures.test(label)) {
      faults.push(label + ': Unit suites cannot import integration fixtures')
      return
    }
    if (label.startsWith('src/') || label.startsWith('../')) return
    const result = inspectTiming(file, await Bun.file(file).text())
    faults.push(...result.faults.map((fault) => label + ':' + fault))
    for (const specifier of result.imports) {
      const imported = resolveImport(file, specifier)
      if (imported) await visit(imported)
    }
  }
  for (const entry of entries) await visit(entry)
  return faults
}

if (import.meta.main) {
  const entries = Array.from(
    new Bun.Glob('**/*.{test,spec}.{ts,tsx,js,mjs}').scanSync(resolve(root, 'test')),
  )
    .filter((entry) => !entry.startsWith('integration/') && !entry.startsWith('.zenlev-'))
    .map((entry) => resolve(root, 'test', entry))
  const faults = await checkTimingFiles(entries)
  if (faults.length > 0) {
    console.error(faults.join('\n'))
    process.exitCode = 1
  }
}
