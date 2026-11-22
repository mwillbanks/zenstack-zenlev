import { chmod, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const outdir = resolve(root, 'dist')
await rm(outdir, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/index.ts'), resolve(root, 'src/cli.ts')],
  outdir,
  root: resolve(root, 'src'),
  target: 'bun',
  format: 'esm',
  packages: 'external',
  splitting: true,
  sourcemap: 'external',
  naming: {
    entry: '[name].js',
    chunk: 'chunks/[name]-[hash].js',
    asset: '[name]-[hash].[ext]',
  },
})
if (!result.success) throw new AggregateError(result.logs, 'Zenlev bundle failed')

const declaration = Bun.spawn(
  [
    process.execPath,
    '--bun',
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    resolve(root, 'tsconfig.build.json'),
  ],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' },
)
if ((await declaration.exited) !== 0) throw new Error('Zenlev declaration generation failed')

const cli = resolve(outdir, 'cli.js')
const source = await Bun.file(cli).text()
if (!source.startsWith('#!/usr/bin/env bun\n')) {
  await Bun.write(cli, '#!/usr/bin/env bun\n' + source.replace(/^#![^\n]*\n/, ''))
}
await chmod(cli, 0o755)
