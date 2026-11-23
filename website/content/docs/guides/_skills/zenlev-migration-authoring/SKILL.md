---
name: zenlev-migration-authoring
description: Use when writing or reviewing a Zenlev migration file, adding a cross-stage dependency, designing a backfill or down handler, or investigating an edited migration's hash. Covers TypeScript metadata, transaction-scoped database access, and reversible changes.
license: MIT
compatibility: Requires Bun and an installed Zenlev package.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
  zenlev_sources: |-
    website/content/docs/guides/migrations.mdx
    website/content/docs/guides/linting.mdx
    website/content/docs/reference/lint-rules.mdx
    website/content/docs/reference/commands.mdx
    src/migrate/files.ts
    src/lint/project.ts
    src/lint/source/migration.ts
    src/lint/zmodel.ts
    src/database.ts
    src/migrate/execution.ts
    src/types.ts
---

# Author a migration with explicit prerequisites

1. Inspect existing metadata, dependency IDs, and the destination's recorded history.
2. Scaffold with the CLI. Preserve the generated CUID2 identity and UTC creation timestamp.
3. Export `meta` and `up`; export `down` only when reversal semantics are known. Match metadata identity to the filename.
4. Declare actual prerequisites in `meta.dependsOn`. Namespace names and filename order do not create edges.
5. When expansion already ran, keep its bytes and scaffold a separate backfill that depends on the expansion ID. Test both a fresh install and a database with the expansion already applied.
6. Run `bun run zenlev lint --max-warnings 0` before presenting database changes. Fix rule errors and review coverage gaps.

```sh
bun run zenlev migrate create --empty --name backfill-account-status --namespace deploy
bun run zenlev migrate apply --plan-only --json
bun run zenlev lint --max-warnings 0
```

Inside a handler, use `ctx.db.kysely`, `ctx.db.schema`, and `ctx.zenstack.client` when using ZenStack. These share the migration transaction and ledger transition. Do not capture the root client for transactional work. ZenStack's `$qbRaw` can retain the base connection; use the provided context query builder.

MySQL DDL can commit implicitly. External requests and other arbitrary TypeScript effects do not become atomic through a database transaction. Make them idempotent and describe reconciliation requirements. Declare warnings for raw SQL or external work that automated detection cannot understand.

Entry-file bytes are hashed, with normalized line endings by default. Imported helpers, external data, and other effects are outside that hash. Prefer a new migration for changed behavior. Do not silently edit an applied file or accept a changed hash without source review.

Lint uses ZenStack's parser for ZModel and static analysis for migration source. It does not import migration modules. Configure mappings and conventions under `lint`. Register `plugins: [lintPlugin()]` to check final write plans. Dynamic SQL and opaque helper effects produce coverage warnings. Review those effects explicitly.

A `down` must account for data written after deployment. Dropping a populated column is not a faithful inverse of adding it.

Completion evidence: show the new identity, prerequisites, warning/reversal decisions, plan blockers, and disposable database results. Planning loads modules: keep top-level code free of side effects.

- [Migration authoring](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/migrations)
- [Database linting](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/linting)
- [CLI options](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/commands)
- [Rollback and recovery](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/rollback-recovery)
