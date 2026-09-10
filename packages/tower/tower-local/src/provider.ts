/**
 * The local tower backend: one `.tower/` coordination store per workspace
 * git root, mission branches as git worktrees driven through the subprocess
 * seam, and mission children run as continuable subagents of the lead.
 *
 * Concurrency: a single FIFO promise queue serializes storage transactions
 * (id allocation, record writes, journal appends). Subagent seam calls —
 * child creation, message delivery, interrupts, drains — never run inside
 * the queue, because child lifecycle callbacks can re-enter the tower
 * service while it operates. `isMissionOwner` stays out of the queue by
 * contract: it is a pure read of atomically replaced records and line-appended
 * journals, and it must answer while a spawn transaction is in flight.
 *
 * @module @deepseek-ai/dsh-tower-local/provider
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {
  TowerActivityEntry,
  TowerDashboard,
  TowerFinding,
  TowerFindingRequest,
  TowerMergeResult,
  TowerMessage,
  TowerMessageRequest,
  TowerMission,
  TowerMissionId,
  TowerMissionStatus,
  TowerMissionView,
  TowerProvider,
  TowerReviewRequest,
  TowerReviewRound,
  TowerSpawnRequest,
  TowerTeardownRequest,
  TowerTeardownResult,
  TowerWorkspace,
  TowerWorkspaceInfo,
} from '@deepseek-ai/dsh-tower/types'
import { TowerLocalError } from './error.ts'
import { TOWER_ACTIVITY_EVENT } from './events.ts'
import type { TowerLocalActivityNotice } from './events.ts'
import { GitEngine } from './git.ts'
import { TowerStore } from './store.ts'

/** Content blocks delivered through the subagent messaging seam. */
type DeliveryContent = Parameters<Context['subagents']['sendMessage']>[2]

/** Config the provider consumes after plugin-load validation materialized defaults. */
export interface LocalTowerConfig {
  /** `ctx.subagents` provider name composing mission children. */
  readonly childProvider: string
  /**
   * Tool names denied from every mission child's tool set; empty denies
   * nothing. An unknown or reserved name fails the child's start loudly.
   */
  readonly childToolFilter: readonly string[]
  /** Maximum activity entries one `status` dashboard returns. */
  readonly activityTail: number
}

/** One recorded message plus the addressing facts settled inside its storage transaction. */
interface RecordedMessage {
  /** The journaled message. */
  readonly message: TowerMessage
  /** Missions snapshot taken at record time. */
  readonly missions: readonly TowerMission[]
  /** The addressed mission; present exactly for single-mission addresses. */
  readonly target?: TowerMission
}

/** ISO-8601 timestamp for one durable record. */
function timestamp(): string {
  return new Date().toISOString()
}

/** Render a thrown value for one record detail line. */
function errorText(error: unknown): string {
  /* v8 ignore next 1 -- every seam the provider awaits rejects with Error instances */
  return error instanceof Error ? error.message : String(error)
}

/**
 * `.tower/`-plus-worktrees tower backend registered as `local`. Instances are
 * thin coordinators: durable state lives in the store, live state in the
 * agents registry, and every git fact is re-read at decision time.
 */
export class LocalTowerProvider implements TowerProvider {
  readonly name = 'local'
  private readonly git: GitEngine
  /** Tail of the storage FIFO; always settles, never rejects. */
  private queue: Promise<void> = Promise.resolve()

  /**
   * Bind the provider to its plugin context and validated config.
   * @param ctx - plugin context carrying the injected services.
   * @param config - validated provider config.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: LocalTowerConfig,
  ) {
    this.git = new GitEngine(ctx.subprocess)
  }

  /**
   * Assert `base` names a local branch of the repository containing `cwd`.
   * Remote-tracking refs and tags live in other namespaces and read false.
   * @param cwd - any directory inside the work tree.
   * @param base - the candidate base branch.
   */
  async validateBase(cwd: string, base: string): Promise<void> {
    const toplevel = await this.git.showToplevel(cwd)
    if (!await this.git.verifyLocalBranch(toplevel, base)) {
      throw new TowerLocalError(`"${base}" is not a local branch of the repository at "${toplevel}"`)
    }
  }

