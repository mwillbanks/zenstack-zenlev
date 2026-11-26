---
name: zenlev-linting
description: Use when configuring or running Zenlev lint, investigating ZModel, application query, or SQL findings, auditing a live catalog, or enforcing migration and schema policy.
license: MIT
compatibility: Requires Bun and an installed Zenlev package. SQL text analysis needs the optional parser peer for its dialect.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
---

# Lint database changes

1. Confirm the application directory, installed Zenlev version, configured inputs, and SQL dialect. Read the project's database conventions before changing rules.
2. Install the matching optional parser peer for authored SQL text and SQLite catalog parsing of stored table definitions. SQLite catalog lint attempts to parse each stored table definition that exists, regardless of the configured rules. Without the SQLite parser, report parse coverage gaps and continue checks supported by available metadata, including PRAGMA results. If a table has no stored definition, only rule-specific facts that depend on it are unavailable. Supported Kysely schema builders and generated statement evidence use structured analysis and do not need a SQL parser peer. A SQLite catalog audit during `db push` still attempts to parse each stored table definition that exists.
3. Run offline lint first. The default preset checks logical names, physical mappings, primary keys, and application queries selected by `lint.source`.
4. Review diagnostics and coverage gaps. Check that expected application files, migration source, and SQL files appear in the scan.
5. Make the smallest schema, mapping, SQL, or rule change that satisfies the policy. Run the same command again.
6. Use a live audit only for an authorized destination. Confirm the resolved environment and catalog visibility.

```sh
bun run zenlev lint --max-warnings 0 --json
bun run zenlev lint --live --env staging --max-warnings 0 --json
```

Exit code 1 means a policy error or warning-budget failure. Exit code 2 means an input, configuration, plugin, or audit error.

## Configure policy

Use `lint.rules` for rule settings and `lint.overrides` for narrower scope. Consult the individual rule page before choosing options. For SQL-only projects, set `lint.zmodel: false`, declare `lint.dialect`, and set SQL input globs with `lint.sql`.

Keep logical ZModel names and physical mappings consistent. Use `@@map` for tables and `@map` for columns. When the project needs an exception, record the exact rule, source fingerprint or object identity, and reason. Remove stale exceptions after review.

Treat a coverage gap as unavailable evidence. Install a missing parser for SQL text or SQLite stored table definitions, replace opaque SQL with a static form where practical, or review the affected effect manually. SQLite catalog lint uses available metadata, including PRAGMA results. It attempts to parse each stored table definition that exists to recover facts metadata does not expose, such as named `CHECK` constraints, whether or not configured rules use those facts. Without the SQLite parser, report parse coverage gaps while continuing checks supported by available metadata. If a table has no stored definition, only rule-specific facts that depend on it are unavailable. Use application-role tests to verify tenant isolation in addition to catalog checks.

## Check application queries

Set `lint.source` to explicit project-relative TypeScript and JavaScript globs. No application files are selected by default.

The recommended rules permit `query-builder` and `query-api` styles through `zenlev/queries/allowed-types`. They reject low-level access with `zenlev/queries/no-direct-kysely` and raw SQL with `zenlev/queries/no-raw`. Enable `zenlev/queries/no-schema-changes` when application code must not use schema builders.

Set the direct-Kysely rule's `mode` only when auto detection cannot establish the intended ZenStack or standalone convention. Standalone mode permits typed Kysely queries, but not `$qbRaw`. Type-only imports and dialect setup remain valid. Bound SQL parameters do not exempt raw queries.

Discovered migrations remain exempt from application query rules, even when `lint.migrations: false`. Preserve existing migration checks. Use file overrides for reviewed application exceptions. Do not enable broad exceptions to hide unresolved wrappers.

Application checks run offline without importing application modules or acquiring a client. They do not run through live audits or `lintPlugin()`. Review dynamic source coverage gaps before reporting compliance.

## Enforce policy during writes

Add `lintPlugin()` to the existing `defineConfig({ plugins: [...] })` only when the project wants write enforcement. Install parser peers as regular dependencies if deployment installs omit dev dependencies.

The plugin checks the final locked apply or push plan. Errors veto it. Warnings permit writes, so retain the standalone CI warning budget. A veto can leave Zenlev's internal ledger initialized. Follow the project's normal authorization and preview process before running apply or push.

Report the inputs, rule IDs, remediation, remaining coverage gaps, and offline or live result. Identify the audited environment when applicable.

- [Database linting guide](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/linting)
- [Built-in lint rules](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/lint-rules)
