# Changelog

All notable changes to Zenlev are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0) and uses semantic versioning.

## [Unreleased]

### Added

- Ship offline and live database linting with recommended ZModel mapping and primary-key rules, configurable conventions, and lint rule plugins.
- Add `lintPlugin()` and a final-plan write hook that can reject migration apply and schema push before user SQL executes.
- Document lint adoption, catalog capabilities, rule configuration, custom plugins, and reviewed exceptions.
- Ship the database linting skill and publish an individual configuration and example page for every built-in rule.

### Changed

- Represent supported Kysely migration builders and generated schema push statements as structured lint evidence before SQL rendering.
- Use Oxc to inspect TypeScript migrations and TypeBox to validate JSON Schema rule options.
- Let consumers select compatible ZenStack and OpenTelemetry peers. Tuil declares the React requirement. Install the optional parser peer for each dialect that needs SQL analysis.

### Fixed

- Preserve constraint, index, and policy identities when checking planned changes against the database catalog.
- Track foreign-key index coverage after index drops in offline lint and write plans.
- Report class, member, and legacy parameter decorators that can run during migration import.
- Warn about opaque migration imports and check SQL executed while computing import arguments.
- Report gaps in column, constraint, and routine metadata without treating unknown values as policy violations.
- Preserve schema definitions and object dependencies when diffing SQLite, PostgreSQL, and MySQL catalogs.
- Respect MySQL namespace case modes and preserve integer default precision during schema comparison.

## [0.2.0] - 2026-11-23

### Added

- Ship six versioned Agent Skills through TanStack Intent. They cover setup, migration authoring, deployment planning, schema diffs, recovery, and plugins.
- Bundle an offline inspector that summarizes selected migrations, blockers, and warnings from a saved JSON plan.
- Publish an Agent Skills guide, documentation sitemap, `robots.txt`, and `llms.txt`.
- Add GitHub forms for bug reports, feature requests, documentation improvements, and support questions.

### Changed

- Expand installation and contributor guidance. Document when schema scaffolding writes to the ledger and how to verify exact recovery identities.
- Upgrade to OpenTelemetry JavaScript SDK 3 and preserve environment-selected sampling and span limits. The declared Node.js minimum is 22.15.

### Fixed

- Publish the qualified npm tarball through GitHub Actions and support publication recovery from an existing release tag.

## [0.1.0] - 2026-11-23

### Added

- Apply TypeScript migrations with ZenStack V3 clients or a standalone Kysely adapter.
- Plan migration dependencies across deployment stages with namespaces, explicit dependency edges, and superseding migrations.
- Generate cascade and compensation rollbacks and recover reconciled migration attempts.
- Preview and apply schema changes for SQLite, PostgreSQL, and MySQL.
- Squash reviewed migration history into a baseline for existing and fresh environments.
- Run either `zenlev` or `zenstack-zenlev` and request structured JSON for automation.
