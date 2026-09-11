---
description: "The tower capability Service Definition for deployments choosing, configuring, or debugging logged tower mode, the /tower command, and the mission coordination facade."
kind: "package-reference"
---

# @deepseek-ai/dsh-tower

English | [中文](README.zh.md)

## Summary

`dsh-tower` turns tower mode on and off and owns every tower operation a session can perform: a lead session fans work out as missions into isolated git worktrees, watches them through a coordination store, and lands each mission back onto its base only through a review gate. You select the mode with `/tower on <base>`; the state survives resume and forks, and your policy text guides the lead while the mode is active. Choose it when one session should coordinate parallel work instead of doing everything itself; git and child-agent mechanics live in the provider you compose.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service, select a provider, and enter tower mode in a session; the common path is `/tower on <base>` followed by the tower tools the model-facing consumer registers.

### When to choose it

Choose this package when a deployment wants lead-driven mission work with an explicit, reviewable merge gate. It is the capability seam's Service Definition: it owns the logged mode and the facade, while `@deepseek-ai/dsh-tower-local` owns the `.tower/` store, git worktrees, and mission children, and `@deepseek-ai/dsh-tool-tower` owns the model-facing tools. Skip it when one session's ordinary tools already cover the work.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-tower'
  config:
    section: |
      Tower mode is active: you are the lead. Fan work out with the tower_*
      tools and land missions only through the review gate.
- name: '@deepseek-ai/dsh-tower-local'
- name: '@deepseek-ai/dsh-tool-tower'
```

| Field | Default | Meaning |
|---|---|---|
| `section` | required | Policy rendered as the `tower:policy` prompt section while tower mode is active |
| `provider` | `'local'` | Registry name of the tower provider the facade delegates to |
| `maxMissions` | `8` | Maximum unmerged missions per workspace, enforced when a mission is spawned |

A blank `section`, an unknown key, or a non-positive bound fails plugin load. These three fields are the complete configuration; the provider and tool packages carry their own tables.

### Entering and leaving tower mode

Type `/tower on <base>` to activate tower mode on a local branch of the session's repository; the base is validated before anything is logged, so a typo fails without changing state. Type `/tower off` to leave, and `/tower status` to read the current mode. A selection made while a turn is open applies from the next accepted step, and the command tells you so; an unchanged selection is a no-op.

<a id="model-and-human-interactions"></a>
### What tower mode changes

While the mode is active the lead reads your `section` policy and can call the tower tools composed beside this package; while it is inactive those tools fail their authority check. Every operation is validated twice: the facade requires the calling session's tower mode for workspace and review operations, admits a recorded mission owner for the dashboard, message, and finding operations as well, and only then delegates to the selected provider.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the package; the observable behavior is covered in [Use this package](#use-this-package).

### One logged mode, one facade

The durable stance mirrors plan mode: one log-only, whole-value-replace `tower/mode` session event, and the last logged value is the state. The `tower` projection folds the event together with `/tower` command runs, so resume, fork, and compaction recover the mode from the log alone, and client carriers read the cropped `{ active, pending, base? }` view. A selection appends immediately between turns; during an open turn it stays pending until the next accepted in-turn pre-step appends it — the only append point while an agent runs — and a failed append cannot block the step, remaining pending for a later attempt.

### Authority and delegation

The service validates the caller before every operation: `init`, `spawnMission`, `abortMission`, `recordReview`, `merge`, and `teardown` require the calling session's tower mode to be active, while `status`, `sendMessage`, `inbox`, `recordFinding`, and `listFindings` also admit the recorded owner of an unmerged mission — a durable check that reads the provider's mission records and survives cold resume. After authority passes, the facade delegates to the provider named by `provider` and re-checks `maxMissions` at spawn time.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, the `ctx.tower` facade, `tower:policy` section, `/tower` command, projection registration |
| [`src/types.ts`](src/types.ts) | The provider and workspace vocabulary, the `tower` projection types, and the `ctx.tower` declaration |
| — | No runtime invariant companion is published: the mode has a single authority — the session log — and the projection fold is pinned by tests, so no second observation can diverge from it. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tower subsystem reference](../../../docs/subsystems/tower.md) — the workspace, mission, review, and message vocabulary and the full service contract.
- [tower/ package map](../README.md) — the group and its three packages.
- [dsh-tower-local](../tower-local/README.md) — the shipped provider: the `.tower/` store, git worktrees, and mission children.
- [dsh-tool-tower](../tool-tower/README.md) — the ten model-facing tower tools.
- [Tower coordination Agent Note](../../../.agents/notes/implemented/feature/2026-09-11-tower-capability.md) — the design decision and its alternatives.

-----

<a id="model-experience"></a>
## Model Experience

### Tower policy system prompt

#### What the model sees

While tower mode is active — or a pending activation is selected — the model reads the exact `section` text as the `tower:policy` prompt section; inactive mode contributes no text.

##### Configuration example

```markdown
Tower mode is active: you are the lead. Fan work out with the tower_* tools and land missions only through the review gate.
```

#### Token effect

Inactive mode adds no tokens; active mode adds the configured section to every request.

#### KV Cache effect

The section is stable while the mode stays active, but entering or leaving changes the system prompt from the section's position onward.

### Mode changes and the command

#### What the model sees

`/tower`, its results, and the `tower/mode` event are log-only: none of them enters model history, and entering or leaving tower mode changes no tool catalog — this package registers no tools. The projection view reaches client carriers, not the model.

#### Token effect

Mode transitions cost no model tokens; the only model-visible change is the policy section above.

#### KV Cache effect

The logged mode never mutates a request prefix; only the policy section's presence moves the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you when the package does not fit or needs extra care. They are current package constraints, not a task backlog.

- **Required projection keys** — mode reads need the `tower` and `turnBoundary` projection keys; the first dependent access fails loudly when the registry or either key is absent.
- **No policy default** — the service renders exactly the configured `section` text and ships no policy of its own; the tower profile bundle owns the shipped text.
- **Pending selections are process-local** — a selection made after the turn's final accepted pre-step is lost if the process exits before another accepted in-turn pre-step; the command result already reported the queued state.
- **The command needs the commands service** — `/tower` registers only when a command registry is composed; other entry points can still drive `ctx.tower` directly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
