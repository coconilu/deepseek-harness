# Tower

English | [中文](tower.zh.md)

Tower mode is logged collaboration state in which one lead session fans work out as **missions**: each mission runs in an isolated git worktree branched from a recorded base, talks to the lead through mediated messages and shared findings, and merges back only through a review gate. It is an optional capability seam composed from three packages: the Service Definition [dsh-tower](../../packages/tower/tower) owns `ctx.tower` and the logged mode, the Service Provider [dsh-tower-local](../../packages/tower/tower-local) owns the `.tower/` store, git, and mission children, and the Consumer [dsh-tool-tower](../../packages/tower/tool-tower) owns the ten model-facing `tower_*` tools. The [design note](../../.agents/notes/implemented/feature/2026-09-11-tower-capability.md) owns the rationale; the package READMEs own model-experience and configuration detail. It differs from [Agent Teams](agent-team.md), which coordinates children in one shared checkout without git semantics.

Sources: [`packages/tower/tower/src/types.ts`](../../packages/tower/tower/src/types.ts), [`packages/tower/tower/src/index.ts`](../../packages/tower/tower/src/index.ts), and [`packages/tower/tower-local/src/provider.ts`](../../packages/tower/tower-local/src/provider.ts)

## Logged mode and the `/tower` command

`tower/mode` (`{ active: boolean; base?: string }`) is a log-only, whole-value-replace [session event](session.md): durable and replayable, never in the model transcript, with the last value winning. The registered `tower` [projection](session-projection.md) unit folds the event together with `/tower` command runs, so resume, fork, and compaction recover the mode from the log alone, and client carriers read the cropped `{ active, pending, base? }` wire view. `/tower on <base>` validates the base through the selected provider before any event lands, so a typo logs nothing; `/tower off`, `/tower status`, and idempotent re-selections are command-level no-ops. Because every session event is turn-enclosed, a selection made during an open turn stays pending until the next accepted in-turn pre-step appends it — the only append point while an agent runs — and a failed append cannot block the step, remaining pending for a later attempt. A failed append and an in-flight pending selection are the two states the `wanted`/`running` fold fields track. While the mode is active — or a pending activation is selected — the service renders the deployment's `section` text as the `tower:policy` [prompt section](system-prompt.md); the command child activates only when [ctx.commands](commands.md) is composed.

## The workspace and missions

A tower workspace is one git work tree with a `.tower/` coordination store and a recorded base branch. Missions are the unit of delegated work; the provider allocates their ids as `m-<n>` per workspace and names their branches `tower/<id>`.

```ts type-equiv
/** The durable workspace record at `.tower/workspace.json`. */
interface TowerWorkspace {
  /** Physical format version of the workspace record. */
  readonly version: 1
  /** The local branch missions fork from and merge back into. */
  readonly base: string
  /** Absolute path of the git worktree root that owns `.tower/`. */
  readonly root: string
  /** ISO-8601 creation time of the first initialization. */
  readonly createdAt: string
}
```

```ts type-equiv
/**
 * One mission's lifecycle. `spawning` becomes `active` at initial inbox
 * acceptance or `failed` when provisioning rolls back; a review `reject`
 * returns the mission to `active` for rework while `approve` marks it
 * `approved`; only `approved` can merge. `interrupted` marks a spawning or
 * active mission whose owner session is no longer live at workspace
 * adoption; its branch and worktree survive for review and merge.
 */
type TowerMissionStatus =
  | 'spawning'
  | 'active'
  | 'interrupted'
  | 'approved'
  | 'merged'
  | 'failed'
  | 'aborted'
```

```ts type-equiv
/** The durable mission record, one JSON document per mission. */
interface TowerMission {
  /** Stable mission identity, allocated monotonically as `m-<n>` per workspace. */
  readonly id: TowerMissionId
  /** Short model-authored mission title. */
  readonly title: string
  /** The complete task text the mission child receives. */
  readonly prompt: string
  /** The base branch the mission forked and merges back into. */
  readonly base: string
  /** The mission branch, `tower/<id>`. */
  readonly branch: string
  /** Absolute path of the mission's git worktree. */
  readonly worktree: string
  readonly status: TowerMissionStatus
  /** The mission child's durable session id; absent until the initial prompt is accepted. */
  readonly owner?: SessionId
  /** ISO-8601 creation and last-mutation timestamps. */
  readonly createdAt: string
  readonly updatedAt: string
}
```

