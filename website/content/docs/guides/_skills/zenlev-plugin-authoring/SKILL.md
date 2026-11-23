---
name: zenlev-plugin-authoring
description: Create and test a Zenlev lifecycle plugin with typed context, command or migration checks, plan hooks, or audit observers. Use for extending Zenlev behavior through definePlugin.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
sources:
  - website/content/docs/reference/plugins-telemetry.mdx
  - website/content/docs/reference/api.mdx
  - src/engine.ts
  - src/execution.ts
  - src/plugins.ts
  - src/types.ts
---

# Author a Zenlev lifecycle plugin

1. Identify the hook boundary. Use `onBeforeCommand` for command policy, `onPlan` for plan review, and `onBeforeMigration` for per-migration policy. Use after, warning, and store hooks to observe outcomes.
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
- An `onPlan` hook receives a copy. Return a valid replacement to narrow eligible work. Keep prerequisites, migration identities, transaction mode, and warnings intact. Declare prerequisites in migration metadata.
- Command context may have no database. Before-migration hooks receive the execution context. After-migration hooks observe the result using a root context. Avoid using after hooks for changes that must commit with the migration.
- Observer errors can be reported after a commit. Check the result and ledger before retrying. Never place credentials, SQL parameters, or user data in telemetry attributes.

## Verify in a disposable project

Preview with `bun run zenlev migrate apply --plan-only --json`. Verify expected selection and blockers. Use a disposable database to test invocation order, context, and the intended acceptance or veto behavior. For an observer, force its failure and check the actual ledger outcome. Close API-owned Zenlev services after the test.

- [Lifecycle plugins and telemetry](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/plugins-telemetry)
- [TypeScript API](https://mwillbanks.github.io/zenstack-zenlev/docs/reference/api)
