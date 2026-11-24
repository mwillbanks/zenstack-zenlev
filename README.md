<p align="center">
  <img src="https://raw.githubusercontent.com/mwillbanks/zenstack-zenlev/main/logo.svg" alt="Zenlev migration graph logo" width="164" />
</p>

<h1 align="center">Zenlev</h1>

<p align="center">TypeScript database migrations and linting for ZenStack V3 and Kysely.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mwillbanks/zenstack-zenlev"><img src="https://img.shields.io/npm/v/@mwillbanks/zenstack-zenlev" alt="npm version" /></a>
  <a href="https://github.com/mwillbanks/zenstack-zenlev/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/mwillbanks/zenstack-zenlev/ci.yml?branch=main" alt="main build status" /></a>
  <a href="https://github.com/mwillbanks/zenstack-zenlev/pulls?q=is%3Apr+is%3Aopen+label%3Adependencies"><img src="https://img.shields.io/github/issues-pr-raw/mwillbanks/zenstack-zenlev/dependencies?label=dependency%20updates" alt="Open dependency update pull requests" /></a>
  <a href="https://app.codecov.io/gh/mwillbanks/zenstack-zenlev"><img src="https://img.shields.io/codecov/c/github/mwillbanks/zenstack-zenlev/main" alt="Measured main line coverage" /></a>
</p>

## What's Zenlev?

Zenlev is a Bun-native database migration toolkit for **ZenStack V3** and **Kysely**. It manages TypeScript schema and data changes for SQLite, PostgreSQL, and MySQL. Use it when a database change needs to span application deployments, when several teams write migrations independently, or when recovery needs to preserve the history of what happened.

