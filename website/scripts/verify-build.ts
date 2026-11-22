import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacyDocPaths } from '../src/lib/doc-paths'

const root = join(import.meta.dirname, '../.output/public')
const docs = join(import.meta.dirname, '../content/docs')
const configuredBase = process.env.VITE_BASE_PATH ?? '/zenstack-zenlev/'
const base = configuredBase.endsWith('/') ? configuredBase : configuredBase + '/'
const docRoutes = Array.from(new Bun.Glob('**/*.mdx').scanSync(docs), (file) =>
  [
    '/docs',
    ...file
      .split(sep)
      .join('/')
      .replace(/(?:^|\/)index\.mdx$|\.mdx$/g, '')
      .split('/')
      .filter(Boolean),
  ].join('/'),
)
const legacyRoutes = Object.keys(legacyDocPaths).map((slug) => '/docs/' + slug)
const expected = [
  'index.html',
  'logo.svg',
  '.nojekyll',
  'api/search',
  ...[...docRoutes, ...legacyRoutes].map((route) => join(route.slice(1), 'index.html')),
]
const missing = expected.filter((path) => !existsSync(join(root, path)))
if (missing.length) throw new Error('Missing static output: ' + missing.join(', '))
const html = readFileSync(join(root, 'index.html'), 'utf8')
if (!html.includes('Migrations with')) throw new Error('Home page was not prerendered')
const search = JSON.parse(readFileSync(join(root, 'api/search'), 'utf8'))
if (search?.type !== 'advanced' || !Array.isArray(search.internalDocumentIDStore?.internalIdToId))
  throw new Error('Search index is invalid')
const indexedIds = new Set(search.internalDocumentIDStore.internalIdToId)
for (const route of docRoutes) {
  if (!indexedIds.has(route)) throw new Error('Page missing from search: ' + route)
}
for (const [alias, canonical] of Object.entries(legacyDocPaths)) {
  if (indexedIds.has('/docs/' + alias)) throw new Error('Legacy URL appears in search: ' + alias)
  const content = readFileSync(join(root, 'docs', alias, 'index.html'), 'utf8')
  const href = base + 'docs/' + canonical + '/'
  if (!content.includes('rel="canonical" href="' + href + '"'))
    throw new Error('Missing canonical link for ' + alias)
}
const overview = readFileSync(join(root, 'docs/index.html'), 'utf8')
const sidebar = /<aside id="nd-sidebar"[^>]*>([\s\S]*?)<\/aside>/.exec(overview)?.[1] ?? ''
for (const group of ['Guides', 'Reference', 'Dialect examples']) {
  if (!sidebar.includes('>' + group + '<')) throw new Error('Missing navigation group: ' + group)
}
for (const anchor of ['a-deliberate-migration-workflow', 'database-connections']) {
  if (!overview.includes(' id="' + anchor + '"'))
    throw new Error('Missing overview anchor: ' + anchor)
}
if (Array.from(overview.matchAll(/<figcaption\b/g)).length < 2)
  throw new Error('The documentation overview diagrams were not prerendered')
for (const page of expected.filter((path) => path.endsWith('.html'))) {
  const content = readFileSync(join(root, page), 'utf8')
  if (!content.includes(base + 'logo.svg')) throw new Error('Missing favicon on ' + page)
  for (const match of content.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1]!
    if (!target.startsWith('/') || target.startsWith('//')) continue
    const url = new URL(target, 'https://zenlev.invalid')
    if (!url.pathname.startsWith(base))
      throw new Error('Link escapes repository base on ' + page + ': ' + target)
    const path = join(root, decodeURIComponent(url.pathname.slice(base.length)))
    if (!existsSync(path) && !existsSync(join(path, 'index.html')))
      throw new Error('Missing local link or asset on ' + page + ': ' + target)
    if (url.hash && url.pathname.startsWith(base + 'docs/')) {
      const linkedPage = readFileSync(join(path, 'index.html'), 'utf8')
      const fragment = Bun.escapeHTML(decodeURIComponent(url.hash.slice(1)))
      if (!linkedPage.includes(' id="' + fragment + '"'))
        throw new Error('Missing documentation anchor on ' + page + ': ' + target)
    }
  }
}

const css = readFileSync(join(import.meta.dirname, '../src/styles/app.css'), 'utf8')
const defaults = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.resolve('fumadocs-ui/css/neutral.css'))),
    'lib/default-colors.css',
  ),
  'utf8',
)
function declarations(source: string, selector: string) {
  const body = source.split(selector + ' {')[1]?.split('}')[0]
  if (!body) throw new Error('Missing color selector: ' + selector)
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]),
  )
}
function luminance(color: string): number {
  let channels: number[]
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
    channels = [0, 2, 4].map(
      (offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255,
    )
  } else {
    const match = /^hsl\(0, 0%, ([\d.]+)%\)$/.exec(color)
    if (!match) throw new Error('Unsupported contrast color: ' + color)
    channels = Array(3).fill(Number(match[1]) / 100)
  }
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}
for (const [selector, inherited] of [
  [':root', '@theme'],
  ['.dark', '.dark'],
]) {
  const colors = { ...declarations(defaults, inherited!), ...declarations(css, selector!) }
  for (const [foreground, background] of [
    ['--zenlev-accent', '--color-fd-background'],
    ['--color-fd-primary-foreground', '--color-fd-primary'],
  ]) {
    const a = luminance(colors[foreground!]!)
    const b = luminance(colors[background!]!)
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    if (contrast < 4.5)
      throw new Error(selector + ' ' + foreground + ' contrast below 4.5: ' + contrast)
  }
}
console.log('Static pages, repository links, assets, search, and brand contrast verified')
