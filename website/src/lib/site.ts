export const siteOrigin = 'https://mwillbanks.github.io'
export const siteDescription =
  'Plan TypeScript database migrations with explicit dependencies, deployment namespaces, and your configured ZenStack V3 or Kysely client.'

export function normalizeBase(base: string): string {
  return '/' + base.split('/').filter(Boolean).join('/') + (base === '/' ? '' : '/')
}

export function canonicalUrl(path: string, base: string): string {
  const suffix = path.split('/').filter(Boolean).join('/')
  return siteOrigin + normalizeBase(base) + (suffix ? suffix + '/' : '')
}

export function pageHead(title: string, description: string, path: string, base: string) {
  const url = canonicalUrl(path, base)
  return {
    links: [{ rel: 'canonical', href: url }],
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Zenlev' },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: url },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
    ],
  }
}
