/**
 * Scenario-local deterministic tower backend for the tower-merge-flow snapshot.
 *
 * The shipped `local` provider (`@deepseek-ai/dsh-tower-local`) stamps every
 * durable record with the wall clock, so a recorded transcript containing its
 * results could never replay as the byte-stable fixture the corpus requires.
 * This provider keeps the real tower contract (`ctx.tower` facade validation,
 * the ten `tower_*` tools, real git worktree provisioning, review-tip stamping,
 * merge, and worktree removal) while pinning only the ISO record timestamps.
 * Commit hashes stay reproducible because the scenario environment pins
 * `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and the git fixture setup pins
 * identity and config; every repository operation mirrors the local provider's
 * `GitEngine` argv vectors.
 *
 * One deliberate deviation from the local provider: the mission child runs as
 * a foreground one-shot delegation with the lead session's cwd instead of a
 * continuable child in the worktree path. The one-shot headless surface has no
 * driver to wake the lead when a background child settles, and the snapshot
 * harness tokenizes each child fixture against its own header cwd, so a child
 * cwd outside the parent's cannot replay; the mission prompt carries the
 * worktree's cwd-relative path instead. Coordination records live in memory: a
 * one-shot replay run never re-enters the workspace, and the merge result in
 * the committed `workspace.expected/` tree is the durable evidence.
 *
 * The driver half of this plugin also runs `/tower on main` on the lead's
 * first accepted pre-step — the headless runner submits the task as a plain
 * prompt and never executes commands — and answers every approval request with
 * `allowed-once` so the gated merge and teardown key paths run headlessly.
 *
 * @module tower-fixture
 */

import { execFile } from 'node:child_process'
import { join, normalize } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Pinned ISO-8601 record timestamp; matches the scenario's pinned git dates. */
const FIXED_TIME = '2026-09-11T00:00:00.000Z'

/** Lead-only tower tool names denied to mission children (dsh-tool-tower's mission filter). */
const LEAD_ONLY_TOOLS = ['tower_init', 'tower_spawn', 'tower_mission', 'tower_review', 'tower_merge', 'tower_teardown']

/** How many activity entries one dashboard returns, mirroring the local provider's tail. */
const ACTIVITY_TAIL = 10

export const name = 'tower-fixture'

export const inject = ['tower', 'commands', 'subagents']

/**
 * Run git with explicit argv and fail loud on a nonzero exit.
 * @param {string} cwd - working directory of the invocation.
 * @param {readonly string[]} args - git arguments.
 * @param {AbortSignal} [signal] - cancellation forwarded to the process.
 * @returns {Promise<string>} trimmed stdout.
 */
async function git(cwd, args, signal) {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      signal,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return stdout.trim()
  } catch (error) {
    const detail = error.stderr === undefined ? String(error) : String(error.stderr).trim()
    throw new Error(`tower-fixture: git ${args.join(' ')} failed in ${cwd}: ${detail}`)
  }
}

/** Deterministic in-memory tower backend registered as `tower-fixture`. */
class FixtureTowerProvider {
  constructor(ctx) {
    this.ctx = ctx
    this.workspace = undefined
    this.missions = []
    this.findings = []
    this.messages = []
    this.activity = []
    this.nextMissionNumber = 1
    this.nextFindingNumber = 1
  }

  get name() {
    return 'tower-fixture'
  }

  async validateBase(cwd, base) {
    const toplevel = normalize(await git(cwd, ['rev-parse', '--show-toplevel']))
    const verified = await git(toplevel, ['show-ref', '--verify', `refs/heads/${base}`])
      .then(() => true)
      .catch(() => false)
    if (!verified) {
      throw new Error(`"${base}" is not a local branch of the repository at "${toplevel}"`)
    }
  }

  async init(caller) {
    const mode = this.ctx.tower.mode(caller)
    if (!mode.active || mode.base === null) {
      throw new Error('tower mode is not active for the caller\'s session; select a base with /tower on <base> first')
    }
    const cwd = caller.session.header.cwd
    if (cwd === undefined) {
      throw new Error(`session "${caller.id}" has no working directory; tower requires a cwd`)
    }
    // Git prints forward-slash toplevels even on Windows; normalize so the
    // record path spelling matches the session cwd the harness tokenizes.
    const root = normalize(await git(cwd, ['rev-parse', '--show-toplevel']))
    this.workspace = { version: 1, base: mode.base, root, createdAt: FIXED_TIME }
    this.recordActivity('init', 'lead', `workspace initialized on base "${mode.base}"`)
    return { workspace: this.workspace, adopted: false, missions: 0 }
  }

