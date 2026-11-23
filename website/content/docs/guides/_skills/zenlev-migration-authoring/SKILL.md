---
name: zenlev-migration-authoring
description: Write or review TypeScript Zenlev migrations, including metadata, dependency IDs, entry-file hashes, transactional context, and truthful down handlers. Use when changing migration code.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
sources:
  - website/content/docs/guides/migrations.mdx
  - website/content/docs/reference/commands.mdx
  - src/migrations.ts
  - src/database.ts
  - src/execution.ts
  - src/types.ts
---

# Author a migration with explicit prerequisites

1. Inspect existing metadata, dependency IDs, and the destination's recorded history.
2. Scaffold with the CLI. Preserve the generated CUID2 identity and UTC creation timestamp.
3. Export `meta` and `up`; export `down` only when reversal semantics are known. Match metadata identity to the filename.
4. Declare actual prerequisites in `meta.dependsOn`. Namespace names and filename order do not create edges.
5. Use the migration context for database work. Inspect the plan and test application and any reversal on a disposable database.

```sh
bun run zenlev migrate create --empty --name add-account-status --namespace pre-deploy
bun run zenlev migrate apply --plan-only --json
```

Inside a handler, use `ctx.db.kysely`, `ctx.db.schema`, and `ctx.zenstack.client` when using ZenStack. These share the migration transaction and ledger transition. Do not capture the root client for transactional work. ZenStack's `$qbRaw` can retain the base connection; use the provided context query builder.

MySQL DDL can commit implicitly. External requests and other arbitrary TypeScript effects do not become atomic through a database transaction. Make them idempotent and describe reconciliation requirements. Declare warnings for raw SQL or external work that automated detection cannot understand.

Entry-file bytes are hashed, with normalized line endings by default. Imported helpers, external data, and other effects are outside that hash. Prefer a new migration for changed behavior. Do not silently edit an applied file or accept a changed hash without source review.

A `down` must account for data written after deployment. Dropping a populated column is not a faithful inverse of adding it.

Completion evidence: show the new identity, prerequisites, warning/reversal decisions, plan blockers, and disposable database results. Planning loads modules: keep top-level code free of side effects.

- [Migration authoring](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/migrations)
- [CLI options](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/commands)
- [Rollback and recovery](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/rollback-recovery)
