# Changelog

All notable changes to Zenlev are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0) and uses semantic versioning.

## [Unreleased]

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
