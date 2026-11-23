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

Record user-visible changes under `[Unreleased]` in `CHANGELOG.md`. Keep entries focused on user impact. Write or update the corresponding release notes under `website/content/docs/releases/` when preparing a version.

Release Please opens the release pull request from `main` and proposes the version. Before merging it, move the shipped entries to a versioned changelog section, add an empty `[Unreleased]` section, and add the versioned MDX page to the release notes navigation. Use the heading `## [<version>] - YYYY-MM-DD` in the changelog. Review the release pull request and its CI results before merging. Its merge authorizes GitHub Actions to tag the version and publish the qualified archive to npm with provenance.

Configure the npm trusted publisher for `mwillbanks/zenstack-zenlev` and `release.yml`. Use a repository-scoped `RELEASE_PLEASE_TOKEN` for Release Please when release pull requests must trigger CI automatically. If using the default GitHub token, allow Actions to create pull requests and run or approve the release PR checks as needed. The npm publish job uses GitHub OIDC.

Dispatch Release from `main` with dry run enabled to qualify the package. Supply an existing tag such as `v0.1.0` to qualify that exact GitHub release. To recover npm publication, dispatch the same tag with dry run disabled after reviewing the qualified archive.

## Pull requests

Describe the user-visible behavior and migration compatibility. Include focused tests for changed behavior. Do not include secrets, generated bundles, local database files, or coverage output.
