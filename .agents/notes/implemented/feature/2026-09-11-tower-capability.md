# Agent Note: Tower coordination over isolated git worktrees

Status: implemented

English | [中文](2026-09-11-tower-capability.zh.md)

## Problem

Continuable subagents and [Agent Teams](2026-08-05-agent-teams.md) give one lead session parallel children, but every child shares the parent's checkout: file tools can reject stale versions while Bash, formatters, and generators bypass that fence, and the Teams note deliberately leaves worktree isolation out of that domain. A lead that splits a large change across parallel children therefore has no owned path from "fan out" to "land": per-mission branches, a reviewable gate, a controlled merge onto the base, and an audit trail of who did what are all deployment improvisation.

The coordination state also has no home that outlives one session. Subagent inbox and Team roster state are session- or process-scoped, while mission work must survive child settlement, lead restarts, and cold resume, and be adoptable by a later lead session without re-deriving what happened.

## Decision

Tower is a three-package capability seam on `ctx.tower`, opt in per profile through the `dsh-tower-profile` bundle over `dsh-base`; no shipped profile enables it. `dsh-tower` is the Service Definition: it owns one log-only, whole-value-replace `tower/mode` session event folded by the `tower` projection (plan-mode machinery — between-turn selections commit immediately, in-turn selections stay pending until the next accepted pre-step), the `/tower` command whose `on <base>` selection is validated through the provider before anything is logged, the `tower:policy` prompt section rendered while the mode is active, and the caller-authority-validating facade every operation crosses. `dsh-tower-local` is the shipped Service Provider: the `.tower/` coordination store at the workspace git root, git worktrees driven through the subprocess seam, and mission children composed as continuable subagents with `cwd` bound to the mission worktree — the per-child working directory of [the subagent start-request note](2026-09-10-subagent-start-request-cwd.md). `dsh-tool-tower` is the model-facing Consumer: ten `tower_*` tools whose authority is enforced at the executor and again inside the facade.

Authority splits by operation. Workspace, review, and lifecycle operations (`init`, `spawnMission`, `abortMission`, `recordReview`, `merge`, `teardown`) are lead-only — the calling session must carry active tower mode. The comms set (`status`, `sendMessage`, `inbox`, `recordFinding`, `listFindings`) additionally admits the recorded owner of an unmerged mission, read from the mission record so it stays valid across cold resume. Mission children compose through the configured `childProvider`, and the deployment's `childToolFilter` denies tool names from every child's set; `dsh-tool-tower` exports `MISSION_TOOL_FILTER` so children can be denied the six lead-only tool names at visibility, while execution-time authority remains the second line of defense.

Durable mission state is file-backed, not session-logged: `workspace.json`, per-mission records, and append-only message, finding, activity, and review journals live in `.tower/`, every read zod-validates them, and adopting an existing workspace — same recorded base — carries unmerged missions over and marks missions whose owner is no longer live `interrupted`. The lead session log carries only the mode, so "model-visible means logged" stays intact while the workspace remains multi-session durable.

## The merge gate

A merge proceeds only when the mission is `approved`, the latest review round is an approval whose recorded commit still equals the branch tip, the mission worktree is clean, and the main checkout sits on the recorded base; the merge is `--no-ff` and records the merge commit on the activity journal. The tip-match condition makes every verdict apply to an exact commit, so any post-review change re-opens the mission. `tower_merge` and `tower_teardown` additionally require the user's approval through the approval seam and fail closed when it is absent. A package invariant companion fails any merge activity entry that no approving review round for the exact merged commit backs, so the journal cannot record a merge the review trail cannot explain.

## Alternatives considered

**Extend Agent Teams with worktree isolation.** Rejected because Teams keeps the same-world contract deliberately — sandboxing and filesystem compare-and-set already describe that domain, and inferring branches, merge policy, and cleanup from team membership would silently change semantics existing deployments rely on. Tower owns the git lifecycle as an explicit opt-in instead of making Team membership imply it.

**One package owning mode, git, and tools.** Rejected because the three roles evolve independently: a remote or hosted provider should not drag the tool consumer along, and the consumer is useless without any provider. The capability-seam rule wants all three roles designed and separately owned.

**Keep mission state in the lead session log.** Rejected because a workspace outlives any one lead session: mission records must be adoptable by a later session in the same or another process, while the session log is single-session durable. File-backed records under `.tower/` carry the multi-session facts, and the log carries only the mode the projection folds.

**Deliver messages directly between mission children.** Rejected because adjacent-Agent messaging authorizes direct parent and direct child edges only, and routing through the live lead keeps one authority point, one delivery vocabulary, and a complete activity record of who told whom what.

**Merge without a recorded review round, or with fast-forward.** Rejected because the review gate is the product: a merge must be explainable from the record as "an approval covered exactly this commit", and `--no-ff` keeps each mission's provenance visible on the base after the worktree is gone.

**Hide lead-only tools from mission children at the service layer.** Rejected because visibility is a composition choice, not a service property; hard-coding a deny list would couple the tower service to tool names it does not own. The config field plus the exported `MISSION_TOOL_FILTER` keep the list explicit, and execution-time authority still fails loudly when the filter is absent.

## Testing

Package suites cover the projection fold and mode lifecycle, loader composition of the service, provider, and tools, mission provisioning and rollback, the review gate and merge refusals, message journaling and delivery, the invariant companion, and the `MISSION_TOOL_FILTER` composition. The tower profile bundle test pins the three patch rows and boots them through the real Loader, asserting the `/tower` command, the ten tools, and the verbatim policy section on the composed tree.

## Consequences

A lead buys physical isolation per mission, merges explainable from records alone, coordination state that survives child settlement and lead restarts, and an audit trail under `.tower/`. The costs: the composed profile pays for the policy section and the ten tool schemas on every request, the workspace requires a local git checkout, storage serialization is in-process so concurrent processes sharing a workspace race at the filesystem level, and a pending mode selection made after a turn's last accepted pre-step is lost on process exit.

Named coverage gaps: the generated tool, config, persistence, and Cordis catalogs and the website page list do not yet cover the tower surface; the type vocabulary is documented in [the tower subsystem page](../../../../docs/subsystems/tower.md) with manifest-checked type-equivalence blocks, and the catalogs follow when their generators next run.

## Related

[The Agent Teams note](2026-08-05-agent-teams.md) owns the shared-checkout coordination domain tower deliberately does not enter; [the subagent start-request note](2026-09-10-subagent-start-request-cwd.md) owns the per-child working directory the mission worktree binding rides on.
