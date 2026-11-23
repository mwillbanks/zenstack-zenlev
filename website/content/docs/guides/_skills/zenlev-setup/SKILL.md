---
name: zenlev-setup
description: Use when wiring Zenlev into a Bun project, choosing a ZenStack V3 client, factory, or standalone Kysely adapter, or diagnosing why --env points at the wrong database. Covers connection ownership, project paths, dialect setup, and destination checks.
license: MIT
compatibility: Requires Bun and an installed Zenlev package.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
  zenlev_sources: |-
    website/content/docs/reference/configuration.mdx
    website/content/docs/reference/api.mdx
    website/content/docs/guides/namespaces.mdx
    src/database.ts
    src/project-config.ts
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

Completion evidence: identify the selected destination, connection owner, ledger location, and plan result. A successful plan can still contain blockers; inspect them before execution.

- [Configuration and ownership](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/configuration)
- [API and Kysely adapter](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/api)
- [Dialect examples](https://mwillbanks.github.io/zenstack-zenlev/docs/dialects)
- [Namespaces and environments](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/namespaces)
