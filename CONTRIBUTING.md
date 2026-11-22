# Contributing

## Development setup

Use Bun 1.4.4 and install the locked dependencies.

```sh
bun install --frozen-lockfile
```

## Changes

Keep the graph engine portable and place ZenStack, database, CLI, and terminal integrations behind clear interfaces. Follow the existing formatting and strict TypeScript configuration. Do not add dependencies unless the change needs them.

## Validation

Run the repository checks before opening a pull request.

```sh
bun run verify
bun run build
bun run pack:check
```

Use fresh SQLite fixtures, isolated temporary directories, and Bun mocks for external interfaces. Close fixtures and restore mocks in teardown. Control time and asynchronous completion with fixed clocks and deferred promises. The static timing gate checks unit tests and their helpers.

Run `bun run verify:coverage` with `ZENLEV_TEST_POSTGRES_URL` and `ZENLEV_TEST_MYSQL_URL` set to dedicated test databases. The suite owns fixture tables and the default `zenlev` ledger namespace in those databases. The coverage gate checks 95% per file for lines and functions and checks that LCOV includes shipped runtime sources.

Install documentation dependencies with `bun install --cwd website --frozen-lockfile`. Run `typecheck`, `lint`, `build`, and `verify:build` from `website`.

## Releases

Configure the npm trusted publisher with this repository and the `release.yml` workflow. Give GitHub Actions the repository permissions needed to create tags and GitHub releases. Configure GitHub Pages to use GitHub Actions before dispatching the Pages workflow.

Dispatch the release workflow on `main` with the intended version or semver increment. Use its default dry run to qualify the release path. The live run creates the tag and GitHub release, qualifies the exact tagged revision, and publishes the tested tarball to npm with provenance.

To recover an interrupted publication, dispatch the workflow with the existing exact tag, such as `v0.1.0`. Run in dry mode first. It checks the tag, version, GitHub release, and tarball integrity. After review, dispatch for the same tag with dry mode disabled.

## Pull requests

Describe the user-visible behavior and migration compatibility. Include focused tests for changed behavior. Do not include secrets, generated bundles, local database files, or coverage output.
