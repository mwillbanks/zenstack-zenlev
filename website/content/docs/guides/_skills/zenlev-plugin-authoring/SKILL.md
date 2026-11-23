---
name: zenlev-plugin-authoring
description: Use when writing a Zenlev lifecycle plugin for policy, typed migration context, plan validation, audit events, or hook errors. Covers definePlugin, registration, vetoes, preview safety, and observer failures after commit.
license: MIT
compatibility: Requires Bun and an installed Zenlev package.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
  zenlev_sources: |-
    website/content/docs/reference/plugins-telemetry.mdx
    website/content/docs/guides/linting.mdx
    website/content/docs/reference/lint-rules.mdx
    website/content/docs/reference/api.mdx
    src/engine.ts
    src/migrate/execution.ts
    src/plugins.ts
    src/lint/plugin.ts
    src/lint/runner.ts
    src/lint/types.ts
    src/types.ts
---

# Author a Zenlev lifecycle plugin

1. Identify the hook boundary. Use `onBeforeCommand` for command policy, `onPlan` for plan review, and `onBeforeMigration` for per-migration policy. Use `onBeforeWrite` to validate final apply and push plans. Use after, warning, and store hooks to observe outcomes.
2. Define the plugin with `definePlugin` and a unique name. Use `decorate` for stable values and `derive` for values calculated from the current context. Use distinct extension keys across plugins and avoid built-in keys such as `env`, `db`, and `reporter`.
3. Register it in the project's `defineConfig` using `plugins: [plugin]`. Registration order controls execution order. If a migration needs inferred extension types, use `zenlev.defineMigration` or derive the type from the configuration with `ZenlevMigrationContext`.

```ts
import { definePlugin } from '@mwillbanks/zenstack-zenlev'

export const rolloutAudit = definePlugin({
  name: 'rollout-audit',
  decorate: { rolloutTeam: 'database' },
  derive: (ctx) => ({ rolloutLabel: ctx.rolloutTeam + ':' + ctx.env.name }),
  setup(api) {
    api.onBeforeMigration((ctx, migration) => {
      ctx.reporter.event('rollout.reviewed', {
        'zenlev.migration.id': migration.id,
        status: 'reviewed',
      })
    })
  },
})
```

Register the exported plugin with your existing client or adapter. The sample observer emits one event before a migration runs.

## Preserve execution rules

- Before hooks may return `false` to abort their operation. Command and plan hooks can run for previews. Keep them free of writes and external effects.
- An `onBeforeWrite` hook receives the final locked plan after transformations. Return structured error diagnostics to veto the entire write plan. Warning diagnostics accompany the result. Preview and file-generation commands skip this hook. The lock path can initialize the ledger before a veto.
- An `onPlan` hook receives a copy. Return a valid replacement to narrow eligible work. Keep prerequisites, migration identities, transaction mode, and warnings intact. Declare prerequisites in migration metadata.
- Command context may have no database. Before-migration hooks receive the execution context. After-migration hooks observe the result using a root context. Put changes that must commit with the migration in its handler.
- Observer errors can be reported after a commit. Inspect the command result and run `bun run zenlev migrate status --env staging --json` with the original environment. If the ledger shows the migration applied, reconcile the missing audit event separately. Never place credentials, SQL parameters, or user data in telemetry attributes.

## Use the database linter

Register `plugins: [lintPlugin()]` to enforce the project's lint settings before apply and schema push. Run `bun run zenlev lint --max-warnings 0` independently in CI.

Author custom lint plugins with `meta.name`, `rules`, option schemas, `create(context)`, typed node visitors, and `context.report()`. Load them through `lint.plugins`. Use `testLintRule()` with normalized evidence fixtures. Report unavailable evidence through `context.gap()`.

Keep final-plan checks free of writes and external effects. Test a rejected multi-migration plan and generated rollback directions.

## Verify in a disposable project

Preview with `bun run zenlev migrate apply --plan-only --json`. Verify expected selection and blockers. Use a disposable database to test invocation order, context, and the intended acceptance or veto behavior. For an observer, force its failure and check the actual ledger outcome. Close API-owned Zenlev services after the test.

- [Lifecycle plugins and telemetry](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/plugins-telemetry)
- [Database linting](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/linting)
- [Lint rules](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/lint-rules)
- [TypeScript API](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/api)
