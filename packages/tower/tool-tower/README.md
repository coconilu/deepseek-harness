---
description: "The model-facing tower tools for maintainers choosing, configuring, or debugging the ten tower_* tools, their authority rules, and their approval-gated merge and teardown."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-tower

English | [中文](README.zh.md)

## Summary

`dsh-tool-tower` registers the ten `tower_*` tools a model uses to operate a tower: create or adopt the workspace, spawn and monitor missions in their worktrees, exchange messages and findings, record review rounds, and merge or tear down through explicit user approval. Lead-only operations require the calling session's tower mode; the message and finding tools also admit a recorded mission owner. Compose it beside `dsh-tower` and a provider whenever the model — not just a human command — should drive the mission workflow.

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

Add one composition row; the tools register on `ctx.tools` and reach the tower capability through `ctx.tower`.

### When to choose it

Choose this package when a tower-capable composition should be drivable from the model. Without it, the tower service remains a programmatic seam with no model-facing entry points. The tools assume a tower provider is composed; with the tower profile bundle all three packages arrive together.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-tower'
  config:
    section: ...
- name: '@deepseek-ai/dsh-tower-local'
- name: '@deepseek-ai/dsh-tool-tower'
```

| Field | Default | Meaning |
|---|---|---|
| `maxInbox` | `20` | `tower_inbox` bound when the model omits `limit`, and the ceiling every explicit limit clamps to |

Out-of-range bounds fail plugin load. This is the complete configuration.

### The tool set

| Tool | Authority | Purpose |
|---|---|---|
| `tower_init` | lead-only | Create or adopt the workspace at the calling session's git root |
| `tower_status` | lead or mission owner | Read the dashboard: missions, findings count, activity tail |
| `tower_spawn` | lead-only | Fork one mission worktree and start its child agent |
| `tower_mission` | lead-only | Mission control (`abort`) |
| `tower_send` | lead or mission owner | Send one message to `lead`, one mission id, or `all` |
| `tower_inbox` | lead or mission owner | Read messages addressed to this session, newest last |
| `tower_finding` | lead or mission owner | Record one shared finding or list the findings |
| `tower_review` | lead-only | Record one review round, stamping the branch tip |
| `tower_merge` | lead-only, approval-gated | Merge one approved mission branch into the base |
| `tower_teardown` | lead-only, approval-gated | End the workspace's active work |

`tower_merge` and `tower_teardown` ask the composed approval seam for the user's decision before delegating; every other tool acts without a prompt. Authority is enforced twice by design: at this executor, which a caller can invoke directly, and again inside the facade.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the package; the observable behavior is covered in [Use this package](#use-this-package).

### Declared results, compact rendering

Every tool declares its complete result schema and renders that value as compact JSON, so the compiler checks each `execute` against what the model is promised and no result spends tokens on indentation. Mission rows drop the original `prompt` (the authoring session already holds the task text it wrote) and the opaque `owner` session id.

### Approval-gated operations

Before merging or tearing down, the tool reads the dashboard, describes the real target to the user, and requires the outcome `allowed-once`; a missing approval seam fails closed, and any other outcome fails the call with a message that nothing was done. An unknown mission id skips the prompt and lets the facade fail loudly below — the race window can only turn an approved merge into a refused one, never the reverse.

### Mission children and the tool filter

The package exports `MISSION_TOOL_FILTER`, a deny list of the six lead-only tool names for composing mission children through their start `toolFilter`; the tools' own authority gate remains the second line of defense when the filter is absent, so a filtered child never sees the names and an unfiltered child fails execution loudly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the ten tool registrations, `MISSION_TOOL_FILTER`, authority and approval helpers |
| — | No runtime invariant companion is published: the tools adapt the facade, whose provider owns every durable relation the invariants check. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tower subsystem reference](../../../docs/subsystems/tower.md) — the workspace, mission, review, and message vocabulary the tools project.
- [dsh-tower](../tower/README.md) — the facade the tools adapt.
- [dsh-tower-local](../tower-local/README.md) — the shipped provider executing the operations.
- [Approval subsystem](../../../docs/subsystems/approval.md) — the one-shot user-approval seam `tower_merge` and `tower_teardown` ask.
- [tower/ package map](../README.md) — the group and its three packages.

-----

<a id="model-experience"></a>
## Model Experience

### Tower tools and results

#### What the model sees

While the package is composed, the model reads the ten `tower_*` tool schemas in every request, regardless of tower mode; results arrive as compact JSON matching the declared schemas. A refused `tower_merge` or `tower_teardown` returns the failure text that "nothing was done — do not retry without the user's explicit approval", and the approval question itself is presented to the user, not the model.

#### Token effect

The ten schemas are paid on every request of a composed profile; each result adds only its compact JSON, and `tower_inbox` bounds its page by `maxInbox`.

#### KV Cache effect

The tool schemas register at composition and never change, so the request prefix stays stable; tool results append as ordinary conversation growth.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you when the package does not fit or needs extra care. They are current package constraints, not a task backlog.

- **Approval seam required for merge and teardown** — without a composed approval service, `tower_merge` and `tower_teardown` fail closed rather than act unprompted; other tools do not ask.
- **The filter hides, it does not authorize** — `MISSION_TOOL_FILTER` requires this package to be composed and shapes visibility; a child composed without it still sees the lead-only names and fails at execution.
- **Model-initiated dispatch required** — every tool needs the calling `Agent` the registry attaches on model-initiated dispatch; a direct executor call without one fails.
- **The inbox bound is bounded twice** — `maxInbox` caps both the omitted-`limit` default and every explicit limit, so a model cannot page the journal beyond the configured ceiling.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
