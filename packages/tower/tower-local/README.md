---
description: "The local tower provider for maintainers choosing, configuring, or debugging the .tower/ coordination store, git-worktree missions, and mission child lifecycle."
kind: "package-reference"
---

# @deepseek-ai/dsh-tower-local

English | [中文](README.zh.md)

## Summary

`dsh-tower-local` is the shipped tower provider: it registers the `local` backend on `ctx.tower`, keeps the coordination store in the workspace's `.tower/` directory, drives git worktrees through the subprocess seam, and runs each mission child as a continuable subagent bound to its own worktree. Missions branch from the recorded base, talk through lead-mediated messages, and merge back only after a review round approves the exact tip commit. Compose it whenever the tower capability should operate on a local git repository; a deployment wanting another backend implements the provider contract instead.

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

Add one composition row after the tower service; the provider registers itself under the name `local`, which the service selects by default.

### When to choose it

Choose this provider when the tower workspace is a local git checkout and mission children can run in-process as continuable subagents. It is the only shipped provider; alternative backends register their own `TowerProvider` implementations beside it. Skip it only when the tower service is composed for contract or testing purposes without a backend.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-tower'
  config:
    section: ...
- name: '@deepseek-ai/dsh-tower-local'
```

| Field | Default | Meaning |
|---|---|---|
| `childProvider` | `'spawn'` | `ctx.subagents` provider name that composes mission children |
| `childToolFilter` | `[]` | Tool names denied from every mission child's tool set |
| `activityTail` | `50` | Maximum activity entries one dashboard status returns |

A blank name, an unknown key, or a non-positive bound fails plugin load. A `childToolFilter` entry that is unknown or reserved fails the mission child's start loudly.

### The on-disk workspace

`tower init` creates the store at the session's git toplevel, or adopts an existing one whose recorded base matches the session's tower base. The layout is one directory per workspace:

```text
.tower/
  workspace.json        # version 1: base, root, createdAt
  missions/m-<n>.json   # one durable record per mission, whole-value replaced
  reviews/m-<n>.jsonl   # append-only review rounds per mission
  messages.jsonl        # append-only lead-mediated messages
  findings.jsonl        # append-only shared findings
  activity.jsonl        # append-only activity record
  worktrees/<id>/       # one git worktree per mission
```

Every read validates the records against their schemas; a corrupt store fails loudly instead of guessing. The provider adds `/.tower/` to the repository's `info/exclude` so the coordination store never enters status or commits. Adoption reconciles `spawning` and `active` missions whose owner session is no longer live to `interrupted`, keeping branch and worktree for review and merge.

### Mission lifecycle

`tower_spawn` allocates the next `m-<n>` id, forks the base into a worktree at `tower/<id>`, and starts a child through the `childProvider` with `cwd` set to the worktree; a worktree failure marks the mission `failed`, and a child-start failure also rolls the worktree and branch back. `tower_mission` with `abort` interrupts the live child (its inbox survives) and marks the mission `aborted`; the branch and worktree stay for inspection. `tower_merge` refuses unless the mission is `approved`, the latest approving review round's commit still equals the branch tip, the mission worktree is clean, and the main checkout sits on the recorded base — then it merges with `--no-ff`, removes the worktree, and marks the mission `merged`. `tower_teardown` drains the caller's live mission children and removes worktrees, keeping dirty ones and reporting them unless `force` is set; the `.tower/` record stays as the audit trail.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the package; the observable behavior is covered in [Use this package](#use-this-package).

### One serialized store, git at decision time

Durable state lives in the store, live state in the agents registry, and every git fact is re-read at decision time. A single FIFO promise queue serializes storage transactions — id allocation, record writes, journal appends — and its tail never rejects, so a failed transaction does not wedge later ones. Subagent seam calls (child creation, message delivery, interrupts, drains) never run inside the queue, because child lifecycle callbacks can re-enter the tower service while it operates. `isMissionOwner` stays outside the queue by contract so it can answer while a spawn transaction is in flight.

### Messages, findings, and activity

A message is journaled before delivery: `lead` receives it as a parent-inbox notice, one mission id through the live lead as mediator, and `all` fans out to every live mission child except the sender; a delivery failure leaves the record pullable from the inbox. Findings are append-only records any participant can read. Every operation appends one activity entry and emits the synchronous `tower-local/activity` event at commit time, inside the storage transaction, so observers see entries in journal order.

### The invariant companion

The `./invariant` entry installs the merge-review contract: every `merge` activity entry must be backed by an approving review round for the exact merged commit in the same workspace. The activity journal and the review journals are independent records, so a merge recorded without its review means the gate was bypassed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: name, injections, `Config` schema, provider registration |
| [`src/provider.ts`](src/provider.ts) | `LocalTowerProvider`: workspace, missions, messages, reviews, merge gate, teardown |
| [`src/store.ts`](src/store.ts) | The `.tower/` store: zod-validated records, id allocation, append-only journals |
| [`src/git.ts`](src/git.ts) | Git worktree and branch operations driven through the subprocess seam |
| [`src/events.ts`](src/events.ts) | The commit-time `tower-local/activity` event and its payload |
| [`src/error.ts`](src/error.ts) | `TowerLocalError` with machine-routable codes (`NO_GIT`, `NO_WORKSPACE`, `TOWER_LOCAL`) |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: the merge-review contract over the activity event |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tower subsystem reference](../../../docs/subsystems/tower.md) — the workspace, mission, review, and message vocabulary and the full provider contract.
- [dsh-tower](../tower/README.md) — the Service Definition this provider registers under.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the continuable-child seam the provider composes mission children through.
- [Runtime invariants](../../../docs/subsystems/invariants.md) — the registry the invariant companion installs into.
- [tower/ package map](../README.md) — the group and its three packages.

-----

<a id="model-experience"></a>
## Model Experience

### Mission child composition

#### What the model sees

The provider registers no prompt section or tool schema of its own. A mission child's model reads the task text the lead wrote as the spawn `prompt` plus tower messages addressed to it, and every name in `childToolFilter` disappears from the child's tool catalog before its first request.

#### Token effect

The provider adds nothing to any request directly. A spawned mission child pays for its self-contained prompt once, and the denied tool schemas shrink the child's catalog.

#### KV Cache effect

The provider never mutates a request prefix; a mission child's catalog is fixed at its start, so its prefix stays stable while its conversation grows.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you when the provider does not fit or needs extra care. They are current package constraints, not a task backlog.

- **Local git only** — the store assumes one local git work tree; there is no remote or networked backend, and remote-tracking refs and tags do not qualify as tower bases.
- **Storage serialization is in-process** — the FIFO queue serializes one provider instance's transactions; two concurrent processes sharing one workspace race at the filesystem level rather than coordinating.
- **Delivery is record-then-best-effort** — a message delivery failure leaves the record pullable from the inbox but does not retry on its own.
- **Merge needs the main checkout on the base** — the gate refuses while the main checkout sits on another branch, even when every mission-side condition passes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
