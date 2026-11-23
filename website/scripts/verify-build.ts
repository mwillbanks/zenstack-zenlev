import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacyDocPaths } from '../src/lib/doc-paths'
import { canonicalUrl, normalizeBase, siteDescription } from '../src/lib/site'
import { documentationPages } from './documents'

const root = join(import.meta.dirname, '../.output/public')
const docs = join(import.meta.dirname, '../content/docs')
const base = normalizeBase(process.env.VITE_BASE_PATH ?? '/zenstack-zenlev/')
const pages = documentationPages(docs)
const docRoutes = pages.map((page) => page.route)
const legacyRoutes = Object.keys(legacyDocPaths).map((slug) => '/docs/' + slug)
const expected = [
  'index.html',
  'logo.svg',
  '.nojekyll',
  'api/search',
  'llms.txt',
  'robots.txt',
  'sitemap.xml',
  ...[...docRoutes, ...legacyRoutes].map((route) => join(route.slice(1), 'index.html')),
]
const missing = expected.filter((path) => !existsSync(join(root, path)))
if (missing.length) throw new Error('Missing static output: ' + missing.join(', '))
const html = readFileSync(join(root, 'index.html'), 'utf8')
if (!html.includes('Migrations with')) throw new Error('Home page was not prerendered')
for (const label of ['Preview ledger', 'Production ledger', 'Backfill v2', 'Supersedes']) {
  if (!html.includes('>' + label + '<')) throw new Error('Missing homepage graph label: ' + label)
}
for (const [slug, labels] of [
  ['graph', ['Original dependency', 'Effective dependency']],
  ['rollback-recovery', ['Cascade Backfill rows', 'Compensate Backfill rows']],
] as const) {
  const guide = readFileSync(join(root, 'docs', 'guides', slug, 'index.html'), 'utf8')
  for (const label of labels) {
    if (!guide.includes('>' + label + '<')) throw new Error('Missing guide diagram label: ' + label)
  }
}
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
  const href = canonicalUrl('/docs/' + canonical, base)
  if (!content.includes('rel="canonical" href="' + href + '"'))
    throw new Error('Missing canonical link for ' + alias)
}
if (JSON.stringify(search).includes('_skills')) throw new Error('Skill sources appear in search')

function verifyMetadata(route: string, title: string, description: string, canonicalRoute = route) {
  const content = readFileSync(join(root, route.slice(1), 'index.html'), 'utf8')
  const escapedTitle = Bun.escapeHTML(title)
  const escapedDescription = Bun.escapeHTML(description)
  const url = canonicalUrl(canonicalRoute, base)
  if (
    Array.from(content.matchAll(/<title>/g)).length !== 1 ||
    !content.includes('<title>' + escapedTitle + '</title>')
  )
    throw new Error('Invalid page title on ' + route)
  for (const tag of [
    'name="description" content="' + escapedDescription + '"',
    'property="og:title" content="' + escapedTitle + '"',
    'property="og:description" content="' + escapedDescription + '"',
    'property="og:url" content="' + url + '"',
    'name="twitter:card" content="summary"',
    'name="twitter:title" content="' + escapedTitle + '"',
    'name="twitter:description" content="' + escapedDescription + '"',
    'rel="canonical" href="' + url + '"',
  ]) {
    if (!content.includes(tag)) throw new Error('Missing metadata on ' + route + ': ' + tag)
  }
  if (Array.from(content.matchAll(/rel="canonical"/g)).length !== 1)
    throw new Error('Duplicate canonical on ' + route)
}
verifyMetadata('/', 'Zenlev — TypeScript migrations for ZenStack V3', siteDescription)
const metadata = { titles: new Set<string>(), descriptions: new Set([siteDescription]) }
for (const page of pages) {
  if (metadata.titles.has(page.title)) throw new Error('Duplicate title on ' + page.route)
  if (metadata.descriptions.has(page.description))
    throw new Error('Duplicate documentation description on ' + page.route)
  metadata.titles.add(page.title)
  metadata.descriptions.add(page.description)
  verifyMetadata(page.route, page.title + ' | Zenlev', page.description)
}
for (const [alias, destination] of Object.entries(legacyDocPaths)) {
  const page = pages.find((candidate) => candidate.route === '/docs/' + destination)
  if (!page) throw new Error('Missing alias destination: ' + destination)
  verifyMetadata('/docs/' + alias, page.title + ' | Zenlev', page.description, page.route)
}
const canonicalRoutes = new Set(['/', ...docRoutes].map((route) => canonicalUrl(route, base)))
const sitemap = readFileSync(join(root, 'sitemap.xml'), 'utf8')
const locations = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1]!)
if (
  locations.length !== canonicalRoutes.size ||
  new Set(locations).size !== locations.length ||
  locations.some((location) => !canonicalRoutes.has(location))
)
  throw new Error('Sitemap does not match the published canonical route inventory')
const robots = readFileSync(join(root, 'robots.txt'), 'utf8')
if (
  robots !==
  'User-agent: *\nAllow: ' + base + '\n\nSitemap: ' + canonicalUrl('/', base) + 'sitemap.xml\n'
)
  throw new Error('Invalid robots.txt or sitemap location')
const llms = readFileSync(join(root, 'llms.txt'), 'utf8')
if (
  !llms.startsWith('# Zenlev\n') ||
  !llms.includes(canonicalUrl('/docs/guides/agent-skills', base))
)
  throw new Error('Missing llms.txt title or agent skills guide')
const llmsLinks = Array.from(llms.matchAll(/\]\((https:[^)]+)\)/g), (match) => match[1]!)
if (!llmsLinks.length || llmsLinks.some((url) => !canonicalRoutes.has(url)))
  throw new Error('llms.txt contains a noncanonical or unpublished link')
if (
  sitemap.includes('_skills') ||
  llms.includes('_skills') ||
  existsSync(join(root, 'docs/guides/_skills'))
)
  throw new Error('Skill sources were published as documentation')
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
