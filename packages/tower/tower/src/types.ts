/**
 * The tower seam's consumer-facing contracts: workspace, mission, review,
 * finding, message, and activity vocabulary for {@link TowerProvider}, plus
 * the mode projection types clients read. A tower lets one lead session fan
 * missions out to isolated git worktrees, coordinate through findings and
 * lead-mediated messages, and merge each mission branch back into the
 * recorded base only after a review round approves its exact tip commit.
 *
 * @module @deepseek-ai/dsh-tower/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/** Identifies one tower mission within its workspace. */
export type TowerMissionId = Branded<'TowerMissionId'>

/**
 * Brand a string as a {@link TowerMissionId}.
 * @param id - the raw mission id.
 * @returns the same string, branded.
 */
export function TowerMissionId(id: string): TowerMissionId {
  return brandString<TowerMissionId>(id)
}

/** Identifies one persisted finding within its workspace. */
export type TowerFindingId = Branded<'TowerFindingId'>

/**
 * Brand a string as a {@link TowerFindingId}.
 * @param id - the raw finding id.
 * @returns the same string, branded.
 */
export function TowerFindingId(id: string): TowerFindingId {
  return brandString<TowerFindingId>(id)
}

/**
 * One mission's lifecycle. `spawning` becomes `active` at initial inbox
 * acceptance or `failed` when provisioning rolls back; a review `reject`
 * returns the mission to `active` for rework while `approve` marks it
 * `approved`; only `approved` can merge. `interrupted` marks a spawning or
 * active mission whose owner session is no longer live at workspace
 * adoption; its branch and worktree survive for review and merge.
 */
export type TowerMissionStatus =
  | 'spawning'
  | 'active'
  | 'interrupted'
  | 'approved'
  | 'merged'
  | 'failed'
  | 'aborted'