  async status() {
    const views = []
    for (const mission of this.missions) {
      if (mission.status === 'merged') continue
      views.push(await this.viewOf(mission))
    }
    return { base: this.workspace.base, missions: views, findings: this.findings.length, activity: this.activity.slice(-ACTIVITY_TAIL) }
  }

  async spawnMission(caller, request) {
    const id = `m-${this.nextMissionNumber}`
    this.nextMissionNumber += 1
    const worktree = join(this.workspace.root, '.tower', 'worktrees', id)
    const mission = {
      id,
      title: request.title,
      prompt: request.prompt,
      base: this.workspace.base,
      branch: `tower/${id}`,
      worktree,
      status: 'spawning',
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      reviews: [],
    }
    this.missions.push(mission)
    try {
      await git(this.workspace.root, ['worktree', 'add', worktree, '-b', mission.branch, mission.base])
    } catch (error) {
      mission.status = 'failed'
      this.recordActivity('spawn', 'lead', `mission "${request.title}" failed: ${String(error.message)}`, mission.id)
      throw error
    }
    // The one-shot headless surface has no driver to wake the lead when a
    // background child settles, so this fixture runs the mission child as a
    // foreground one-shot delegation: tower_spawn resolves only after the
    // child finished its worktree work, which keeps the recorded turn
    // structure deterministic. The shipped local provider starts continuable
    // children instead (its mission children outlive the spawning turn).
    const run = await this.ctx.subagents.start('spawn', {
      label: request.title,
      prompt: [{ type: 'text', text: request.prompt }],
      parent: caller,
      cwd: caller.session.header.cwd,
      toolFilter: { deny: LEAD_ONLY_TOOLS },
      signal: request.signal,
    })
    const result = await run.result
    await Promise.resolve().then(() => run.dispose())
    if (result.stopReason !== 'completed') {
      mission.status = 'failed'
      this.recordActivity('spawn', 'lead', `mission "${request.title}" failed: child ended with stopReason ${result.stopReason}`, mission.id)
      throw new Error(`mission child for "${request.title}" ended with stopReason ${result.stopReason}`)
    }
    mission.status = 'active'
    mission.owner = run.id
    this.recordActivity('spawn', 'lead', `mission "${request.title}" spawned on branch ${mission.branch}`, mission.id)
    return this.viewOf(mission)
  }

  async abortMission(caller, id) {
    const mission = this.requireMission(id)
    mission.status = 'aborted'
    this.recordActivity('abort', 'lead', `mission "${mission.title}" aborted`, id)
    return this.viewOf(mission)
  }
  async sendMessage(caller, request) {
    const message = {
      id: `fixture-message-${this.messages.length + 1}`,
      from: 'lead',
      to: request.to,
      content: request.content,
      time: FIXED_TIME,
    }
    this.messages.push(message)
    this.recordActivity('message', 'lead', `message from lead to ${request.to}: ${request.content.slice(0, 80)}`)
    return message
  }

  async inbox() {
    return [...this.messages]
  }

  async recordFinding(caller, request) {
    const finding = {
      id: `f-${this.nextFindingNumber}`,
      title: request.title,
      body: request.body,
      author: 'lead',
      time: FIXED_TIME,
    }
    this.nextFindingNumber += 1
    this.findings.push(finding)
    this.recordActivity('finding', 'lead', `finding ${finding.id}: ${request.title}`)
    return finding
  }

  async listFindings() {
    return [...this.findings]
  }

  async recordReview(caller, request) {
    const mission = this.requireMission(request.mission)
    const tip = await git(this.workspace.root, ['rev-parse', `refs/heads/${mission.branch}`])
    const round = {
      round: mission.reviews.length + 1,
      verdict: request.verdict,
      commit: tip,
      summary: request.summary,
      reviewer: 'lead',
      time: FIXED_TIME,
    }
    mission.reviews.push(round)
    mission.status = request.verdict === 'approve' ? 'approved' : 'active'
    this.recordActivity('review', 'lead', `${request.verdict} round ${round.round} at ${tip.slice(0, 12)}: ${request.summary}`, mission.id)
    return round
  }

