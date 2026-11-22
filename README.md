<p align="center">
  <img src="./logo.svg" alt="Zenlev logo" width="164" />
</p>

<h1 align="center">Zenlev</h1>

<p align="center">
  TypeScript migrations for ZenStack V3.
</p>

Write schema and data migrations in TypeScript. Use dependencies to keep prerequisite changes in order. Use namespaces or tags to select work before, during, or after a deployment. Zenlev records each successful migration with its executed hash.

Use Zenlev with an existing ZenStack V3 client or a standalone Kysely adapter. Continue to use `zen db pull` for introspection.

## Quick start

Install Zenlev in a Bun 1.4.4 or later project with Kysely 0.29. ZenStack projects also need a compatible `@zenstackhq/orm` 3.x release.

```sh
bun add -d @mwillbanks/zenstack-zenlev
```

Create `zenlev.config.ts` beside your project manifest. Import your configured client.

```ts
import { defineConfig } from '@mwillbanks/zenstack-zenlev'
import { db } from './db'

export default defineConfig({ client: db })
```

Generate a migration file. Add your changes to its `up` handler and add a `down` handler when reversal is safe.

```sh
bun run zenlev migrate create --name add_accounts --empty
bun run zenlev migrate apply --plan-only
bun run zenlev migrate apply
```

The package provides both `zenlev` and `zenstack-zenlev`. Use `--json` for automation.

## Schema changes and adoption

Preview the database changes for your current ZModel with `zenlev db push --sql`. Review the generated SQL and resolve any manual migration diagnostics before applying.

For an existing Prisma-managed project, verify the current schema and retire the old migration job. Preserve the Prisma ledger. Start a separate Zenlev history for future changes. The adoption guide also covers clean database bootstrap.

[Read the documentation](https://mwillbanks.github.io/zenstack-zenlev/docs/) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Changelog](./CHANGELOG.md)