/** The durable mission record, one JSON document per mission. */
export interface TowerMission {
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

/** One review round on a mission branch, appended per verdict. */
export interface TowerReviewRound {
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

/** A shared finding any tower participant records for the others. */
export interface TowerFinding {
  readonly id: TowerFindingId
  readonly title: string
  readonly body: string
  /** Who recorded it: `lead` or a mission id. */
  readonly author: string
  /** ISO-8601 recording time. */
  readonly time: string
}

/** One lead-mediated message, retained in the workspace activity record. */
export interface TowerMessage {
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

/** One entry of the workspace's append-only activity record. */
export interface TowerActivityEntry {
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

/** The durable workspace record at `.tower/workspace.json`. */
export interface TowerWorkspace {
  /** Physical format version of the workspace record. */
  readonly version: 1
  /** The local branch missions fork from and merge back into. */
  readonly base: string
  /** Absolute path of the git worktree root that owns `.tower/`. */
  readonly root: string
  /** ISO-8601 creation time of the first initialization. */
  readonly createdAt: string
}

/** What {@link TowerProvider.init} returns. */
export interface TowerWorkspaceInfo {
  readonly workspace: TowerWorkspace
  /** True when an existing workspace was adopted instead of created. */
  readonly adopted: boolean
  /** Missions carried over by adoption, already reconciled for dead owners. */
  readonly missions: number
}

/** A mission row enriched for display: owner liveness and review-gate state. */
export interface TowerMissionView extends TowerMission {
  /** Whether the owner session is live in this process right now. */
  readonly ownerLive: boolean
  /** The latest review round, when any. */
  readonly latestReview?: TowerReviewRound
  /** Whether the latest review's commit still equals the branch tip. */
  readonly tipMatchesReview: boolean
}

/** The tower dashboard: missions, review-gate state, and recent activity. */
export interface TowerDashboard {
  /** The recorded base branch. */
  readonly base: string
  /** Every unmerged mission in creation order. */
  readonly missions: TowerMissionView[]
  /** Total recorded findings. */
  readonly findings: number
  /** Newest-last tail of the activity record. */
  readonly activity: TowerActivityEntry[]
}

/** What a successful merge reports. */
export interface TowerMergeResult {
  /** The merged mission, status `merged`. */
  readonly mission: TowerMissionView
  /** The merge commit created on the base branch. */
  readonly mergeCommit: string
}

/** What teardown reports: removed worktrees, kept ones, interrupted owners. */
export interface TowerTeardownResult {
  /** Missions whose worktrees were removed. */
  readonly removed: TowerMissionId[]
  /** Missions kept with the reason (dirty worktree without `force`). */
  readonly kept: readonly { readonly id: TowerMissionId; readonly reason: string }[]
  /** Live mission children interrupted before removal. */
  readonly interrupted: number
}

/**
 * One registered tower backend. The shipped provider is `local`: it keeps the
 * coordination store under the workspace's `.tower/` directory and drives git
 * through the subprocess seam. The service validates mode and caller
 * authority before delegating; providers own the store, git, and mission
 * child lifecycle.
 */
/** What {@link TowerProvider.spawnMission} accepts. */
export interface TowerSpawnRequest {
  /** Short model-authored mission title. */
  readonly title: string
  /** The complete task text the mission child receives. */
  readonly prompt: string
  /** Caller cancellation owning the operation until initial inbox acceptance. */
  readonly signal: AbortSignal
}

/** What {@link TowerProvider.sendMessage} accepts. */
export interface TowerMessageRequest {
  /** Address: `lead`, one mission id, or `all` for every live mission. */
  readonly to: string
  readonly content: string
  /** Pre-delivery cancellation. */
  readonly signal: AbortSignal
}

/** What {@link TowerProvider.recordFinding} accepts. */
export interface TowerFindingRequest {
  readonly title: string
  readonly body: string
}

/** What {@link TowerProvider.recordReview} accepts. */
export interface TowerReviewRequest {
  /** The mission under review. */
  readonly mission: TowerMissionId
  readonly verdict: 'approve' | 'reject'
  /** Model-authored review summary. */
  readonly summary: string
}

/** What {@link TowerProvider.teardown} accepts. */
export interface TowerTeardownRequest {
  /** Remove dirty worktrees instead of keeping and reporting them. */
  readonly force: boolean
  /** Caller cancellation. */
  readonly signal: AbortSignal
}

export interface TowerProvider {
  /** Unique registry name (e.g. `local`). */
  readonly name: string
  /**
   * Assert `base` names a local branch of the git work tree containing `cwd`.
   * Called by the `/tower on` command before the mode is logged, so a typo
   * fails at the earliest resolvable point.
   */
  validateBase(cwd: string, base: string): Promise<void>
  /**
   * Create the workspace under the lead session's git root, or adopt an
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
  spawnMission(
    caller: Agent,
    request: TowerSpawnRequest,
  ): Promise<TowerMissionView>
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
  sendMessage(
    caller: Agent,
    request: TowerMessageRequest,
  ): Promise<TowerMessage>
  /**
   * Read messages addressed to the caller (`all` included), newest last.
   * @param caller - exact live lead or mission Agent.
   * @param limit - maximum messages returned, newest first before re-ordering.
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
   * `approve` moves the mission to `approved`; `reject` returns it to
   * `active` for rework.
   * @param caller - exact live lead Agent.
   * @param request - mission, verdict, and review summary.
   * @returns the recorded round.
   */
  recordReview(
    caller: Agent,
    request: TowerReviewRequest,
  ): Promise<TowerReviewRound>
  /**
   * Merge one mission branch back into the base. The merge gate refuses
   * loudly unless the mission is `approved`, the latest review round's
   * commit still equals the branch tip, and the main checkout sits on the
   * recorded base. On success the worktree is removed and the mission is
   * `merged`.
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

/** Unit state of the `tower` session projection: logged tower mode. */
export interface TowerUnitState {
  /** The committed mode. */
  readonly active: boolean
  /** The base recorded with the latest activation. */
  readonly base: string | null
  /** The selected state awaiting the next accepted in-turn pre-step. */
  readonly wanted: boolean | null
  /** The running `/tower` command correlation, like the plan unit's. */
  readonly running: { readonly wanted: boolean } | null
  /** The committed mode at the last request header. */
  readonly activeAtLastHeader: boolean | null
}

/** Cropped wire view of the `tower` projection for client carriers. */
export interface TowerProjection {
  readonly active: boolean
  readonly pending: boolean
  /** The logged base branch when active. */
  readonly base?: string
}

/** The logged tower mode of one session, as read by consumers. */
export interface TowerModeState {
  /** The committed mode. */
  readonly active: boolean
  /** The base recorded with the latest activation; null while inactive. */
  readonly base: string | null
}

/**
 * The tower capability published as `ctx.tower`. The service owns the logged
 * mode, provider registry, and caller-authority validation; every operation
 * delegates to the provider selected by Config once authority passes. The
 * contract lives on the `./types` face so provider packages compile against
 * contracts alone.
 *
 * Authority: `init`, `spawnMission`, `abortMission`, `recordReview`, `merge`,
 * and `teardown` are lead-only — the caller's session must carry active tower
 * mode. `status`, `sendMessage`, `inbox`, `recordFinding`, and
 * `listFindings` additionally admit recorded mission owners.
 */
export interface TowerService {
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
  /**
   * Create or adopt the caller's workspace (lead-only).
   * @param caller - exact live lead Agent.
   * @returns the workspace and adoption facts.
   */
  init(caller: Agent): Promise<TowerWorkspaceInfo>
  /**
   * Read the tower dashboard (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @returns the current dashboard.
   */
  status(caller: Agent): Promise<TowerDashboard>
  /**
   * Spawn one mission in an isolated worktree (lead-only); refuses loudly
   * beyond the configured mission bound.
   * @param caller - exact live lead Agent.
   * @param request - title, complete task prompt, and caller cancellation.
   * @returns the active mission row.
   */
  spawnMission(caller: Agent, request: TowerSpawnRequest): Promise<TowerMissionView>
  /**
   * Interrupt a mission's live child and mark it `aborted` (lead-only).
   * @param caller - exact live lead Agent.
   * @param id - the mission to abort.
   * @returns the updated mission row.
   */
  abortMission(caller: Agent, id: TowerMissionId): Promise<TowerMissionView>
  /**
   * Record and deliver one lead-mediated message (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @param request - address, content, and pre-delivery cancellation.
   * @returns the recorded message.
   */
  sendMessage(caller: Agent, request: TowerMessageRequest): Promise<TowerMessage>
  /**
   * Read the caller's inbox slice (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @param limit - maximum messages returned.
   * @returns messages addressed to the caller, newest last.
   */
  inbox(caller: Agent, limit?: number): Promise<TowerMessage[]>
  /**
   * Persist one shared finding (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @param request - finding title and body.
   * @returns the recorded finding.
   */
  recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding>
  /**
   * List every recorded finding (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @returns all findings in creation order.
   */
  listFindings(caller: Agent): Promise<TowerFinding[]>
  /**
   * Append one review round, stamping the mission's current branch tip
   * (lead-only).
   * @param caller - exact live lead Agent.
   * @param request - mission, verdict, and review summary.
   * @returns the recorded round.
   */
  recordReview(caller: Agent, request: TowerReviewRequest): Promise<TowerReviewRound>
  /**
   * Merge one approved mission branch into the base through the review gate
   * (lead-only).
   * @param caller - exact live lead Agent.
   * @param id - the mission to merge.
   * @returns the merged mission and its merge commit.
   */
  merge(caller: Agent, id: TowerMissionId): Promise<TowerMergeResult>
  /**
   * End the workspace's active work, keeping `.tower/` as the audit trail
   * (lead-only).
   * @param caller - exact live lead Agent.
   * @param request - whether to remove dirty worktrees, and cancellation.
   * @returns removal and interruption facts.
   */
  teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult>
  /**
   * Whether `session` owns an unmerged mission.
   * @param session - the candidate session.
   * @returns true when the session is a recorded mission owner.
   */
  isMissionOwner(session: Session): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The tower capability, present when a tower service plugin is loaded. */
    tower: TowerService
  }
}
