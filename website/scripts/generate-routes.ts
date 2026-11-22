import { resolve } from 'node:path'
import { Generator, getConfig } from '@tanstack/router-generator'

const root = resolve(import.meta.dirname, '..')
const config = getConfig(
  {
    target: 'react',
    routesDirectory: './src/routes',
    generatedRouteTree: './src/routeTree.gen.ts',
    quoteStyle: 'single',
    semicolons: false,
    disableLogging: true,
    routeTreeFileFooter: [
      "import type { getRouter } from './router'",
      "declare module '@tanstack/react-start' {",
      '  interface Register {',
      '    ssr: true',
      '    router: Awaited<ReturnType<typeof getRouter>>',
      '  }',
      '}',
    ],
  },
  root,
)

await new Generator({ config, root }).run()
