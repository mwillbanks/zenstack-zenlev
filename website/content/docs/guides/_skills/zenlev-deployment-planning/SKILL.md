---
name: zenlev-deployment-planning
description: Use when reviewing a Zenlev rollout, splitting changes across namespace stages, or deciding why a plan blocks work even when the command succeeds. Covers cross-stage prerequisites, filter intersections, effective supersedes, and read-only preflight.
license: MIT
compatibility: Requires Bun and an installed Zenlev package.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
  zenlev_sources: |-
    website/content/docs/guides/deployments.mdx
    website/content/docs/guides/namespaces.mdx
    website/content/docs/guides/graph.mdx
    src/migrate/graph.ts
    src/migrate/execution.ts
---

# Plan stages through dependencies

1. Confirm the destination selected by `--env`. Treat namespace labels as stages within its shared ledger.
2. Read the effective graph and destination status. For a superseded prerequisite, identify the effective replacement and check whether that effective ID satisfies the edge on this destination.
3. Preview each intended stage. Resolve blockers before running that stage.
4. Apply only within the authorized destination and deployment stage. Reinspect before advancing to the next stage.

```sh
bun run zenlev migrate tree --env staging --show-supersedes --format mermaid
bun run zenlev migrate status --env staging --json
bun run zenlev migrate apply --env staging --namespace pre-deploy --plan-only --json
bun run zenlev migrate apply --env staging --namespace deploy --plan-only --json
bun run zenlev migrate apply --env staging --namespace post-deploy --plan-only --json
```

Replace `staging` and the namespace names with the actual destination and labels. In JSON, inspect `result.plan.blockers` even when the transport or wrapper reports success. Show each blocker and stop if it remains unresolved.

For machine-readable evidence, save the CLI response to a temporary JSON file and run [check-plan.ts](scripts/check-plan.ts) with Bun. Resolve the script relative to the loaded skill directory. It reads the JSON only. Exit 0 means no blockers, 1 reports blockers, and 2 means the input could not be interpreted.

```sh
bun "$SKILL_DIR/scripts/check-plan.ts" ./post-deploy-plan.json
```

Set `SKILL_DIR` to the resolved deployment skill directory. A clear summary still requires reviewing warnings and confirming permission to apply.

For an expand/deploy/contract rollout, make deploy depend on expansion and contract depend on deploy. The application deployment itself remains an operator-controlled step between migration stages.

Cross-namespace edges are valid and IDs are global within the ledger. A pending prerequisite outside the selected namespace produces `PENDING_PREREQUISITE`; the planner does not silently add it. Apply its intended stage first or deliberately revise the selection. An already applied prerequisite satisfies the edge.

`--from` includes descendants; `--to` includes ancestors. These bounds intersect with `--namespace`, `--tags`, and `--only`. Combining filters narrows the scope. Independent migrations run in lexical ID order, not parallel execution.

Supersedes rewrites future graph edges transitively and preserves recorded history. The later creation timestamp wins; lexical ID breaks equal timestamps. Superseding metadata does not perform database changes: the replacement handler must establish the intended state.

Real application takes the lock, rereads history, verifies hashes, and replans. Preview success is not a reservation. Never change IDs or remove dependencies merely to conceal a blocker.

Completion evidence: show selected IDs per stage, cross-stage prerequisite satisfaction, supersedes effects, and zero unresolved blockers.

- [Deployment workflow](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/deployments)
- [Namespace selection](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/namespaces)
- [Graph and supersedes](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/graph)
