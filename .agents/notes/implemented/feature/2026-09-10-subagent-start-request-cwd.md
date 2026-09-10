# Agent Note: Per-child working directory on subagent start

Status: implemented

English | [中文](2026-09-10-subagent-start-request-cwd.zh.md)

## Problem

Every in-process subagent child inherited the parent session's `cwd`: `childSessionMeta` stamped `parentHeader.cwd` with no override, and out-of-process backends resolved only a deployment-wide `cwd` config or that same parent value. A coordinator that prepares an isolated workspace per child — one git worktree per parallel task, a scratch tree per experiment — could not bind the child to it through the seam. Its options were forking provider code or relocating the parent's whole session, and the second breaks the single-workspace assumption for siblings that should keep sharing it.

## Decision

`SubagentStartRequest` gains an optional `cwd`: an absolute path to an existing, enterable directory that becomes the child session's durable `cwd` — the workspace its tools resolve against — instead of the inherited parent value. Validation happens at start, before any child resource exists, through the out-of-process seam's existing `assertUsableCwd`, so relative paths and inaccessible directories fail with one diagnostic vocabulary on both the one-shot and continuable paths. The value rides the session header, which persistence and cold resume already honor, so neither the descriptor nor the resume path changes.

The one-shot path gates the option behind a new `SubagentCapabilities.cwd` flag, preserving the seam's one-flag-per-request-option symmetry, and both in-process providers advertise it: they stamp the child session themselves. The continuation manager composes every continuable child regardless of provider, so it honors `cwd` for any continuable provider without consulting the flag — the same division the other start-time features already follow, because the flags describe only `SubagentProvider.start`.

Out-of-process providers (ACP, Codex, Claude Code, DSH SDK) advertise `cwd: false`: their child working directory still comes from the deployment override or the parent session, and a request naming `cwd` is rejected before the transport starts.

## Alternatives considered

**Thread per-request `cwd` through the out-of-process providers.** Rejected: no current Consumer needs it, and each backend would add wire-level plumbing and tests for an unexercised path. The flag keeps rejection loud, so extending a provider later is additive.

**Expose `cwd` on the model-facing delegation tool.** Rejected: choosing a workspace is an orchestrator decision, not model input; no current Consumer needs it, and the tool schema stays stable for request-cache reuse.

**Record `cwd` in the subagent descriptor.** Rejected: the session header already persists the value and resume reads the header; a second copy would create two authorities for one fact.

## Consequences

Every `SubagentCapabilities` literal in the tree gained the flag in the same change (pre-stable API; consumers updated together). Providers must now take an explicit position on per-request workspaces instead of silently inheriting a default. A rejected `cwd` provisions nothing: validation precedes id reservation on the continuable path and provider dispatch on the one-shot path.

## Testing

Unit tests cover capability rejection, relative and inaccessible path rejection on both start paths, verbatim pass-through, and the child header stamp with and without the override. Recorded-session snapshots are unaffected because `cwd` only changes behavior when supplied.
