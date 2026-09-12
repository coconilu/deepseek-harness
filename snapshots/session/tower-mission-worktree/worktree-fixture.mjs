/**
 * Scenario-local deterministic tower backend for the tower-mission-worktree
 * snapshot.
 *
 * This fixture mirrors the shipped `local` provider's mission topology — the
 * lead forks a real git worktree and the mission child Session starts inside
 * it — while pinning only the ISO record timestamps the shared normalizer
 * cannot reproduce from the wall clock. Commit hashes stay reproducible
 * because the scenario environment pins `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`
 * and the `tower-git-fixture` setup pins identity and config. The mission
 * child runs as a foreground one-shot delegation whose durable session cwd is
 * the worktree path, so the recorded child fixture proves the harness's
 * per-role cwd replay contract; the child's mission prompt therefore stays
 * cwd-free and the child addresses its workspace with relative paths only.
 * Coordination records live in memory: a one-shot replay run never re-enters
 * the workspace.
 *
 * The driver half of this plugin also runs `/tower on main` on the lead's
 * first accepted pre-step — the headless runner submits the task as a plain
 * prompt and never executes commands — and answers every approval request
 * with `allowed-once`.
 *
 * @module worktree-fixture
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

export const name = 'worktree-fixture'

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
    throw new Error(`worktree-fixture: git ${args.join(' ')} failed in ${cwd}: ${detail}`)
  }
}

/** Deterministic in-memory tower backend registered as `worktree-fixture`. */
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
    return 'worktree-fixture'
  }

  async validateBase(cwd, base) {
    const toplevel = await git(cwd, ['rev-parse', '--show-toplevel'])
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
    // The mission child's durable session cwd is the worktree path — the real
    // `local` provider topology. The one-shot headless surface has no driver
    // to wake the lead when a background child settles, so this fixture runs
    // the child as a foreground one-shot delegation: tower_spawn resolves only
    // after the child finished its worktree work, which keeps the recorded
    // turn structure deterministic.
    const started = await this.ctx.subagents.start('spawn', {
      label: request.title,
      prompt: [{ type: 'text', text: request.prompt }],
      parent: caller,
      cwd: worktree,
      toolFilter: { deny: LEAD_ONLY_TOOLS },
      signal: request.signal,
    })
    const result = await started.result
    await Promise.resolve().then(() => started.dispose())
    if (result.stopReason !== 'completed') {
      mission.status = 'failed'
      this.recordActivity('spawn', 'lead', `mission "${request.title}" failed: child ended with stopReason ${result.stopReason}`, mission.id)
      throw new Error(`mission child for "${request.title}" ended with stopReason ${result.stopReason}`)
    }
    mission.status = 'active'
    mission.owner = started.id
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

  async merge() {
    throw new Error('worktree-fixture: merge is not part of the tower-mission-worktree scenario')
  }

  async teardown() {
    throw new Error('worktree-fixture: teardown is not part of the tower-mission-worktree scenario')
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
