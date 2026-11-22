import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export function baseOptions(): BaseLayoutProps {
  return {
    githubUrl: 'https://github.com/mwillbanks/zenstack-zenlev',
    nav: {
      title: (
        <span className="brand">
          <img src={import.meta.env.BASE_URL + 'logo.svg'} width="32" height="32" alt="" />
          Zenlev
        </span>
      ),
    },
  }
}