  /**
   * Create the workspace at the caller's git toplevel, or adopt the existing
   * one when the recorded base matches: unmerged missions carry over, and
   * `spawning`/`active` missions whose owner is no longer live reconcile to
   * `interrupted`.
   * @param caller - exact live lead Agent with tower mode active.
   * @returns the workspace and adoption facts.
   */
  async init(caller: Agent): Promise<TowerWorkspaceInfo> {
    const mode = this.ctx.tower.mode(caller)
    if (!mode.active || mode.base === null) {
      throw new TowerLocalError('tower mode is not active for the caller\'s session; select a base with /tower on <base> first')
    }
    const cwd = caller.session.header.cwd
    if (cwd === undefined) {
      throw new TowerLocalError(`session "${caller.id}" has no working directory; tower requires a cwd`, 'NO_WORKSPACE')
    }
    const base = mode.base
    return this.enqueue(async () => {
      const toplevel = await this.git.showToplevel(cwd)
      const store = new TowerStore(toplevel)
      await this.ensureExcluded(toplevel)
      const existing = await store.readWorkspace()
      if (existing === undefined) {
        const workspace: TowerWorkspace = { version: 1, base, root: toplevel, createdAt: timestamp() }
        await store.ensureLayout()
        await store.writeWorkspace(workspace)
        await this.recordActivity(store, {
          time: workspace.createdAt, kind: 'init', actor: 'lead',
          detail: `workspace initialized on base "${base}"`,
        })
        return { workspace, adopted: false, missions: 0 }
      }
      if (existing.base !== base) {
        throw new TowerLocalError(`the workspace base "${existing.base}" does not match the session's tower base "${base}"`)
      }
      const missions = await store.listMissions()
      let carried = 0
      for (const mission of missions) {
        if (mission.status === 'merged') continue
        carried += 1
        if ((mission.status === 'spawning' || mission.status === 'active') && !this.isLive(mission.owner)) {
          await store.writeMission({ ...mission, status: 'interrupted', updatedAt: timestamp() })
        }
      }
      await this.recordActivity(store, {
        time: timestamp(), kind: 'adopt', actor: 'lead',
        detail: `workspace adopted; ${carried} unmerged mission(s) carried over`,
      })
      return { workspace: existing, adopted: true, missions: carried }
    })
  }

  /**
   * Read the dashboard: unmerged missions with liveness and review-gate
   * state, the findings count, and the configured activity tail.
   * @param caller - exact live lead or mission Agent.
   * @returns the current dashboard.
   */
  async status(caller: Agent): Promise<TowerDashboard> {
    const { store, workspace } = await this.requireStore(caller)
    return this.enqueue(async () => {
      const missions = await store.listMissions()
      const views: TowerMissionView[] = []
      for (const mission of missions) {
        if (mission.status === 'merged') continue
        views.push(await this.viewOf(store, mission))
      }
      const findings = await store.readFindings()
      const activity = await store.readActivity()
      return {
        base: workspace.base,
        missions: views,
        findings: findings.length,
        activity: activity.slice(-this.config.activityTail),
      }
    })
  }

  /**
   * Create one mission: allocate its id and record `spawning` inside the
   * queue, fork the base into a worktree and start the mission child outside
   * it, then record `active` with the child id. A worktree failure records
   * `failed`; a child-start failure additionally rolls the worktree and
   * branch back.
   * @param caller - exact live lead Agent.
   * @param request - title, complete prompt, and caller cancellation.
   * @returns the active mission row.
   */
  async spawnMission(caller: Agent, request: TowerSpawnRequest): Promise<TowerMissionView> {
    request.signal.throwIfAborted()
    const { store, workspace } = await this.requireStore(caller, request.signal)
    const mission = await this.enqueue(async () => {
      const id = await store.nextMissionId()
      const time = timestamp()
      const allocated: TowerMission = {
        id,
        title: request.title,
        prompt: request.prompt,
        base: workspace.base,
        branch: `tower/${id}`,
        worktree: join(store.worktreesDir, id),
        status: 'spawning',
        createdAt: time,
        updatedAt: time,
      }
      await store.writeMission(allocated)
      return allocated
    })
    try {
      await this.git.addWorktree(store.root, mission.worktree, mission.branch, workspace.base)
    } catch (error: unknown) {
      await this.enqueue(async () => {
        await this.failSpawn(store, mission, `worktree provisioning failed: ${errorText(error)}`)
      })
      throw error
    }
    let owner: SessionId
    try {
      const started = await this.ctx.subagents.startContinuable({
        provider: this.config.childProvider,
        label: request.title,
        request: {
          prompt: [{ type: 'text', text: request.prompt }],
          parent: caller,
          cwd: mission.worktree,
          ...this.config.childToolFilter.length > 0 ? { toolFilter: { deny: this.config.childToolFilter } } : {},
        },
        signal: request.signal,
      })
      owner = started.childId
    } catch (error: unknown) {
      await this.rollbackSpawn(store, mission, error)
      throw error
    }
    return this.enqueue(async () => {
      const active: TowerMission = { ...mission, status: 'active', owner, updatedAt: timestamp() }
      await store.writeMission(active)
      await this.recordActivity(store, {
        time: active.updatedAt, kind: 'spawn', actor: 'lead', mission: mission.id,
        detail: `mission "${request.title}" spawned on branch ${mission.branch}`,
      })
      return this.viewOf(store, active)
    })
  }