  async merge(caller, id) {
    const mission = this.requireMission(id)
    if (mission.status !== 'approved') {
      throw new Error(`mission "${id}" is ${mission.status}; only an approved mission can merge`)
    }
    const latest = mission.reviews.at(-1)
    const tip = await git(this.workspace.root, ['rev-parse', `refs/heads/${mission.branch}`])
    if (latest === undefined || latest.verdict !== 'approve' || tip !== latest.commit) {
      throw new Error(`mission "${id}" is not approved at its current tip`)
    }
    if ((await git(mission.worktree, ['status', '--porcelain'])).length > 0) {
      throw new Error(`mission "${id}" worktree has uncommitted changes; commit or clean them before merging`)
    }
    const current = await git(this.workspace.root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (current !== this.workspace.base) {
      throw new Error(`the main checkout is on "${current}", not the recorded base "${this.workspace.base}"; check out the base before merging`)
    }
    await git(this.workspace.root, ['merge', '--no-ff', '--no-edit', mission.branch])
    const mergeCommit = await git(this.workspace.root, ['rev-parse', 'HEAD'])
    await git(this.workspace.root, ['worktree', 'remove', mission.worktree])
    mission.status = 'merged'
    this.recordActivity('merge', 'lead', `merged ${mission.branch} into ${this.workspace.base} as ${mergeCommit.slice(0, 12)}`, id)
    return { mission: await this.viewOf(mission), mergeCommit }
  }

  async teardown(caller, request) {
    const removed = []
    const kept = []
    for (const mission of this.missions) {
      if (mission.status === 'merged') continue
      const dirty = (await git(mission.worktree, ['status', '--porcelain']).catch(() => '?? worktree missing')).length > 0
      if (!request.force && dirty) {
        kept.push({ id: mission.id, reason: 'worktree has uncommitted changes' })
        continue
      }
      try {
        await git(this.workspace.root, ['worktree', 'remove', ...(request.force ? ['--force'] : []), mission.worktree])
        removed.push(mission.id)
      } catch (error) {
        kept.push({ id: mission.id, reason: `worktree removal failed: ${String(error.message)}` })
      }
    }
    this.recordActivity('teardown', 'lead', `teardown: ${removed.length} removed, ${kept.length} kept, 0 interrupted`)
    return { removed, kept, interrupted: 0 }
  }

  async isMissionOwner(session) {
    return this.missions.some(mission => mission.owner === session.id && mission.status !== 'merged')
  }

  requireMission(id) {
    const mission = this.missions.find(candidate => candidate.id === id)
    if (mission === undefined) throw new Error(`unknown mission "${id}"`)
    return mission
  }

  async viewOf(mission) {
    const latestReview = mission.reviews.at(-1)
    const tipMatchesReview = latestReview === undefined
      ? false
      : await git(this.workspace.root, ['rev-parse', `refs/heads/${mission.branch}`])
        .then((tip) => tip === latestReview.commit)
        .catch(() => false)
    return {
      id: mission.id,
      title: mission.title,
      prompt: mission.prompt,
      base: mission.base,
      branch: mission.branch,
      worktree: mission.worktree,
      status: mission.status,
      createdAt: mission.createdAt,
      updatedAt: FIXED_TIME,
      ownerLive: mission.owner !== undefined && this.ctx.get('agents')?.get(mission.owner) !== undefined,
      tipMatchesReview,
      ...(latestReview !== undefined ? { latestReview } : {}),
    }
  }

  recordActivity(kind, actor, detail, mission) {
    this.activity.push({
      time: FIXED_TIME,
      kind,
      actor,
      detail,
      ...(mission !== undefined ? { mission } : {}),
    })
  }
}

/**
 * Mount the deterministic provider, the approval answerer, and the /tower
 * command driver.
 * @param {import('@deepseek-ai/cordis').Context} ctx - composition context.
 */
export function apply(ctx) {
  ctx.tower.registerProvider(new FixtureTowerProvider(ctx))

  // The gated tower operations ask through the approval seam; a headless
  // one-shot has no interactive answerer, so this fixture claims every request.
  ctx.on('approval/request', async (_request, next) => 'allowed-once')

  // The headless runner submits the task as a plain prompt, so the fixture
  // executes the /tower command itself on the lead's first accepted pre-step.
  // Running inside the pre-step keeps the ordering deterministic: the command
  // lifecycle events land between `turn/start` and the task's `user/message`,
  // and the tower service's own pre-step listener flushes the queued selection
  // right after this waterfall settles.
  let commanded = false
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (!commanded && agent.session.header.parentSession === undefined) {
      commanded = true
      await ctx.commands.execute(agent, '/tower on main', [], new AbortController().signal)
    }
    return next()
  })
}
