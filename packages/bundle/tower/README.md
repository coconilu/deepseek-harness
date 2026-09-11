---
description: "Tower profile layer for dsh: fan missions out to isolated git worktrees and merge them back through a review gate, opted in per profile over dsh-base."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tower-profile

English | [中文](README.zh.md)

## Summary

`dsh-tower-profile` makes tower mode available in an initialized profile: a lead session fans work out as missions into isolated git worktrees, watches them through a coordination store, and lands each one back onto the base through a review gate. The layer mounts the tower capability, its local provider, and the ten tower_* tools over [`@deepseek-ai/dsh-base`](../base/README.md); nothing changes until the user turns tower mode on in a session with `/tower on <base>`. Add the package explicitly to a profile; no shipped profile enables it by default.

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

### Install into a profile

Add the package to an initialized profile, then turn tower mode on inside a session:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-tower-profile
dsh --profile <name> "Split this refactor into missions and land them one by one."
```

The profile must already contain `@deepseek-ai/dsh-base`: the layer rides after it and consumes its Subagent and subprocess services, its tool registry, and its command registry. In a session, `/tower on <base>` activates tower mode; `<base>` must name a local branch of the repository the session works in. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-tower-profile` removes the layer from the profile's ordered bundle list.

### What you get

The layer adds three composition rows after `dsh-base`: the tower Service Definition carrying this bundle's model-facing policy text (rendered as the `tower:policy` prompt section while tower mode is active), the `local` provider that owns the `.tower/` coordination store, the git worktrees, and the mission children, and the tower tool consumer registering the ten tower_* tools.

In tower mode the lead calls `tower_init` once to create or adopt the workspace, spawns missions with `tower_spawn` (each in its own worktree branched from the base, driven by a child agent), monitors through `tower_status`, exchanges messages through `tower_send` and `tower_inbox`, records shared discoveries with `tower_finding`, records review rounds with `tower_review`, and lands approved missions with `tower_merge`. `tower_mission` aborts one mission; `tower_teardown` ends the workspace's active work. `tower_merge` and `tower_teardown` ask the user for approval before acting.

The shipped bounds: eight unmerged missions per workspace (`maxMissions: 8`), mission children composed through the `spawn` provider, and the policy text shipped by this bundle as the Service Definition's `section`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml): one insert patch of three rows applied after `dsh-base`. The Service Definition row sets the policy `section` verbatim, `provider: local`, and `maxMissions: 8`; the provider row sets `childProvider: spawn`; the tool consumer row carries no config and keeps the tool default inbox bound. The package test pins the patch rows and boots them through the real Loader, asserting the /tower command, the ten tower_* tools, and the verbatim policy section on the composed tree.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The three-row insert patch over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | Patch pin and real Loader composition of the three plugins |
| — | No runtime invariant companion is published; the patch holds no mutable relation, and the three tower packages own the invariants it activates. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle package map](../README.md) — the installable layers `dsh --profile` stacks.
- [dsh-base](../base/README.md) — the shared core this patch extends.
- [Profile plugin bundles note](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md) — the profile and bundle composition design.
- [dsh app](../../../apps/cli/README.md) — the `dsh` command that starts a profile and manages its packages.

-----

<a id="model-experience"></a>
## Model Experience

### Tower policy and tools

#### What the model sees

The policy text belongs to this bundle (the Service Definition's `section` config); the tool schemas and descriptions belong to the tower tool consumer. The bundle changes composition only: the three rows make the `/tower` command, the ten tower_* tools, and the `tower:policy` prompt section available.

#### Token effect

The layer adds nothing while tower mode is off. While it is on, the model reads the policy section text and the ten tool schemas.

#### KV Cache effect

The composition is prefix-stable while the patch and configured bounds stay unchanged; the policy section enters and leaves the request prefix with tower mode.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits tell you when the layer does not fit. They are current package constraints, not a task backlog.

- **Opt-in only** — the package is public, but no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Base profile required** — the patch depends on row ids, Subagent and subprocess services, and the command registry supplied by `dsh-base`; it is not a standalone profile.
- **Approval seam required for merge and teardown** — without a composed approval service, `tower_merge` and `tower_teardown` fail closed rather than act unprompted.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
