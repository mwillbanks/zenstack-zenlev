# Changelog

All notable changes to Zenlev are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0) and uses semantic versioning.

## [Unreleased]

## [0.1.0]

### Added

- Apply TypeScript migrations with ZenStack V3 clients or a standalone Kysely adapter.
- Plan migration dependencies across deployment stages with namespaces, explicit dependency edges, and superseding migrations.
- Generate cascade and compensation rollbacks and recover reconciled migration attempts.
- Preview and apply schema changes for SQLite, PostgreSQL, and MySQL.
- Squash reviewed migration history into a baseline for existing and fresh environments.
- Run either `zenlev` or `zenstack-zenlev` and request structured JSON for automation.
