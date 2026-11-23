import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

export function documentationPages(directory: string) {
  return Array.from(new Bun.Glob('**/*.mdx').scanSync(directory))
    .map((path) => path.split(sep).join('/'))
    .filter((path) => !path.split('/').some((part) => part.startsWith('_')))
    .sort()
    .map((path) => {
      const text = readFileSync(join(directory, path), 'utf8')
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
      if (!frontmatter) throw new Error('Missing frontmatter in ' + path)
      const data = Bun.YAML.parse(frontmatter[1]!) as Record<string, unknown>
      if (typeof data.title !== 'string' || typeof data.description !== 'string')
        throw new Error('Missing title or description in ' + path)
      const slug = path.replace(/(?:^|\/)index\.mdx$|\.mdx$/g, '')
      return {
        path,
        route: '/docs' + (slug ? '/' + slug : ''),
        title: data.title,
        description: data.description,
      }
    })
}
