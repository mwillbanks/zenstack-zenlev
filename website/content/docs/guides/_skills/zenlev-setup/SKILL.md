---
name: zenlev-setup
description: Use when wiring Zenlev into a Bun project, choosing a ZenStack V3 client, factory, or standalone Kysely adapter, or diagnosing why --env points at the wrong database. Covers connection ownership, project paths, dialect setup, destination checks, and database lint setup.
license: MIT
compatibility: Requires Bun and an installed Zenlev package.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
  zenlev_sources: |-
    website/content/docs/reference/configuration.mdx
    website/content/docs/reference/api.mdx
    website/content/docs/guides/namespaces.mdx
    website/content/docs/guides/linting.mdx
    src/database.ts
    src/config.ts
    src/lint/source/kysely.ts
    src/lint/source/sql.ts
    src/lint/plugin.ts
    src/lint/sqlite/catalog.ts
    src/lint/mysql/parser.ts
    src/lint/postgresql/parser.ts
    src/lint/sqlite/parser.ts
    src/schema/diff/evidence.ts
    src/types.ts
---

# Set up the configured destination

1. Inspect the installed package version, Bun runtime, project schema, and existing database factory. Reuse the configured connection.
2. Choose exactly one connection source: `client`, `createClient`, or `adapter`. Use `defineConfig` in `zenlev.config.ts`.
3. A supplied ZenStack client is borrowed. A factory receives `{ name, cwd }` and returns `{ client, dispose }`. Return an explicit disposer for factory-owned resources.
4. Select the connection inside `createClient` from `name`. Reject unknown environments and avoid fallback to a different database. Pass the app directory with `--cwd` when running from a monorepo root.
5. For standalone Kysely, use `createKyselyAdapter(connection, dialect)`. The dialect is `sqlite`, `postgresql`, or `mysql`; preserve the caller's connection and ownership.
6. Inspect the destination before applying any migration.

Run from the app directory. Replace `staging` with an environment the factory recognizes.

```sh
bun run zenlev migrate status --env staging --json
bun run zenlev migrate apply --env staging --plan-only --json
```

Confirm the resolved target with a redacted connection identifier from the project configuration. Status alone does not identify the server or database. Stop when the target is unverified.

Paths for migrations resolve from the effective working directory. JSON configuration can use `clientModule`; that module reference resolves from its declaring file and exports a default factory.

Keep a stable ledger location for each destination. SQLite uses prefixed tables; PostgreSQL defaults to a `zenlev` schema; MySQL defaults to a `zenlev` database. Check required permissions. Do not supply a transaction client as a root connection.

Namespace labels group migrations within one ledger. They do not isolate databases or route connections. Confirm the factory destination separately.

## Set up database linting

1. Run `bun run zenlev lint --json` from the application directory. Zenlev applies its recommended ZModel mapping and primary-key rules by default.
2. For standalone SQL or Kysely, set `lint.zmodel: false` and `lint.dialect`. Set `lint.sql` to the SQL file globs you want to check.
3. Install an optional parser peer for authored SQL files, raw migration SQL, and SQLite catalog parsing of stored table definitions. Use `libpg-query@18` for PostgreSQL, `dt-sql-parser@4` for MySQL, or `sqlite3-parser@0.7` for SQLite. SQLite catalog lint attempts to parse each stored table definition that exists, regardless of configured rules. Without the SQLite parser, report parse coverage gaps and continue checks supported by available metadata, including PRAGMA results. If a table has no stored definition, only rule-specific facts that depend on it are unavailable. Supported Kysely builders and generated statement evidence use structured linting without a parser peer. A SQLite catalog audit during `db push` still attempts to parse each stored table definition that exists.
4. Use regular dependencies if a deployment environment runs lint or write enforcement without dev dependencies.
5. Add `bun run zenlev lint --max-warnings 0` to CI. Use `plugins: [lintPlugin()]` to enforce lint on migration apply and schema push.
6. Load `zenlev-linting` for rule selection, coverage diagnostics, exceptions, and live audit steps.

Identify the destination, connection owner, ledger location, plan result, and offline lint result. Review any plan blockers before execution.

- [Configuration and ownership](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/configuration)
- [API and Kysely adapter](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/api)
- [Dialect examples](https://mwillbanks.github.io/zenstack-zenlev/docs/dialects)
- [Namespaces and environments](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/namespaces)
- [Database linting](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/linting)
