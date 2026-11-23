import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalUrl, normalizeBase, siteDescription } from '../src/lib/site'
import { documentationPages } from './documents'

const root = join(import.meta.dirname, '..')
const output = join(root, '.output/public')
const base = normalizeBase(process.env.VITE_BASE_PATH ?? '/zenstack-zenlev/')
const pages = documentationPages(join(root, 'content/docs'))
const routes = ['/', ...pages.map((page) => page.route)]
const escapeXml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...routes.map((route) => '  <url><loc>' + escapeXml(canonicalUrl(route, base)) + '</loc></url>'),
  '</urlset>',
  '',
].join('\n')
writeFileSync(join(output, 'sitemap.xml'), sitemap)
writeFileSync(
  join(output, 'robots.txt'),
  'User-agent: *\nAllow: ' + base + '\n\nSitemap: ' + canonicalUrl('/', base) + 'sitemap.xml\n',
)

const sections = {
  'Start here': ['/docs', '/docs/guides/quick-start', '/docs/guides/agent-skills'],
  'Plan and run migrations': [
    '/docs/guides/migrations',
    '/docs/guides/graph',
    '/docs/guides/namespaces',
    '/docs/guides/deployments',
    '/docs/guides/schema-changes',
  ],
  'Rollback and recovery': [
    '/docs/guides/rollback-recovery',
    '/docs/guides/baseline',
    '/docs/guides/adoption',
  ],
  Reference: [
    '/docs/reference/configuration',
    '/docs/reference/commands',
    '/docs/reference/api',
    '/docs/dialects',
  ],
}
const llms = ['# Zenlev', '', '> ' + siteDescription, '']
for (const [heading, selected] of Object.entries(sections)) {
  llms.push('## ' + heading, '')
  for (const route of selected) {
    const page = pages.find((candidate) => candidate.route === route)
    if (!page) throw new Error('Missing llms.txt page ' + route)
    llms.push('- [' + page.title + '](' + canonicalUrl(route, base) + ') — ' + page.description)
  }
  llms.push('')
}
writeFileSync(join(output, 'llms.txt'), llms.join('\n'))