  /**
   * Mark one mission `aborted` and interrupt its live child, preserving the
   * child's inbox; the branch and worktree stay for inspection.
   * @param caller - exact live lead Agent.
   * @param id - the mission to abort; must be `active` or `interrupted`.
   * @returns the updated mission row.
   */
  async abortMission(caller: Agent, id: TowerMissionId): Promise<TowerMissionView> {
    const { store } = await this.requireStore(caller)
    const aborted = await this.enqueue(async () => {
      const mission = await this.requireMission(store, id)
      if (mission.status !== 'active' && mission.status !== 'interrupted') {
        throw new TowerLocalError(`mission "${id}" is ${mission.status}; only an active or interrupted mission can be aborted`)
      }
      const next: TowerMission = { ...mission, status: 'aborted', updatedAt: timestamp() }
      await store.writeMission(next)
      await this.recordActivity(store, {
        time: next.updatedAt, kind: 'abort', actor: 'lead', mission: id,
        detail: `mission "${mission.title}" aborted`,
      })
      return next
    })
    // An absent target is an accepted no-op for the seam, so liveness is not
    // pre-checked; a live child receives the cancel before this returns.
    if (aborted.owner !== undefined) {
      this.ctx.subagents.interrupt(aborted.owner, { kind: 'ancestor', agent: caller })
    }
    return this.viewOf(store, aborted)
  }

  /**
   * Record one message in the journal, then deliver it: `lead` through the
   * caller's parent inbox, one mission through the live lead as mediator,
   * and `all` fanned out to every live mission child except the caller. A
   * delivery failure leaves the record pullable from the inbox.
   * @param caller - exact live lead or mission Agent.
   * @param request - address, content, and pre-delivery cancellation.
   * @returns the recorded message.
   */
  async sendMessage(caller: Agent, request: TowerMessageRequest): Promise<TowerMessage> {
    request.signal.throwIfAborted()
    const { store } = await this.requireStore(caller, request.signal)
    const recorded = await this.enqueue(async () => {
      const missions = await store.listMissions()
      const from = this.addressOf(caller, missions)
      if (request.to === 'lead' && from === 'lead') {
        throw new TowerLocalError('the lead cannot address a tower message to itself')
      }
      let target: TowerMission | undefined
      if (request.to !== 'lead' && request.to !== 'all') {
        target = missions.find(mission => mission.id === request.to)
        if (target === undefined) {
          throw new TowerLocalError(`unknown tower message address "${request.to}"; expected "lead", "all", or a mission id`)
        }
        if (target.status === 'spawning' || target.status === 'merged' || target.status === 'failed' || target.status === 'aborted') {
          throw new TowerLocalError(`mission "${request.to}" is ${target.status}; it cannot receive tower messages`)
        }
      }
      const message: TowerMessage = {
        id: randomUUID(),
        from,
        to: request.to,
        content: request.content,
        time: timestamp(),
      }
      await store.appendMessage(message)
      await this.recordActivity(store, {
        time: message.time, kind: 'message', actor: from,
        detail: `message from ${from} to ${request.to}: ${request.content.slice(0, 80)}`,
      })
      const recordedMessage: RecordedMessage = { message, missions, ...target !== undefined ? { target } : {} }
      return recordedMessage
    })
    await this.deliver(caller, recorded, request.signal)
    return recorded.message
  }

