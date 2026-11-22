import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    basepath: import.meta.env.BASE_URL.replace(/\/$/, '') || '/',
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultNotFoundComponent: () => (
      <main className="missing-page">
        <h1>Page not found</h1>
        <a href={import.meta.env.BASE_URL + 'docs'}>Open the documentation</a>
      </main>
    ),
  })
}
