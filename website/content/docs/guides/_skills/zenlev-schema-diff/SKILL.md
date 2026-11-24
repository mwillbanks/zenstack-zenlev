---
name: zenlev-schema-diff
description: Use when comparing a ZModel with a live database or an earlier schema, previewing generated SQL, or scaffolding a schema migration. Covers comparison direction, unsupported changes, and decisions about tables absent from ZModel.
license: MIT
compatibility: Requires Bun and an installed Zenlev package.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
---

# Review the change set before execution

1. Confirm the configured database destination and current ZModel, including imports and mapped physical names.
2. Inspect the ordered change set and SQL. Separate supported changes from objects requiring a manual migration.
3. Review every missing-table candidate and its dependent operations. Choose apply or skip explicitly for noninteractive work.
4. Generate a migration for review, or execute only when direct schema changes are within the authorized task.
5. Test the resulting schema against a disposable database using the same dialect.

```sh
bun run zenlev db push --env staging --dry-run --sql --drop-missing-tables=skip
bun run zenlev db push --env staging --create-migration --name align-schema --drop-missing-tables=skip --format
```

Replace `staging` with the verified destination. Use `skip` to retain all tables absent from ZModel. Confirm the reviewed SQL omits their drops. Run the second command only when the user requests a file, the preview matches the intended changes, and ledger writes are authorized. Use `apply` only when the operator authorizes the named drops. Declining a table also skips dependent drop operations. If the live plan changes after confirmation, stop and review the replacement plan.

`db push` compares current ZModel against the live database. `migrate create --from-schema <path>` compares an earlier schema against the current ZModel; adding `--to-db` compares that source against the live database.

`--sql` and `--dry-run` inspect without execution. `--create-migration` writes a file and takes a live ledger lock. It can initialize the ledger without applying application schema changes. Stop at preview when you have read-only access or authorization. Generated inverses exist only where semantics are known. Inspect generated handlers before application, especially destructive or data-dependent changes.

Do not infer renames from similar names or invent unsupported rewrites. Zenlev excludes its ledger and Prisma bookkeeping; views are excluded by default. Continue to use `zen db pull` for introspection.

Completion evidence: report comparison direction, SQL operations, unsupported objects, explicit table-drop decisions, and resulting file or database changes.

- [Schema comparison and limits](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/schema-changes)
- [Command modes](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/commands)
- [Dialect examples](https://mwillbanks.github.io/zenstack-zenlev/docs/dialects)
