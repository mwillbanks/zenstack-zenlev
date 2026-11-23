---
name: zenlev-setup
description: Configure Zenlev in a Bun project using a ZenStack V3 client or factory, or a standalone Kysely connection. Use for initial setup and destination routing, not migration authoring.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
sources:
  - website/content/docs/reference/configuration.mdx
  - website/content/docs/reference/api.mdx
  - website/content/docs/guides/namespaces.mdx
  - src/database.ts
  - src/project-config.ts
  - src/types.ts
---

# Set up the configured destination

1. Inspect the installed package version, Bun runtime, project schema, and existing database factory. Reuse the configured connection.
2. Choose exactly one connection source: `client`, `createClient`, or `adapter`. Use `defineConfig` in `zenlev.config.ts`.
3. A supplied ZenStack client is borrowed. A factory receives `{ name, cwd }` and returns `{ client, dispose }`. Return an explicit disposer for factory-owned resources.
4. Route `--env` through that factory. It does not reconnect an already supplied client. Do not mutate process globals to select environments.
5. For standalone Kysely, use `createKyselyAdapter(connection, dialect)`. The dialect is `sqlite`, `postgresql`, or `mysql`; preserve the caller's connection and ownership.
6. Inspect the destination before applying any migration.

```sh
bun run zenlev migrate status --env development
bun run zenlev migrate apply --env development --plan-only --json
```

Paths for migrations resolve from the effective working directory. JSON configuration can use `clientModule`; that module reference resolves from its declaring file and exports a default factory.

Keep a stable ledger location for each destination. SQLite uses prefixed tables; PostgreSQL defaults to a `zenlev` schema; MySQL defaults to a `zenlev` database. Check required permissions. Do not supply a transaction client as a root connection.

Namespace labels group migrations within one ledger. They do not isolate databases or route connections. Confirm the factory destination separately.

Completion evidence: identify the selected destination, connection owner, ledger location, and plan result. A successful plan can still contain blockers; inspect them before execution.

- [Configuration and ownership](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/configuration)
- [API and Kysely adapter](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/api)
- [Dialect examples](https://mwillbanks.github.io/zenstack-zenlev/docs/dialects)
- [Namespaces and environments](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/namespaces)