  /**
   * Read messages addressed to the caller (`all` included), newest last.
   * @param caller - exact live lead or mission Agent.
   * @param limit - maximum messages returned, taken from the newest.
   * @returns the caller's inbox slice.
   */
  async inbox(caller: Agent, limit?: number): Promise<TowerMessage[]> {
    const { store } = await this.requireStore(caller)
    return this.enqueue(async () => {
      const address = this.addressOf(caller, await store.listMissions())
      const messages = (await store.readMessages())
        .filter(message => message.to === address || message.to === 'all')
      if (limit === undefined) return messages
      if (limit <= 0) return []
      return messages.slice(-limit)
    })
  }

  /**
   * Persist one finding visible to every tower participant.
   * @param caller - exact live lead or mission Agent.
   * @param request - finding title and body.
   * @returns the recorded finding.
   */
  async recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding> {
    const { store } = await this.requireStore(caller)
    return this.enqueue(async () => {
      const finding: TowerFinding = {
        id: await store.nextFindingId(),
        title: request.title,
        body: request.body,
        author: this.addressOf(caller, await store.listMissions()),
        time: timestamp(),
      }
      await store.appendFinding(finding)
      await this.recordActivity(store, {
        time: finding.time, kind: 'finding', actor: finding.author,
        detail: `finding ${finding.id}: ${request.title}`,
      })
      return finding
    })
  }

  /**
   * List every recorded finding in creation order.
   * @param caller - exact live lead or mission Agent.
   * @returns all findings.
   */
  async listFindings(caller: Agent): Promise<TowerFinding[]> {
    const { store } = await this.requireStore(caller)
    return this.enqueue(() => store.readFindings())
  }

  /**
   * Append one review round stamping the mission's current branch tip.
   * `approve` moves the mission to `approved`; `reject` returns it to
   * `active` for rework.
   * @param caller - exact live lead Agent.
   * @param request - mission, verdict, and review summary.
   * @returns the recorded round.
   */
  async recordReview(caller: Agent, request: TowerReviewRequest): Promise<TowerReviewRound> {
    const { store } = await this.requireStore(caller)
    return this.enqueue(async () => {
      const mission = await this.requireMission(store, request.mission)
      if (mission.status !== 'active' && mission.status !== 'interrupted' && mission.status !== 'approved') {
        throw new TowerLocalError(`mission "${request.mission}" is ${mission.status}; reviews require an active, interrupted, or approved mission`)
      }
      const tip = await this.git.branchTip(store.root, mission.branch)
      const rounds = await store.readReviews(mission.id)
      const reviewer = this.addressOf(caller, await store.listMissions())
      const round: TowerReviewRound = {
        round: rounds.length + 1,
        verdict: request.verdict,
        commit: tip,
        summary: request.summary,
        reviewer,
        time: timestamp(),
      }
      await store.appendReview(mission.id, round)
      const status: TowerMissionStatus = request.verdict === 'approve' ? 'approved' : 'active'
      await store.writeMission({ ...mission, status, updatedAt: round.time })
      await this.recordActivity(store, {
        time: round.time, kind: 'review', actor: reviewer, mission: mission.id,
        detail: `${request.verdict} round ${round.round} at ${tip.slice(0, 12)}: ${request.summary}`,
      })
      return round
    })
  }

