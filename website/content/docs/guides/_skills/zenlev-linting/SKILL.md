---
name: zenlev-linting
description: Use when configuring or running Zenlev database lint, investigating ZModel or SQL findings, auditing a live catalog, or enforcing policy on migration apply and schema push.
license: MIT
compatibility: Requires Bun and an installed Zenlev package. SQL analysis needs the optional parser peer for the selected dialect.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
  zenlev_sources: |-
    website/content/docs/guides/linting.mdx
    website/content/docs/reference/lint-rules.mdx
    src/lint/project.ts
    src/lint/plugin.ts
    src/lint/rules.ts
    src/lint/runner.ts
    src/lint/source/migration.ts
    package.json
---

# Lint database changes

1. Confirm the application directory, installed Zenlev version, configured inputs, and SQL dialect. Read the project's database conventions before changing rules.
2. Install the matching parser peer for SQL input. Use libpg-query 18 for PostgreSQL, dt-sql-parser 4 for MySQL, or sqlite3-parser 0.7 for SQLite.
3. Run offline lint first. The default preset checks logical names, physical mappings, and primary keys.
4. Review diagnostics and coverage gaps. Check that expected migration source and SQL files appear in the scan.
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

Treat a coverage gap as unavailable evidence. Install a missing parser, replace opaque SQL with a static form where practical, or review the affected effect manually. Use application-role tests to verify tenant isolation in addition to catalog checks.

## Enforce policy during writes

Add `lintPlugin()` to the existing `defineConfig({ plugins: [...] })` only when the project wants write enforcement. Install parser peers as regular dependencies if deployment installs omit dev dependencies.

The plugin checks the final locked apply or push plan. Errors veto it. Warnings permit writes, so retain the standalone CI warning budget. A veto can leave Zenlev's internal ledger initialized. Follow the project's normal authorization and preview process before running apply or push.

Report the inputs, rule IDs, remediation, remaining coverage gaps, and offline or live result. Identify the audited environment when applicable.

- [Database linting guide](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/linting)
- [Built-in lint rules](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/lint-rules)
