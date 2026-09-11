---
description: "The tower package group: the capability seam and model-facing tools that let a lead session fan missions out to isolated git worktrees and merge them back through a review gate."
kind: "package-group"
---

# tower/ — mission coordination over git worktrees

English | [中文](README.zh.md)

## Summary

The tower group lets one lead session coordinate parallel work as missions: each mission runs in its own git worktree branched from a recorded base, talks to the lead through mediated messages and shared findings, and lands only after a review round approves its exact tip. The three packages split the capability seam into its Service Definition, its shipped provider, and its model-facing Consumer; a profile opts in through the tower bundle. Choose this group when a lead should drive the whole workflow, not only watch it.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The seam follows the three-role split: the service owns the logged mode and authority, the provider owns the workspace, and the consumer owns the tool schemas.

| Package | Role |
|---|---|
| [`tower`](tower/README.md) | Service Definition: logged tower mode, the `/tower` command, the `tower:policy` section, and the caller-authority-validating `ctx.tower` facade |
| [`tower-local`](tower-local/README.md) | Service Provider: the `local` backend — the `.tower/` coordination store, git worktrees, and mission child lifecycle |
| [`tool-tower`](tool-tower/README.md) | Consumer: the ten `tower_*` tools with executor-side authority and approval-gated merge and teardown |

<a id="related-documentation"></a>
## Related documentation

- [Tower subsystem reference](../../docs/subsystems/tower.md) — the workspace, mission, review, and message vocabulary and the full service and provider contracts.
- [dsh-tower-profile](../bundle/tower/README.md) — the opt-in profile layer that mounts the three packages over `dsh-base`.
- [Tower coordination Agent Note](../../.agents/notes/implemented/feature/2026-09-11-tower-capability.md) — the design decision and its alternatives.

<a id="dev-note"></a>
## Dev Note

None.
