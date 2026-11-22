import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import mdx from 'fumadocs-mdx/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { legacyDocPaths } from './src/lib/doc-paths'

const base = process.env.VITE_BASE_PATH ?? '/zenstack-zenlev/'

export default defineConfig({
  base: base.endsWith('/') ? base : base + '/',
  plugins: [
    mdx(),
    tailwindcss(),
    tanstackStart({
      pages: [
        { path: '/' },
        { path: '/docs' },
        { path: '/api/search' },
        ...Object.keys(legacyDocPaths).map((slug) => ({
          path: base.replace(/\/$/, '') + '/docs/' + slug,
        })),
      ],
      spa: { enabled: true, prerender: { enabled: true, crawlLinks: true } },
    }),
    react(),
    nitro(),
  ],
  resolve: { tsconfigPaths: true },
  server: { fs: { allow: [resolve(import.meta.dirname, '..')] } },
})