Mission records live outside any session log: they span sessions and processes, and workspace adoption — an `init` against an existing store whose recorded base matches — carries unmerged missions over and reconciles `spawning`/`active` missions whose owner is no longer live to `interrupted`. Dashboard rows enrich the record at read time with owner liveness and review-gate state (`TowerMissionView`), and `status`/`init`/`spawnMission` return those enriched views rather than raw records.

## Reviews, findings, and messages

```ts type-equiv
/** One review round on a mission branch, appended per verdict. */
interface TowerReviewRound {
  /** One-based round number, monotonic per mission. */
  readonly round: number
  readonly verdict: 'approve' | 'reject'
  /** The mission branch tip the reviewer examined. */
  readonly commit: string
  /** Model-authored review summary. */
  readonly summary: string
  /** Who reviewed: `lead` or a mission id. */
  readonly reviewer: string
  /** ISO-8601 recording time. */
  readonly time: string
}
```

```ts type-equiv
/** A shared finding any tower participant records for the others. */
interface TowerFinding {
  readonly id: TowerFindingId
  readonly title: string
  readonly body: string
  /** Who recorded it: `lead` or a mission id. */
  readonly author: string
  /** ISO-8601 recording time. */
  readonly time: string
}
```

```ts type-equiv
/** One lead-mediated message, retained in the workspace activity record. */
interface TowerMessage {
  /** Globally random message identity. */
  readonly id: string
  /** Sender: `lead` or a mission id. */
  readonly from: string
  /** Address: `lead`, one mission id, or `all` for every live mission. */
  readonly to: string
  readonly content: string
  /** ISO-8601 recording time. */
  readonly time: string
}
```

```ts type-equiv
/** One entry of the workspace's append-only activity record. */
interface TowerActivityEntry {
  /** ISO-8601 recording time. */
  readonly time: string
  readonly kind:
    | 'init'
    | 'adopt'
    | 'spawn'
    | 'review'
    | 'merge'
    | 'abort'
    | 'message'
    | 'finding'
    | 'teardown'
  /** Who acted: `lead` or a mission id. */
  readonly actor: string
  /** The mission concerned, when any. */
  readonly mission?: TowerMissionId
  /** Short single-line detail. */
  readonly detail: string
}
```

