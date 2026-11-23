---
name: zenlev-deployment-planning
description: Plan Zenlev deployments across pre-deploy, deploy, and post-deploy namespaces. Use for cross-stage prerequisites, intersecting selections, supersedes, or deployment blockers.
metadata:
  type: core
  library: '@mwillbanks/zenstack-zenlev'
sources:
  - website/content/docs/guides/deployments.mdx
  - website/content/docs/guides/namespaces.mdx
  - website/content/docs/guides/graph.mdx
  - src/graph.ts
  - src/execution.ts
---

# Plan stages through dependencies

1. Confirm the destination selected by `--env`. Treat namespace labels as stages within its shared ledger.
2. Read the effective graph, including stored history and superseding definitions.
3. Preview each intended stage. Resolve blockers before running that stage.
4. Apply only within the authorized destination and deployment stage. Reinspect before advancing to the next stage.

```sh
bun run zenlev migrate tree --show-supersedes --format mermaid
bun run zenlev migrate apply --namespace pre-deploy --plan-only --json
bun run zenlev migrate apply --namespace deploy --plan-only --json
bun run zenlev migrate apply --namespace post-deploy --plan-only --json
```

For an expand/deploy/contract rollout, make deploy depend on expansion and contract depend on deploy. The application deployment itself remains an operator-controlled step between migration stages.

Cross-namespace edges are valid and IDs are global within the ledger. A pending prerequisite outside the selected namespace produces `PENDING_PREREQUISITE`; the planner does not silently add it. Apply its intended stage first or deliberately revise the selection. An already applied prerequisite satisfies the edge.

`--from` includes descendants; `--to` includes ancestors. These bounds intersect with `--namespace`, `--tags`, and `--only`. Combining filters narrows the scope. Independent migrations run in lexical ID order, not parallel execution.

Supersedes rewrites future graph edges transitively and preserves recorded history. The later creation timestamp wins; lexical ID breaks equal timestamps. Superseding metadata does not perform database changes: the replacement handler must establish the intended state.

Real application takes the lock, rereads history, verifies hashes, and replans. Preview success is not a reservation. Never change IDs or remove dependencies merely to conceal a blocker.

Completion evidence: show selected IDs per stage, cross-stage prerequisite satisfaction, supersedes effects, and zero unresolved blockers.

- [Deployment workflow](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/deployments)
- [Namespace selection](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/namespaces)
- [Graph and supersedes](https://mwillbanks.github.io/zenstack-zenlev/docs/guides/graph)