  /**
   * Merge one mission branch into the recorded base through the review gate:
   * the mission must be `approved` with an approving latest round whose
   * commit still equals the branch tip, the main checkout must sit on the
   * base, and the mission worktree must be clean. On success the merge
   * commit lands, the worktree is removed, and the mission is `merged`.
   * @param caller - exact live lead Agent.
   * @param id - the mission to merge.
   * @returns the merged mission and its merge commit.
   */
  async merge(caller: Agent, id: TowerMissionId): Promise<TowerMergeResult> {
    const { store, workspace } = await this.requireStore(caller)
    const prepared = await this.enqueue(async () => {
      const mission = await this.requireMission(store, id)
      if (mission.status !== 'approved') {
        throw new TowerLocalError(`mission "${id}" is ${mission.status}; only an approved mission can merge`)
      }
      const latest = (await store.readReviews(id)).at(-1)
      if (latest === undefined || latest.verdict !== 'approve') {
        throw new TowerLocalError(`mission "${id}" is approved without an approving latest review round; the record is inconsistent`)
      }
      const tip = await this.git.branchTip(store.root, mission.branch)
      if (tip !== latest.commit) {
        throw new TowerLocalError(`mission "${id}" branch tip ${tip.slice(0, 12)} no longer matches the approved commit ${latest.commit.slice(0, 12)}; review the new tip first`)
      }
      if (await this.git.isDirty(mission.worktree)) {
        throw new TowerLocalError(`mission "${id}" worktree has uncommitted changes; commit or clean them before merging`)
      }
      return { mission, tip }
    })
    const current = await this.git.currentBranch(store.root)
    if (current !== workspace.base) {
      throw new TowerLocalError(`the main checkout is on "${current}", not the recorded base "${workspace.base}"; check out the base before merging`)
    }
    await this.git.mergeNoFf(store.root, prepared.mission.branch)
    const mergeCommit = await this.git.headTip(store.root)
    // A removal failure is fatal here on purpose: retrying merge is safe
    // because git reports "Already up to date" and the gate re-passes.
    await this.git.removeWorktree(store.root, prepared.mission.worktree, false)
    return this.enqueue(async () => {
      const merged: TowerMission = { ...prepared.mission, status: 'merged', updatedAt: timestamp() }
      await store.writeMission(merged)
      await this.recordActivity(store, {
        time: merged.updatedAt, kind: 'merge', actor: 'lead', mission: id,
        detail: `merged ${prepared.mission.branch} into ${workspace.base} as ${mergeCommit.slice(0, 12)}`,
      }, prepared.tip)
      return { mission: await this.viewOf(store, merged), mergeCommit }
    })
  }

  /**
   * End the workspace's active work: drain live mission children owned by
   * the caller, remove mission worktrees (dirty ones are kept and reported
   * unless `force`), and leave `.tower/` in place as the audit trail.
   * @param caller - exact live lead Agent.
   * @param request - whether to remove dirty worktrees, and cancellation.
   * @returns removal and interruption facts.
   */
  async teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult> {
    request.signal.throwIfAborted()
    const { store } = await this.requireStore(caller, request.signal)
    const missions = await this.enqueue(() => store.listMissions())
    const agents: AgentRegistry | undefined = this.ctx.get('agents')
    const drainIds: SessionId[] = []
    for (const mission of missions) {
      if (mission.status === 'merged' || mission.owner === undefined || agents === undefined) continue
      // Runtime ownership, not durable lineage: a foreign live agent holding
      // the recorded id is never drained here.
      if (agents.isOwnedBy(mission.owner, caller)) drainIds.push(mission.owner)
    }
    if (drainIds.length > 0) {
      await this.ctx.subagents.drainContinuableChildren(caller, drainIds)
    }
    const removed: TowerMissionId[] = []
    const kept: { readonly id: TowerMissionId; readonly reason: string }[] = []
    for (const mission of missions) {
      if (mission.status === 'merged') continue
      if (!existsSync(mission.worktree)) continue
      if (!request.force && await this.git.isDirty(mission.worktree)) {
        kept.push({ id: mission.id, reason: 'worktree has uncommitted changes' })
        continue
      }
      try {
        await this.git.removeWorktree(store.root, mission.worktree, request.force)
        removed.push(mission.id)
      } catch (error: unknown) {
        kept.push({ id: mission.id, reason: `worktree removal failed: ${errorText(error)}` })
      }
    }
    await this.enqueue(async () => {
      await this.recordActivity(store, {
        time: timestamp(), kind: 'teardown', actor: 'lead',
        detail: `teardown: ${removed.length} removed, ${kept.length} kept, ${drainIds.length} interrupted`,
      })
    })
    return { removed, kept, interrupted: drainIds.length }
  }

