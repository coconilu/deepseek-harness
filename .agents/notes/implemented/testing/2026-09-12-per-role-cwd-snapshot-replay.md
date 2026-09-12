# Agent Note: Per-role cwd replay in recorded-session snapshots

Status: implemented

English | [中文](2026-09-12-per-role-cwd-snapshot-replay.zh.md)

## Problem

Recorded-session fixtures tokenize each session log against that log's own session header: the header cwd and every absolute path ending at that cwd's basename become the `{{cwd}}` token. Comparison normalized every log of a run under the primary session's cwd instead. The two contracts agree only while every child session shares the parent's cwd, and that agreement hid a structural gap: a child session whose recorded cwd differs from the parent's — the real tower-mission topology, where the mission child runs in its git worktree under `.tower/worktrees/` — compared as `{{cwd}}/<worktree suffix>` against a child fixture tokenized to bare `{{cwd}}`. Every child-rooted absolute path mismatched the same way. The gap blocked keyless coverage of the real tower mission-child topology and forced the tower-merge-flow scenario to run its mission child in the lead's cwd with worktree-relative paths. A tower-activated Web snapshot fixture was also missing; recording it requires a live API-key lane this work did not have.

## Decision

The headless snapshot harness normalizes per session role. Session-log comparison (`normalizeSessionSnapshotsPerRole`), refresh stabilization, and child prompt sidecars each derive their volatile-value context from the log's own header cwd; the shared primary context remains only where the compared values carry no cwd — request-header pins. Logs whose cwd equals the primary's normalize identically under either context, so every pre-existing fixture is unaffected. Cross-log typed identity redaction stays global, so `{{session:N}}` relationships survive the per-role split. A suite-level test pins the fixpoint: a child log whose header cwd sits under the parent's normalizes byte-equal to its committed fixture, and the shared-context path demonstrably does not.

The constraint this contract inherits from own-header tokenization: absolute references that cross between a child cwd and the parent cwd have no stable token form, and scenarios must keep them out of child logs. The tower-mission-worktree scenario satisfies this by construction — the child's mission prompt carries no paths and the child addresses its workspace with relative paths — while the parent log records the worktree path parent-anchored as `{{cwd}}/.tower/worktrees/m-1`.

### The tower-mission-worktree scenario

The scenario (`snapshots/session/tower-mission-worktree/`) proves the real topology end to end: a scenario-local deterministic tower provider forks a real git worktree (`git worktree add .tower/worktrees/m-1 -b tower/m-1 main`) and starts the mission child session with the worktree as its durable session cwd — the exact topology the [tower-merge-flow](2026-08-24-session-log-snapshot-corpus.md) fixture provider documents routing around. Its git workspace setup variant commits an empty root, keeping seeded workspaces free of pairing-gated README files; the pinned dates and identity still reproduce stable hashes.

The scenario declares `platform: posix` for the reason the merge-flow scenario already recorded: tower tool results embed JSON-stringified workspace paths, and Windows backslash escaping defeats cwd tokenization at that string level. The required macOS/Linux lane replays it; Windows skips the run test while the fixture guards still cover the committed bytes everywhere.

### Tower-activated Web fixture follow-up

The Web composer's Tower chip reads the `tower` projection, which derives from the session log's recorded `tower/mode` activation, so a Web-lane scenario whose session log carries that activation is the fixture shape. Recording it through `DSH_SNAPSHOT=record` requires `DEEPSEEK_API_KEY`; the environment that built this decision had none, so the fixture is deferred rather than hand-authored — the chip's pending/effective-target semantics should be pinned against one live recording before an authored fixture freezes them.

## Alternatives considered

**Per-role cwd aliases inside `@deepseek-ai/dsh-session-snapshot`.** Extending `NormalizeContext` with per-role cwd aliases — the test-support finding's original suggestion — is the systemic home and would also fix fixture tokenization and refresh alignment in one place. It lost here only on scope: the M16 change owns `snapshots/**`, and the package change deserves its own design pass. It remains the right follow-up if more role layouts appear.

**Tokenizing child fixtures through a parent-cwd header rewrite.** Rewriting a child log's header cwd to the parent's before tokenizing, then restoring the `{{cwd}}/<suffix>` form, would put the worktree suffix into the committed child header. It was rejected: the suffix-bearing token becomes the tokenizer's own anchor at refresh, which strips the suffix from every already-tokenized body path and re-anchors on the worktree basename, corrupting write-back. The comparison-side per-role contract achieves stability without touching fixture tokenization.

**Relative worktree paths in tool results.** Rendering the mission view with a worktree-relative path would remove every absolute path from the lead's log and make the scenario Windows-runnable. It was rejected because the committed bytes could no longer distinguish a child that ran in the worktree from one that ran in the parent cwd — the workspace oracle would carry the whole proof, weakening the fixture.

## Consequences

Recorded-session coverage now represents the real tower mission-child topology keylessly, and the harness contract matches the fixture contract it compares against instead of relying on the child-cwd-equals-parent coincidence. The cost is a two-sided constraint fixture authors must hold: child logs may not reference parent-cwd absolute paths, and scenarios whose tool results JSON-embed workspace paths stay on the POSIX lane. The tower-merge-flow scenario may now adopt the real worktree-child topology on that lane; this note's per-role harness contract and its scenario stand independently until then.
