# Repository guidance

Keep the migration engine independent of ZenStack schema loading and CLI rendering. Put integrations behind typed adapters. Preserve the user's configured Kysely connection and use Bun's native TypeScript runtime and bundler.

## Commands

- `bun fmt .` formats repository files.
- `bun check` typechecks the configured TypeScript project.
- `bun run lint` runs Oxlint on source and tests.
- `bun test --bail` runs the test suite.
- `bun run verify:coverage` runs formatting, typechecking, lint, and tests with coverage.

Use `bun:sqlite` for database tests. Restore module mocks and spies after each test. Keep timers, clocks, and concurrency controlled without real-time waits in unit tests.

Review the current worktree before editing. Preserve changes from other contributors. Never commit or publish unless the user explicitly requests it.

Do not commit credentials, connection strings, database files, or generated build and coverage output.
