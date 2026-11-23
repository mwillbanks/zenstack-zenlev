import { defineConfig, defineDocs } from 'fumadocs-mdx/config'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: { files: ['**/*.mdx', '!**/_skills/**'] },
})

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: { themes: { light: 'github-light', dark: 'github-dark' } },
  },
})
