---
name: zenlev-recovery
description: Use when a Zenlev rollout needs to reverse an applied migration, an interrupted run left partial effects or a lock, or completed history must be squashed and adopted. Covers cascade, compensation, operator recovery, and baseline verification.
license: MIT
compatibility: Requires Bun and an installed Zenlev package.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
  zenlev_sources: |-
    website/content/docs/guides/rollback-recovery.mdx
    website/content/docs/guides/baseline.mdx
    website/content/docs/reference/commands.mdx
    src/migrate/rollback.ts
    src/migrate/store.ts
    src/migrate/baseline.ts
---

# Recover from observed database and ledger state

Confirm the affected database and use that same `--env` for every command. Replace `staging` below with the verified environment. Inspect status, the graph, and actual database state before choosing a recovery path. Preserve audit history. Do not automatically retry an unresolved attempt or delete ledger rows to remove a blocker.

Start with read-only inspection:

```sh
bun run zenlev migrate status --env staging --json
bun run zenlev migrate tree --env staging --show-supersedes --format mermaid
```

## Reverse migration effects

Use exactly one rollback mode with a target ID. Start with a preview:

```sh
bun run zenlev migrate rollback --env staging --id TARGET_ID --cascade --dry-run
```

Replace `TARGET_ID` with the recorded identity. Cascade includes active transitive dependents in reverse dependency order. Compensation includes only the target and warns about active dependents. Choose compensation only after assessing whether those dependents can remain valid.

Rollback generates a new superseding migration; it does not immediately reverse the database. Every included active source needs a usable `down`. Review the generated file and plan before applying it. Source hashes are verified before reversal. A destination skips reversal of never-applied entries and rejects a cascade that omits a newly active dependent.

## Reconcile an interrupted operation

Use an authorized read-only database connection to the verified destination. Read `owner` in the configured lock table or `attempt_id` for the affected migration in the configured migrations table. See [ledger inspection](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/rollback-recovery#inspect-recovery-identities) for default names. Stop if you cannot verify the current identity. Inspect partial effects. Confirm the prior runner and its database session ended before releasing its lock; lock age is insufficient.

Use `bun run zenlev migrate recover --env staging` with `--actor`, `--reason`, and `--evidence`. Keep secrets and application data out of the audit text.

- `--action release-lock --owner <observed-owner>` releases that exact owner.
- `--action applied --id <id> --attempt-id <observed-attempt>` requires evidence that all intended effects exist.
- `--action retry --id <id> --attempt-id <observed-attempt>` requires reconciled state that makes another run safe.

For partial work, check each intended effect against the database and migration source. For example, a created table proves the DDL ran, but mismatched row counts can show the copy failed. Before recording `retry`, confirm the handler safely handles the observed state or restore a reviewed starting state. Before recording `applied`, verify the complete intended end state. If neither condition holds, leave the attempt unresolved and stop.

## Squash completed history

Preview `bun run zenlev migrate squash --env staging --dry-run` only after all migrations are current, hashes match, and no attempts remain unresolved. Generate and review the baseline snapshot. Supply reviewed SQL through `--snapshot` for PostgreSQL, MySQL, or unsupported automatic SQLite objects.

Test bootstrap on an empty disposable database and adoption against a matching existing ledger. Matching history adopts without replay; partial or different history blocks adoption. Baselines are schema snapshots, not application-data backups. Review essential seed data separately. Adopt across existing destinations before archiving covered source files.

Completion evidence: record the selected recovery mode, observed identity, database reconciliation evidence, generated migration review, and resulting ledger status.

- [Rollback and operator recovery](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/rollback-recovery)
- [Baseline bootstrap and adoption](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/baseline)
- [Recovery flags](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/commands)
