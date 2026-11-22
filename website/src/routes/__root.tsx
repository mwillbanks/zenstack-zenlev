import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { RootProvider } from 'fumadocs-ui/provider/tanstack'
import StaticSearchDialog from '@/components/search'
import appCss from '@/styles/app.css?url'

export const Route = createRootRoute({
  component: Root,
  head: () => ({
    links: [
      { href: appCss, rel: 'stylesheet' },
      { href: import.meta.env.BASE_URL + 'logo.svg', rel: 'icon', type: 'image/svg+xml' },
    ],
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Zenlev — migrations with a direction' },
      {
        name: 'description',
        content:
          'TypeScript migrations, explicit dependency graphs, and your configured ZenStack client. Built for Bun.',
      },
      { name: 'theme-color', content: '#121212' },
    ],
  }),
})

function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <RootProvider search={{ SearchDialog: StaticSearchDialog }}>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  )
}