Every operation appends one activity entry, and the local provider emits each entry synchronously at commit time through the `tower-local/activity` [Cordis event](../cordis-primer.md#dispatch-modes) so observers see journal order. `recordReview` stamps the mission's current branch tip into the round; `approve` moves the mission to `approved` and `reject` returns it to `active` for rework.

## The review gate and merge

A merge is refused loudly unless every condition holds: the mission is `approved`, the latest review round is an approval whose recorded commit still equals the branch tip, the mission worktree is clean, and the main checkout sits on the recorded base. The gate then merges with `--no-ff`, records the merge commit, removes the mission worktree, and marks the mission `merged`; a retry after a late failure is safe because git reports the up-to-date state and the gate re-passes. The tip-match condition is what makes the review verdict apply to an exact commit: any post-review change re-opens the mission for review. The merge-side contract is additionally watched by the provider's invariant companion, which fails a merge activity entry that has no approving review round for its exact commit.

## The shared operations

`TowerOperations` is not exported from `@deepseek-ai/dsh-tower/types`; both role interfaces below extend it, so its twelve operation contracts surface on `ctx.tower` and on every provider implementation.

```ts type-equiv
/**
 * The tower operations the seam's two roles share: the Service Definition
 * (`TowerService`) validates the caller's authority and routes each operation
 * to the provider (`TowerProvider`), which implements it. Each method's
 * contract and caller authority are declared here once; the role interfaces
 * add only their own lifecycle members.
 */
interface TowerOperations {
  /**
   * Create the workspace under the caller session's git root, or adopt an
   * existing one: the recorded base must match the session's logged tower
   * base, missions carry over, and owners no longer live are reconciled to
   * `interrupted`.
   * @param caller - exact live lead Agent whose session owns the workspace.
   * @returns the workspace and adoption facts.
   */
  init(caller: Agent): Promise<TowerWorkspaceInfo>
  /**
   * Read the dashboard: unmerged missions with owner liveness and review-gate
   * state, the findings count, and the activity tail.
   * @param caller - exact live lead or mission Agent.
   * @returns the current dashboard.
   */
  status(caller: Agent): Promise<TowerDashboard>
  /**
   * Create one mission: allocate its id, fork the base into a new worktree,
   * start the mission child there, and record the provisioning outcome.
   * @param caller - exact live lead Agent.
   * @param request - title, complete task prompt, and caller cancellation
   * owning the operation until initial inbox acceptance.
   * @returns the active mission row.
   */
  spawnMission(caller: Agent, request: TowerSpawnRequest): Promise<TowerMissionView>
  /**
   * Interrupt the mission's live child (preserving its inbox) and mark the
   * mission `aborted`; its branch and worktree stay for inspection.
   * @param caller - exact live lead Agent.
   * @param id - the mission to abort.
   * @returns the updated mission row.
   */
  abortMission(caller: Agent, id: TowerMissionId): Promise<TowerMissionView>
  /**
   * Record one message and deliver it: `lead` receives it as a parent-inbox
   * notice, one mission id through adjacent-Agent messaging, and `all` fans
   * out to every live mission child.
   * @param caller - exact live lead or mission Agent.
   * @param request - address, content, and pre-delivery cancellation.
   * @returns the recorded message.
   */
  sendMessage(caller: Agent, request: TowerMessageRequest): Promise<TowerMessage>
  /**
   * Read messages addressed to the caller (`all` included), newest last.
   * @param caller - exact live lead or mission Agent.
   * @param limit - maximum messages returned, taken from the newest.
   * @returns the caller's inbox slice.
   */
  inbox(caller: Agent, limit?: number): Promise<TowerMessage[]>
  /**
   * Persist one finding visible to every tower participant.
   * @param caller - exact live lead or mission Agent.
   * @param request - finding title and body.
   * @returns the recorded finding.
   */
  recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding>
  /**
   * List every recorded finding in creation order.
   * @param caller - exact live lead or mission Agent.
   * @returns all findings.
   */
  listFindings(caller: Agent): Promise<TowerFinding[]>
  /**
   * Append one review round for a mission, stamping the current branch tip.
   * `approve` marks the mission `approved`; `reject` returns it to `active`
   * for rework.
   * @param caller - exact live lead Agent.
   * @param request - mission, verdict, and review summary.
   * @returns the recorded round.
   */
  recordReview(caller: Agent, request: TowerReviewRequest): Promise<TowerReviewRound>
  /**
   * Merge one mission branch back into the base. The merge gate refuses
   * loudly unless the mission is `approved`, the latest review round's commit
   * still equals the branch tip, and the main checkout sits on the recorded
   * base. On success the worktree is removed and the mission is `merged`.
   * @param caller - exact live lead Agent.
   * @param id - the mission to merge.
   * @returns the merged mission and its merge commit.
   */
  merge(caller: Agent, id: TowerMissionId): Promise<TowerMergeResult>
  /**
   * End the workspace's active work: interrupt live mission children, remove
   * mission worktrees (dirty ones are kept and reported unless `force`), and
   * leave the `.tower/` coordination record in place as the audit trail.
   * Tower mode in the session stays on.
   * @param caller - exact live lead Agent.
   * @param request - whether to remove dirty worktrees, and caller cancellation.
   * @returns removal and interruption facts.
   */
  teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult>
  /**
   * Whether `session` is the recorded owner of an unmerged mission — the
   * durable authority behind mission-side comms tools, valid across cold
   * resume because it reads the mission record.
   * @param session - the candidate session.
   * @returns true when the session owns an unmerged mission.
   */
  isMissionOwner(session: Session): Promise<boolean>
}
```

## The service contract

`ctx.tower` owns the logged mode, the provider registry, and caller-authority validation; every operation delegates to the provider named in config once authority passes. `init`, `spawnMission`, `abortMission`, `recordReview`, `merge`, and `teardown` are lead-only — the caller's session must carry active tower mode. `status`, `sendMessage`, `inbox`, `recordFinding`, and `listFindings` additionally admit recorded mission owners, a durable check that reads the mission records and survives cold resume. `spawnMission` refuses beyond the configured mission bound, and `/tower` selection states ride the same pending-flush machinery described above.

```ts type-equiv
/**
 * The tower capability published as `ctx.tower`. The service owns the logged
 * mode, provider registry, and caller-authority validation; every inherited
 * operation delegates to the provider selected by Config once authority
 * passes. The contract lives on the `./types` face so provider packages
 * compile against contracts alone.
 *
 * Authority: `init`, `spawnMission`, `abortMission`, `recordReview`, `merge`,
 * and `teardown` are lead-only — the caller's session must carry active tower
 * mode. `status`, `sendMessage`, `inbox`, `recordFinding`, and
 * `listFindings` additionally admit recorded mission owners.
 */
interface TowerService extends TowerOperations {
  /**
   * Register one backend under its {@link TowerProvider.name}. The
   * registration is an owned effect: disposing the caller's fiber removes it.
   * @param provider - the backend to publish.
   */
  registerProvider(provider: TowerProvider): void
  /**
   * Read the logged tower mode of `agent`'s session.
   * @param agent - the session-owning Agent.
   * @returns the committed mode and base.
   */
  mode(agent: Agent): TowerModeState
}
```

## The provider contract

Providers own the workspace store, git, and mission child lifecycle; the service validates mode and caller authority before delegating. `validateBase` runs at command time so a base typo fails before anything is logged, and `isMissionOwner` is the durable authority behind mission-side operations.

```ts type-equiv
/**
 * The provider role of the tower capability seam: owns the `.tower/`
 * coordination store, git worktrees, and mission children, registered under
 * {@link TowerProvider.name}. The Service Definition routes every facade
 * operation to the configured provider; lead-only authority is re-validated
 * above it, so providers may assume the caller is authorized. The shipped
 * provider is `local`: it keeps the coordination store under the workspace's
 * `.tower/` directory and drives git through the subprocess seam.
 */
interface TowerProvider extends TowerOperations {
  /** Unique registry name (e.g. `local`). */
  readonly name: string
  /**
   * Assert `base` names a local branch of the git work tree containing `cwd`.
   * Called by the `/tower on` command before the mode is logged, so a typo
   * fails at the earliest resolvable point.
   */
  validateBase(cwd: string, base: string): Promise<void>
}
```

The operation-local request types (`TowerSpawnRequest`, `TowerMessageRequest`, `TowerFindingRequest`, `TowerReviewRequest`, `TowerTeardownRequest`) carry each call's inputs plus the caller cancellation or bound, and the result types (`TowerWorkspaceInfo`, `TowerDashboard`, `TowerMissionView`, `TowerMergeResult`, `TowerTeardownResult`) are pure read models over the durable records.

## The shipped provider

[dsh-tower-local](../../packages/tower/tower-local/README.md) registers the `local` backend: one `.tower/` store per workspace git root (`workspace.json`, per-mission `missions/m-<n>.json`, and append-only `messages.jsonl`/`findings.jsonl`/`activity.jsonl`/`reviews/m-<n>.jsonl` journals, all zod-validated on read), git worktrees driven through the [subprocess seam](subprocess.md), and mission children run as [continuable subagents](subagent.md) with `cwd` bound to the mission worktree — the per-child working directory the start request carries. A single FIFO promise queue serializes storage transactions while subagent seam calls stay outside it, message delivery goes through the lead (a parent-inbox notice for `lead`, [adjacent-Agent messaging](subagent.md) for missions), and the model-facing authority of a mission child is its recorded mission ownership. The ten model-facing tools live in [dsh-tool-tower](../../packages/tower/tool-tower/README.md); `tower_merge` and `tower_teardown` ask the [approval seam](approval.md) before delegating. Configuration tables and model-experience contracts live in the package READMEs.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtower--towerservice"></a>

### `ctx.tower` — `TowerService`

The tower capability published as `ctx.tower`. The service owns the logged mode, provider registry, and caller-authority validation; every inherited operation delegates to the provider selected by Config once authority passes. The contract lives on the `./types` face so provider packages compile against contracts alone.

Authority: `init`, `spawnMission`, `abortMission`, `recordReview`, `merge`, and `teardown` are lead-only — the caller's session must carry active tower mode. `status`, `sendMessage`, `inbox`, `recordFinding`, and `listFindings` additionally admit recorded mission owners.

```ts cordis-catalog
/**
 * Create the workspace under the caller session's git root, or adopt an
 * existing one: the recorded base must match the session's logged tower
 * base, missions carry over, and owners no longer live are reconciled to
 * `interrupted`.
 * @param caller - exact live lead Agent whose session owns the workspace.
 * @returns the workspace and adoption facts.
 */
init(caller: Agent): Promise<TowerWorkspaceInfo>

/**
 * Read the dashboard: unmerged missions with owner liveness and review-gate
 * state, the findings count, and the activity tail.
 * @param caller - exact live lead or mission Agent.
 * @returns the current dashboard.
 */
status(caller: Agent): Promise<TowerDashboard>

/**
 * Create one mission: allocate its id, fork the base into a new worktree,
 * start the mission child there, and record the provisioning outcome.
 * @param caller - exact live lead Agent.
 * @param request - title, complete task prompt, and caller cancellation
 * owning the operation until initial inbox acceptance.
 * @returns the active mission row.
 */
spawnMission(caller: Agent, request: TowerSpawnRequest): Promise<TowerMissionView>

/**
 * Interrupt the mission's live child (preserving its inbox) and mark the
 * mission `aborted`; its branch and worktree stay for inspection.
 * @param caller - exact live lead Agent.
 * @param id - the mission to abort.
 * @returns the updated mission row.
 */
abortMission(caller: Agent, id: TowerMissionId): Promise<TowerMissionView>

/**
 * Record one message and deliver it: `lead` receives it as a parent-inbox
 * notice, one mission id through adjacent-Agent messaging, and `all` fans
 * out to every live mission child.
 * @param caller - exact live lead or mission Agent.
 * @param request - address, content, and pre-delivery cancellation.
 * @returns the recorded message.
 */
sendMessage(caller: Agent, request: TowerMessageRequest): Promise<TowerMessage>

/**
 * Read messages addressed to the caller (`all` included), newest last.
 * @param caller - exact live lead or mission Agent.
 * @param limit - maximum messages returned, taken from the newest.
 * @returns the caller's inbox slice.
 */
inbox(caller: Agent, limit?: number): Promise<TowerMessage[]>

/**
 * Persist one finding visible to every tower participant.
 * @param caller - exact live lead or mission Agent.
 * @param request - finding title and body.
 * @returns the recorded finding.
 */
recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding>

/**
 * List every recorded finding in creation order.
 * @param caller - exact live lead or mission Agent.
 * @returns all findings.
 */
listFindings(caller: Agent): Promise<TowerFinding[]>

/**
 * Append one review round for a mission, stamping the current branch tip.
 * `approve` marks the mission `approved`; `reject` returns it to `active`
 * for rework.
 * @param caller - exact live lead Agent.
 * @param request - mission, verdict, and review summary.
 * @returns the recorded round.
 */
recordReview(caller: Agent, request: TowerReviewRequest): Promise<TowerReviewRound>

/**
 * Merge one mission branch back into the base. The merge gate refuses
 * loudly unless the mission is `approved`, the latest review round's commit
 * still equals the branch tip, and the main checkout sits on the recorded
 * base. On success the worktree is removed and the mission is `merged`.
 * @param caller - exact live lead Agent.
 * @param id - the mission to merge.
 * @returns the merged mission and its merge commit.
 */
merge(caller: Agent, id: TowerMissionId): Promise<TowerMergeResult>

/**
 * End the workspace's active work: interrupt live mission children, remove
 * mission worktrees (dirty ones are kept and reported unless `force`), and
 * leave the `.tower/` coordination record in place as the audit trail.
 * Tower mode in the session stays on.
 * @param caller - exact live lead Agent.
 * @param request - whether to remove dirty worktrees, and caller cancellation.
 * @returns removal and interruption facts.
 */
teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult>

/**
 * Whether `session` is the recorded owner of an unmerged mission — the
 * durable authority behind mission-side comms tools, valid across cold
 * resume because it reads the mission record.
 * @param session - the candidate session.
 * @returns true when the session owns an unmerged mission.
 */
isMissionOwner(session: Session): Promise<boolean>

/**
 * Register one backend under its {@link TowerProvider.name}. The
 * registration is an owned effect: disposing the caller's fiber removes it.
 * @param provider - the backend to publish.
 */
registerProvider(provider: TowerProvider): void

/**
 * Read the logged tower mode of `agent`'s session.
 * @param agent - the session-owning Agent.
 * @returns the committed mode and base.
 */
mode(agent: Agent): TowerModeState
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/tower/tower/src/types.ts`](../../packages/tower/tower/src/types.ts)

<a id="tower-local-events"></a>

### `tower-local/*` events

<a id="tower-localactivity--emit"></a>

#### `tower-local/activity` — emit

One tower-local activity entry committed to the workspace journal. The dispatch is synchronous and runs before the recording operation returns, so a synchronous listener's throw reaches that operation; listeners must be synchronous, must tolerate stores they do not own, and must not call back into the emitting provider (its storage transaction is still open).

```ts cordis-catalog
/**
 * One tower-local activity entry committed to the workspace journal. The
 * dispatch is synchronous and runs before the recording operation
 * returns, so a synchronous listener's throw reaches that operation;
 * listeners must be synchronous, must tolerate stores they do not own,
 * and must not call back into the emitting provider (its storage
 * transaction is still open).
 * @param notice - the store root, the committed entry, and the merged branch tip when any.
 * @mode emit
 */
'tower-local/activity'(notice: TowerLocalActivityNotice): void
```

Source: [`packages/tower/tower-local/src/events.ts`](../../packages/tower/tower-local/src/events.ts)
<!-- END GENERATED cordis-surface -->