  /**
   * Whether `session` owns an unmerged mission, read straight from the
   * durable records. Never enters the storage queue: the tower service calls
   * this from child-side authority checks that may run while a spawn
   * transaction is in flight, and the reads are atomic without it. A session
   * outside any tower workspace reads false; store corruption stays loud.
   * @param session - the candidate session.
   * @returns true when the session owns an unmerged mission.
   */
  async isMissionOwner(session: Session): Promise<boolean> {
    const cwd = session.header.cwd
    if (cwd === undefined) return false
    let root: string
    try {
      root = await this.resolveRoot(cwd)
    } catch (error: unknown) {
      if (error instanceof TowerLocalError && (error.code === 'NO_GIT' || error.code === 'NO_WORKSPACE')) return false
      throw error
    }
    const missions = await new TowerStore(root).listMissions()
    return missions.some(mission => mission.owner === session.id && mission.status !== 'merged')
  }

  /**
   * Resolve the workspace store root reachable from `cwd`: the git toplevel
   * when it carries `.tower/`, otherwise the main checkout when `cwd` sits in
   * a linked worktree (a mission worktree) whose main checkout carries one.
   * @param cwd - any directory inside the repository.
   * @param signal - optional caller cancellation for the git probe.
   * @returns the absolute store root.
   */
  private async resolveRoot(cwd: string, signal?: AbortSignal): Promise<string> {
    const toplevel = await this.git.showToplevel(cwd, signal)
    if (new TowerStore(toplevel).exists()) return toplevel
    const candidate = dirname(await this.git.commonDir(toplevel))
    if (candidate !== toplevel && new TowerStore(candidate).exists()) return candidate
    throw new TowerLocalError(`no tower workspace reachable from "${cwd}"; run tower init at the main checkout first`, 'NO_WORKSPACE')
  }

  /**
   * Resolve the caller's workspace store and record or fail loud.
   * @param caller - the Agent whose session cwd locates the workspace.
   * @param signal - optional caller cancellation for the git probe.
   * @returns the store and its workspace record.
   */
  private async requireStore(caller: Agent, signal?: AbortSignal): Promise<{ store: TowerStore; workspace: TowerWorkspace }> {
    const cwd = caller.session.header.cwd
    if (cwd === undefined) {
      throw new TowerLocalError(`session "${caller.id}" has no working directory; tower requires a cwd`, 'NO_WORKSPACE')
    }
    const store = new TowerStore(await this.resolveRoot(cwd, signal))
    const workspace = await store.readWorkspace()
    if (workspace === undefined) {
      throw new TowerLocalError(`"${store.root}" has no tower workspace record; run tower init first`, 'NO_WORKSPACE')
    }
    return { store, workspace }
  }

  /** Read one mission record or fail loud. */
  private async requireMission(store: TowerStore, id: TowerMissionId): Promise<TowerMission> {
    const mission = await store.readMission(id)
    if (mission === undefined) throw new TowerLocalError(`unknown mission "${id}"`)
    return mission
  }

