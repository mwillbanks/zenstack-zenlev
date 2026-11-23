# Changelog

All notable changes to Zenlev are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0) and uses semantic versioning.

## [Unreleased]

### Added

- Add a versioned Zenlev plugin authoring skill for typed context, lifecycle hooks, and testing.
- Ship versioned TanStack Intent skills for Zenlev setup, migration authoring, deployment planning, schema changes, and recovery.
- Publish an agent setup guide, documentation sitemap, and `llms.txt`.
- Add GitHub forms for bug reports, feature requests, documentation improvements, and support questions.

### Changed

- Upgrade the trace exporter to OpenTelemetry JavaScript SDK 3. The declared Node.js minimum is 22.15.

## [0.1.0] - 2026-11-23

### Added

- Apply TypeScript migrations with ZenStack V3 clients or a standalone Kysely adapter.
- Plan migration dependencies across deployment stages with namespaces, explicit dependency edges, and superseding migrations.
- Generate cascade and compensation rollbacks and recover reconciled migration attempts.
- Preview and apply schema changes for SQLite, PostgreSQL, and MySQL.
- Squash reviewed migration history into a baseline for existing and fresh environments.
- Run either `zenlev` or `zenstack-zenlev` and request structured JSON for automation.