Read the [full documentation](https://mwillbanks.github.io/zenstack-zenlev/docs) or start with the [installation steps](#installation).

### How migrations work

Each migration declares its identity, the changes it makes, and any migration IDs it depends on. Zenlev builds a directed acyclic graph from local migration files and the destination's ledger. The graph allows independent work to move on separate schedules and ensures each migration runs after its prerequisites.

For example, replacing a column across a rolling deployment can require three separate changes.

| Stage         | Database change                              | When to run it                                 |
| ------------- | -------------------------------------------- | ---------------------------------------------- |
| `pre-deploy`  | Add a nullable replacement column            | Before deploying code that writes both columns |
| `deploy`      | Backfill the replacement from the old column | After dual writes are live                     |
| `post-deploy` | Remove the old column                        | After all readers and writers have switched    |

Declare that backfill depends on expansion and removal depends on backfill. A namespace selects a stage. A pending prerequisite outside that stage blocks the plan. An environment selects the database connection and its ledger, so staging and production can move through the same graph independently. [Deployment guide](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/deployments) · [Namespaces and environments](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/namespaces)

### What you can do

- **Check database conventions.** Lint ZModel mappings, migration SQL, primary keys, and configured database policies. Audit deployed catalogs or register `lintPlugin()` to check writes. [Database linting](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/linting)
- **Plan before applying.** Preview the selected migrations and their blockers. Filter by IDs, graph bounds, namespaces, or tags. Export a dependency tree for review. [Dependency graph](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/graph)
- **Write and audit TypeScript migrations.** Use the configured ZenStack client or Kysely in migration handlers. The ledger records the executed entry-file hash and exposes unexpected edits. [Migration authoring](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/migrations)
- **Review ZModel changes as SQL.** Compare against a live database or a previous schema. Preview SQL or generate a migration and decide explicitly which absent-model tables to drop. Keep using `zen db pull` for introspection. [Schema changes](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/schema-changes)
- **Evolve history deliberately.** Supersede a migration, generate a reviewable rollback, reconcile an interrupted attempt, or squash completed history into a baseline for fresh databases. [Rollback and recovery](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/rollback-recovery) · [Baselines](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/baseline)
- **Extend execution.** Register typed plugins for deployment checks and migration context. Opt into OpenTelemetry export when you need execution traces. [Plugins and telemetry](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/plugins-telemetry)

## Installation

### 1. Install Zenlev

Use Bun 1.4.4 or later. Zenlev accepts Kysely 0.29 and supports ZenStack ORM 3.10 or later within major version 3.

```sh
bun add -d @mwillbanks/zenstack-zenlev
```

### 2. Configure the database connection

Create `zenlev.config.ts` next to your project manifest. Import your application's configured ZenStack client.

```ts
import { defineConfig } from '@mwillbanks/zenstack-zenlev'
import { db } from './db'

export default defineConfig({ client: db })
```

Use a client factory to route named environments or a Kysely adapter for standalone projects. [Configuration](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/configuration) · [SQLite, PostgreSQL, and MySQL examples](https://mwillbanks.github.io/zenstack-zenlev/docs/dialects)

### 3. Create, preview, and apply a migration

```sh
bun run zenlev migrate create --name add_accounts --empty
```

Keep the generated metadata in `migrations/`. Replace the empty `up` handler with the schema or data change you intend to make. This example creates an accounts table in a fresh development database.

```ts
export async function up(ctx: MigrationCtx) {
  await ctx.db.schema
    .createTable('accounts')
    .addColumn('id', 'varchar(36)', (column) => column.primaryKey())
    .addColumn('name', 'varchar(255)', (column) => column.notNull())
    .execute()
}
```

Add a `down` handler if you can reverse the change safely. Preview the plan against your development database, then apply.

```sh
bun run zenlev migrate apply --plan-only
bun run zenlev migrate apply
bun run zenlev migrate status
```

The CLI also runs as `zenstack-zenlev`. Add `--json` for automation. [First migration walkthrough](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/quick-start) · [CLI reference](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/commands)

### 4. Lint database changes

```sh
bun run zenlev lint --max-warnings 0
```

Zenlev applies its recommended naming and primary-key rules. Configure project conventions under `lint`. Install the optional parser peer for each SQL dialect whose authored SQL files or raw migration SQL you lint: `libpg-query@18` for PostgreSQL, `dt-sql-parser@4` for MySQL, or `sqlite3-parser@0.7` for SQLite. Supported Kysely builders and generated schema push evidence use structured linting without a SQL parser peer. Register `plugins: [lintPlugin()]` to enforce lint during apply and schema push. [Lint configuration and plugins](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/linting)

### 5. Install agent guidance

Install TanStack Intent as a development dependency.

```sh
bun add --dev --exact @tanstack/intent@0.5.6
```

Add an allowlist to your project's `package.json`. Then list the allowed skills and load the one you need.

```json
{
  "intent": {
    "skills": ["@mwillbanks/zenstack-zenlev#zenlev-setup"]
  }
}
```

```sh
bun run intent list
bun run intent load '@mwillbanks/zenstack-zenlev#zenlev-setup'
```

Use a Zenlev release that includes `skills/`. Intent loads guidance from the installed version. The seven skills cover setup, database linting, migration authoring, deployment planning, schema diffing, plugin authoring, and recovery. [Agent Skills installation and allowlist examples](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/agent-skills)

## Moving from Prisma Migrate

Verify that the existing database matches your expected schema and stop the old migration runner. Preserve the Prisma ledger and start a separate Zenlev ledger for new changes. Establish a reviewed baseline when fresh databases need to bootstrap the existing schema. [Adoption guide](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/adoption)

## Documentation and contributing

- [Documentation](https://mwillbanks.github.io/zenstack-zenlev/docs)
- [CLI reference](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/commands)
- [TypeScript API reference](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/api)
- [Changelog](https://github.com/mwillbanks/zenstack-zenlev/blob/main/CHANGELOG.md)
- [Contributing](https://github.com/mwillbanks/zenstack-zenlev/blob/main/CONTRIBUTING.md)
- [Security](https://github.com/mwillbanks/zenstack-zenlev/blob/main/SECURITY.md)

Released under the [MIT license](https://github.com/mwillbanks/zenstack-zenlev/blob/main/LICENSE).
