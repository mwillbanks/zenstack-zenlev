import { resolve } from 'node:path'
import { parseSync } from 'oxc-parser'

const cwd = resolve(import.meta.dir, '..')
const report = await Bun.file(resolve(cwd, 'coverage/lcov.info')).text()
const included = new Set(
  report
    .split('\n')
    .filter((line) => line.startsWith('SF:'))
    .map((line) => resolve(cwd, line.slice(3))),
)
const missing: string[] = []
for (const relative of new Bun.Glob('src/**/*.ts').scanSync(cwd)) {
  if (relative.endsWith('.d.ts')) continue
  const file = resolve(cwd, relative)
  if (included.has(file)) continue
  const { program, errors } = parseSync(file, await Bun.file(file).text())
  if (errors.length) throw new Error('Could not parse ' + relative)
  const runtime = program.body.some((node) => {
    if (node.type === 'ImportDeclaration') return node.importKind !== 'type'
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      return node.exportKind !== 'type'
    return node.type !== 'TSInterfaceDeclaration' && node.type !== 'TSTypeAliasDeclaration'
  })
  if (runtime) missing.push(relative)
}
if (missing.length > 0) {
  console.error('Shipped runtime files missing from LCOV:\n' + missing.sort().join('\n'))
  process.exitCode = 1
}