  /**
   * Serialize one storage transaction after the current one settles. The
   * tail never rejects, so a failed transaction does not wedge later ones.
   */
  private enqueue<T>(transaction: () => Promise<T>): Promise<T> {
    const result = this.queue.then(transaction)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** The caller's tower address: its unmerged mission id, else `lead`. */
  private addressOf(caller: Agent, missions: readonly TowerMission[]): string {
    const owned = missions.find(mission => mission.owner === caller.session.id && mission.status !== 'merged')
    return owned?.id ?? 'lead'
  }

  /** Whether a session id names a live agent in this process. */
  private isLive(owner: SessionId | undefined): boolean {
    if (owner === undefined) return false
    const agents: AgentRegistry | undefined = this.ctx.get('agents')
    return agents?.get(owner) !== undefined
  }

  /**
   * Append one activity entry and notify commit-time observers. The
   * synchronous emit runs inside the storage transaction so notifications
   * stay in journal order; an invariant rejection reaches the operation.
   */
  private async recordActivity(store: TowerStore, entry: TowerActivityEntry, commit?: string): Promise<void> {
    await store.appendActivity(entry)
    const notice: TowerLocalActivityNotice = { root: store.root, entry, ...commit !== undefined ? { commit } : {} }
    this.ctx.emit(TOWER_ACTIVITY_EVENT, notice)
  }

  /** Build the display row for one mission: liveness, latest review, tip match. */
  private async viewOf(store: TowerStore, mission: TowerMission): Promise<TowerMissionView> {
    const latestReview = (await store.readReviews(mission.id)).at(-1)
    // A branchless mission (a failed spawn) never carries a review, so the
    // short-circuit keeps the tip probe off deleted branches.
    const tipMatchesReview = latestReview !== undefined
      && await this.git.branchTip(store.root, mission.branch) === latestReview.commit
    return {
      ...mission,
      ownerLive: this.isLive(mission.owner),
      ...latestReview !== undefined ? { latestReview } : {},
      tipMatchesReview,
    }
  }

  /** Record a provisioning failure: mission `failed` plus its activity entry. */
  private async failSpawn(store: TowerStore, mission: TowerMission, detail: string): Promise<void> {
    await store.writeMission({ ...mission, status: 'failed', updatedAt: timestamp() })
    await this.recordActivity(store, {
      time: timestamp(), kind: 'spawn', actor: 'lead', mission: mission.id,
      detail: `mission "${mission.title}" failed: ${detail}`,
    })
  }

  /** Roll back a provisioned worktree after the mission child failed to start. */
  private async rollbackSpawn(store: TowerStore, mission: TowerMission, cause: unknown): Promise<void> {
    await this.cleanupStep('worktree removal', () => this.git.removeWorktree(store.root, mission.worktree, true))
    await this.cleanupStep('branch deletion', () => this.git.deleteBranch(store.root, mission.branch))
    await this.enqueue(async () => {
      await this.failSpawn(store, mission, `mission child failed to start: ${errorText(cause)}`)
    })
  }

  /** Best-effort rollback step: log and continue when the step itself fails. */
  private async cleanupStep(label: string, step: () => Promise<void>): Promise<void> {
    try {
      await step()
    } catch (error: unknown) {
      /* v8 ignore next 3 -- rollback cleanup failure requires the git state to change within the same await window */
      this.ctx.logger.warn('dsh-tower-local: rollback %s failed: %o', label, error)
    }
  }

  /** Ensure the repository's info/exclude keeps `.tower/` out of status and adds. */
  private async ensureExcluded(root: string): Promise<void> {
    const excludePath = join(await this.git.commonDir(root), 'info', 'exclude')
    let text = ''
    try {
      text = await readFile(excludePath, 'utf8')
    } catch (error: unknown) {
      /* v8 ignore next 3 -- a read failure other than absence needs OS-level permission tampering */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (text.split('\n').some(line => line.trim() === '/.tower/')) return
    await mkdir(dirname(excludePath), { recursive: true })
    await appendFile(excludePath, '/.tower/\n', 'utf8')
  }

  /** Deliver one recorded message; a delivery failure leaves the record pullable. */
  private async deliver(caller: Agent, recorded: RecordedMessage, signal: AbortSignal): Promise<void> {
    const { message } = recorded
    const blocks: DeliveryContent = [{ type: 'text', text: `[tower message from ${message.from}]\n${message.content}` }]
    if (message.to === 'lead') {
      const parentId = caller.session.header.parentSession
      if (parentId === undefined) {
        throw new TowerLocalError('the mission caller has no recorded parent session to receive lead messages')
      }
      await this.ctx.subagents.sendMessage(caller, parentId, blocks, { signal })
      return
    }
    const sender = this.leadSender(caller, message.from)
    if (message.to === 'all') {
      for (const mission of recorded.missions) {
        if (mission.status !== 'active' && mission.status !== 'approved') continue
        if (mission.owner === undefined || mission.owner === caller.session.id) continue
        if (!this.isLive(mission.owner)) continue
        await this.ctx.subagents.sendMessage(sender, mission.owner, blocks, { signal })
      }
      return
    }
    const owner = recorded.target?.owner
    if (owner === undefined) {
      throw new TowerLocalError(`mission "${message.to}" has no mission child to deliver to`)
    }
    await this.ctx.subagents.sendMessage(sender, owner, blocks, { signal })
  }

  /** The live lead agent mediating mission-addressed delivery. */
  private leadSender(caller: Agent, from: string): Agent {
    if (from === 'lead') return caller
    const parentId = caller.session.header.parentSession
    if (parentId === undefined) {
      throw new TowerLocalError(`mission caller "${caller.id}" has no recorded parent session`)
    }
    const lead: Agent | undefined = this.ctx.get('agents')?.get(parentId)
    if (lead === undefined) {
      throw new TowerLocalError('the lead session is not live to mediate mission delivery')
    }
    return lead
  }
}
