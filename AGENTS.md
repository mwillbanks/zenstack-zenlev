# Repository guidance

Zenlev is a Bun-native TypeScript migration engine for ZenStack V3 and standalone Kysely. Both CLI aliases and the TypeScript API use the same command service. Changes should preserve identical planning, ledger, and execution behavior across those entry points.

## Architecture

| Area                          | Start here                                                                                     | Ownership                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Public contracts and dispatch | `src/index.ts`, `src/types.ts`, `src/engine.ts`                                                | Public exports, typed migration context, command lifecycle, and resource cleanup                 |
| Configuration and connections | `src/config.ts`, `src/project-config.ts`, `src/database.ts`                                    | Config discovery, environment routing, adapter capabilities, and transaction scope               |
| Files, graph, and inspection  | `src/migrations.ts`, `src/graph.ts`, `src/inspection.ts`                                       | Migration loading and hashes, effective graph, plan selection, and read-only status              |
| Execution and history         | `src/execution.ts`, `src/store.ts`, `src/rollback.ts`, `src/baseline.ts`                       | Apply, locks, audit records, recovery, generated rollback, and baseline adoption                 |
| Schema changes                | `src/schema-model.ts`, `src/schema-catalog.ts`, `src/schema-diff.ts`, `src/schema-commands.ts` | ZModel loading, physical catalog inspection, ordered changes, and shared preview and apply paths |
| Extensions                    | `src/plugins.ts`, `src/warnings.ts`, `src/telemetry.ts`                                        | Typed hooks, warnings, and opt-in trace reporting                                                |
| CLI                           | `src/cli.ts`, `src/cli-render.ts`                                                              | Option parsing, exit status, JSON, plain output, and lazy TTY rendering with Tuil                |

Keep schema, client construction, SQL catalogs, telemetry, and terminal rendering outside the graph. Use Bun's native TypeScript loader and bundler. Keep project config, migrations, and consumer database dependencies runtime-resolved.

### Graph and ledger

- Migration IDs are global within a ledger. A namespace selects a rollout cohort. An environment selects a connection through the configured factory.
- Merge local definitions with store-only history. Resolve supersedes transitively with creation time and lexical ID as the winner order. Preserve deterministic lexical ordering for independent migrations.
- Treat `--from` as an inclusive descendant bound and `--to` as an inclusive ancestor bound. Intersect bounds with namespace, tag, and ID filters. Report pending prerequisites outside the selection as blockers.
- Read-only and plan-only commands must work before ledger initialization. Apply takes the lock, rereads history, and checks hashes and the selected plan before writing.
- Use the caller's existing connection. Borrow supplied clients and dispose factory-owned clients. Keep migration work and ledger transitions on the same transaction when the dialect supports transactional DDL. Use transaction-scoped ZenStack `$qb` for physical queries because `$qbRaw` can retain the base connection.
- Keep the executed hash for audit. Record accepted alternatives separately. Keep nontransactional attempts blocked until an operator reconciles them and records the observed identity and evidence.
- Rollback generates a superseding migration. Cascade reverses active dependents first. Compensation reverses the target and warns about dependents. Baseline adoption requires matching recorded history and preserves archived logical IDs.

### Plugins and CLI

- Register hooks with `definePlugin` and `defineConfig({ plugins })`. Use `decorate` for static values and `derive` for invocation-scoped values. Reject reserved names and duplicate context keys.
- Choose hooks by execution boundary. Command and plan hooks receive command context. Migration hooks receive migration context. Before hooks may veto work. Plan replacements must preserve eligibility, dependency order, integrity, and transaction mode.
- Observer failures must stay separate from committed outcomes. Keep external side effects out of planning. Keep secrets, SQL parameters, and migration data out of telemetry.
- Update CLI flags, help, command dispatch, and API options together when their contracts overlap. Preserve both aliases and keep JSON free of TTY output. Put connection and state transitions in the service rather than CLI parsing or rendering.
- Compare schema changes using the shared ordered change set. Show destructive operations before writing. Never infer renames. Users run `zen db pull` for introspection.

## Validation

- Run `bun fmt --check .`, `bun check`, `bun run lint`, then targeted tests. Use `bun run verify` for the full Bun suite.
- Run `bun run verify:coverage` with disposable PostgreSQL and MySQL endpoints in `ZENLEV_TEST_POSTGRES_URL` and `ZENLEV_TEST_MYSQL_URL` to qualify all three dialects. Bun enforces 95% lines and functions per shipped file. The LCOV check verifies source inventory.
- Use fresh `bun:sqlite` fixtures and isolated temporary directories. Restore mocks and spies and close resources in teardown. Control unit-test clocks and concurrency with fakes and deferred barriers. Use the integration suites for real database, process, and terminal contracts.
- Run `bun run skills:check` for skill changes. Run `bun run build` and `bun run pack:check` for package changes. The clean packed install checks declarations, both aliases, SQLite, and Intent permissions with lifecycle scripts disabled.
- Run `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run verify:build` from `website/` for published docs changes. Guides, references, and dialect examples live under `website/content/docs/`. Preserve legacy canonicals and the GitHub Pages base path.

## Dependencies and release

Keep the root and website manifests and Bun lockfiles in sync. Verify CI with frozen installs. Use major tags for GitHub Actions. Keep Codecov downstream of successful main validation.

Update `CHANGELOG.md` under `[Unreleased]` for each user-visible change. Describe the behavior and operator impact directly. Squash merges can lose commit detail.

When preparing a release, curate the shipped entries under the version heading. Add versioned notes under `website/content/docs/releases/` and link them in that section's navigation. Release Please manages the version, release pull request, tag, and GitHub release. The trusted GitHub workflow publishes the qualified archive.

## Agent Skills

Edit canonical skills under `website/content/docs/guides/_skills/`. List the docs and implementation paths that support each skill. For a new skill, update the consumer guide and pack inventory.

After reviewing changed guidance or a declared source, run `bun run skills:review <skill> "<reason>"` and apply the resulting JSON to `skills-review.json`. Explain what you checked. Build and CI verify the record and stage skills with the package version.

Review the current worktree before editing. Preserve other contributors' changes. Never commit or publish unless the user explicitly requests it. Keep credentials, database files, generated build products, and coverage output out of Git.
