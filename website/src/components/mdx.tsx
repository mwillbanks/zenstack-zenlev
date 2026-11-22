import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    a: ({ href, ...props }) => {
      const target = href?.startsWith('./')
        ? import.meta.env.BASE_URL + 'docs/' + href.slice(2)
        : href
      return <a href={target} {...props} />
    },
    ...components,
  } satisfies MDXComponents
}

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}
