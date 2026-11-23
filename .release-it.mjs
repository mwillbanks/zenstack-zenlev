import { fileURLToPath } from 'node:url'

const preset = fileURLToPath(import.meta.resolve('conventional-changelog-conventionalcommits'))

export default {
  $schema: 'https://unpkg.com/release-it/schema/release-it.json',
  git: {
    requireBranch: 'main',
    requireCleanWorkingDir: true,
    commitMessage: 'chore: release v${version}',
    tagName: 'v${version}',
    push: true,
  },
  github: {
    release: true,
    releaseName: 'v${version}',
  },
  npm: {
    publish: false,
  },
  plugins: {
    '@release-it/conventional-changelog': {
      preset: {
        name: preset,
      },
      infile: 'CHANGELOG.md',
    },
  },
  hooks: {
    'after:bump': [
      'bun fmt CHANGELOG.md package.json',
      'bun install --lockfile-only --ignore-scripts',
    ],
    'before:git:release': ['bun run verify:coverage', 'bun run build', 'bun run pack:check'],
  },
}
