/**
 * Model-facing tower tools: ten `tower_*` tools that adapt the `ctx.tower`
 * facade (the tower capability's Service Definition) to the tool registry.
 * Authority is enforced twice by design — here at the executor, which callers
 * can invoke directly, and again inside the facade. `tower_merge` and
 * `tower_teardown` ask the composed approval seam for the user's decision
 * before delegating; every other delegation is gated without a prompt.
 *
 * Tool catalog and authority:
 * - `tower_init` (lead-only) — create or adopt the workspace.
 * - `tower_status` (comms) — read the dashboard.
 * - `tower_spawn` (lead-only) — fork one mission worktree and child.
 * - `tower_mission` (lead-only) — mission control (`abort`).
 * - `tower_send` / `tower_inbox` / `tower_finding` (comms) — lead-mediated
 *   messages and shared findings.
 * - `tower_review` (lead-only) — record one review round.
 * - `tower_merge` / `tower_teardown` (lead-only, approval-gated) — land or
 *   end the workspace's active work.
 *
 * Lead-only tools require the calling session's tower mode to be active; the
 * comms set additionally admits the recorded owner of an unmerged mission.
 * Mission children should compose {@link MISSION_TOOL_FILTER} so the
 * lead-only names never reach their model.
 *
 * @module @deepseek-ai/dsh-tool-tower
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { TowerMissionId } from '@deepseek-ai/dsh-tower'
import type {
  TowerFinding,
  TowerMergeResult,
  TowerMessage,
  TowerMissionView,
  TowerTeardownResult,
  TowerWorkspaceInfo,
} from '@deepseek-ai/dsh-tower'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolRestriction, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval'

/** Cordis plugin name. */
export const name = 'tool-tower'

/** Services the tools read: the tower facade for every operation, the registry to publish into. */
export const inject = ['tower', 'tools']

/** Model-facing tower tool configuration. */
export interface Config {
  /**
   * Message bound for `tower_inbox`: the cap applied when the model omits
   * `limit`, and the ceiling every explicit limit clamps to. An unbounded
   * journal read would spend model context without bound.
   */
  readonly maxInbox: number
}

/** Schemastery configuration for the tower tool consumer: out-of-range bounds fail plugin load. */
export const Config: z<Config> = z.object({
  maxInbox: z.natural().min(1).max(200).default(20),
})

/**
 * The tool filter for mission children: it denies every lead-only tower tool
 * name, so a child composed with it can reach only the comms set. Requires
 * this package to be composed (restrictions name registered tools). Apply it
 * through the mission child's start `toolFilter`; the tools' own authority
 * gate remains the second line of defense when the filter is absent.
 */
export const MISSION_TOOL_FILTER: ToolRestriction = {
  deny: ['tower_init', 'tower_spawn', 'tower_mission', 'tower_review', 'tower_merge', 'tower_teardown'],
}

/** The comms tools: lead-gated, but also open to a recorded mission owner. */
const COMMS_TOOLS = new Set(['tower_status', 'tower_send', 'tower_inbox', 'tower_finding'])

/** Every mission status the facade can report, for the model-facing row schema. */
const MISSION_STATUSES = ['spawning', 'active', 'interrupted', 'approved', 'merged', 'failed', 'aborted'] as const

/** One review round, matching the facade's `TowerReviewRound`. */
const REVIEW_ROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    round: { type: 'integer', required: true },
    verdict: { type: 'string', required: true, enum: ['approve', 'reject'] },
    commit: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    reviewer: { type: 'string', required: true },
    time: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/**
 * One mission row: the facade's `TowerMissionView` without `prompt` (the
 * authoring session already holds the task text it wrote) and without
 * `owner` (an opaque session id with no model-facing meaning).
 */
const MISSION_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: [...MISSION_STATUSES] },
    branch: { type: 'string', required: true },
    base: { type: 'string', required: true },
    worktree: { type: 'string', required: true },
    ownerLive: { type: 'boolean', required: true },
    tipMatchesReview: { type: 'boolean', required: true },
    latestReview: REVIEW_ROUND_SCHEMA,
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** One shared finding, matching the facade's `TowerFinding`. */
const FINDING_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    body: { type: 'string', required: true },
    author: { type: 'string', required: true },
    time: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** One recorded message, matching the facade's `TowerMessage`. */
const MESSAGE_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    content: { type: 'string', required: true },
    time: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** One activity entry, matching the facade's `TowerActivityEntry`. */
const ACTIVITY_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    time: { type: 'string', required: true },
    kind: {
      type: 'string',
      required: true,
      enum: ['init', 'adopt', 'spawn', 'review', 'merge', 'abort', 'message', 'finding', 'teardown'],
    },
    actor: { type: 'string', required: true },
    detail: { type: 'string', required: true },
    mission: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

const INIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspace: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        version: { type: 'integer', required: true },
        base: { type: 'string', required: true },
        root: { type: 'string', required: true },
        createdAt: { type: 'string', required: true },
      },
    },
    adopted: { type: 'boolean', required: true },
    missions: { type: 'integer', required: true },
  },
} as const satisfies ValueSchemaSpec

const STATUS_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    base: { type: 'string', required: true },
    missions: { type: 'array', required: true, items: MISSION_ROW_SCHEMA },
    findings: { type: 'integer', required: true },
    activity: { type: 'array', required: true, items: ACTIVITY_ROW_SCHEMA },
  },
} as const satisfies ValueSchemaSpec

const MERGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mission: { ...MISSION_ROW_SCHEMA, required: true },
    mergeCommit: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

const TEARDOWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    removed: { type: 'array', required: true, items: { type: 'string' } },
    kept: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          reason: { type: 'string', required: true },
        },
      },
    },
    interrupted: { type: 'integer', required: true },
  },
} as const satisfies ValueSchemaSpec

const INBOX_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messages: { type: 'array', required: true, items: MESSAGE_ROW_SCHEMA },
  },
} as const satisfies ValueSchemaSpec

/** `record` returns the one recorded finding; `list` returns every finding. */
const FINDING_VALUE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        finding: { ...FINDING_ROW_SCHEMA, required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        findings: { type: 'array', required: true, items: FINDING_ROW_SCHEMA },
      },
    },
  ],
} as const satisfies ValueSchemaSpec

/**
 * Declare one canonical output schema rendered as compact JSON: every tower
 * result is a fixed record, so the declared schema is what makes the compiler
 * check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Project one facade mission view onto the model-facing row. */
function missionRow(mission: TowerMissionView): InferValue<typeof MISSION_ROW_SCHEMA> {
  const { latestReview } = mission
  return {
    id: mission.id,
    title: mission.title,
    status: mission.status,
    branch: mission.branch,
    base: mission.base,
    worktree: mission.worktree,
    ownerLive: mission.ownerLive,
    tipMatchesReview: mission.tipMatchesReview,
    ...latestReview !== undefined ? { latestReview } : {},
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  }
}

/** Project one facade finding onto the model-facing row. */
function findingRow(finding: TowerFinding): InferValue<typeof FINDING_ROW_SCHEMA> {
  return { id: finding.id, title: finding.title, body: finding.body, author: finding.author, time: finding.time }
}

/** Project one facade message onto the model-facing row. */
function messageRow(message: TowerMessage): InferValue<typeof MESSAGE_ROW_SCHEMA> {
  return { id: message.id, from: message.from, to: message.to, content: message.content, time: message.time }
}

/**
 * Recover the caller guaranteed by the agent loop: the registry sets `agent`
 * on every model-initiated dispatch.
 * @param agent - the execution's caller, if the dispatch carried one.
 * @param toolName - the executing tool, for the error text.
 * @returns the exact calling Agent.
 */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/**
 * Enforce the tool authority decision at the executor: lead-only tools need
 * active tower mode on the calling session; comms tools also admit the
 * recorded owner of an unmerged mission. The facade re-validates, but this
 * gate is what a direct executor call meets first.
 * @param tower - the tower facade.
 * @param agent - the exact calling Agent.
 * @param toolName - the executing tool, for the error text.
 */
async function assertAuthority(tower: Context['tower'], agent: Agent, toolName: string): Promise<void> {
  if (tower.mode(agent).active) return
  if (COMMS_TOOLS.has(toolName)) {
    if (await tower.isMissionOwner(agent.session)) return
    throw new Error(`${toolName} requires active tower mode or a recorded mission owner for the calling session`)
  }
  throw new Error(`${toolName} is lead-only: the calling session does not have tower mode active`)
}

/**
 * Ask the composed approval seam for the user's decision before one
 * delegation. The seam is optional at composition, so its absence fails
 * closed here, and only an explicit `allowed-once` proceeds.
 * @param approval - the approval service, or `undefined` when none is composed.
 * @param agent - the exact calling Agent, which receives the audit pair.
 * @param callId - the tool call the question attaches to.
 * @param toolName - the executing tool.
 * @param reason - the human-readable explanation shown to the user.
 * @param signal - cancellation owning the pending question.
 */
async function requestApproval(
  approval: ApprovalService | undefined,
  agent: Agent,
  callId: ToolCallId,
  toolName: string,
  reason: string,
  signal: AbortSignal,
): Promise<void> {
  if (approval === undefined) {
    throw new Error(`${toolName} requires the approval seam to ask the user; compose an approval service with answerers before calling ${toolName}`)
  }
  const outcome: ApprovalOutcome = await approval.request({ agent, toolName, callId, reason, signal })
  if (outcome !== 'allowed-once') {
    throw new Error(`${toolName} was not approved (outcome: ${outcome}); nothing was done — do not retry without the user's explicit approval`)
  }
}

/** Build one mission tool's parameter map with the shared mission id. */
function missionIdParam(): { mission_id: { type: 'string'; required: true; description: string } } {
  return {
    mission_id: { type: 'string', required: true, description: 'The mission id, like m-3.' },
  }
}

/**
 * Register the complete tower tool set on `ctx.tools`.
 * @param ctx - plugin context carrying the tower facade and the tool registry.
 * @param config - validated tool config.
 */
export function apply(ctx: Context, config: Config = { maxInbox: 20 }): void {
  const maxInbox = config.maxInbox

  ctx.tools.register(defineTool({
    name: 'tower_init',
    description: 'Create (or adopt) this workspace\'s tower at the calling session\'s git root: it records the base branch and the .tower/ coordination store. Call once after entering tower mode; re-running adopts any existing workspace and reports how many unmerged missions carried over. Lead-only.',
    parameters: {},
    output: jsonOutput(INIT_VALUE_SCHEMA),
    async execute(_args, exec) {
      const agent = callingAgent(exec.agent, 'tower_init')
      await assertAuthority(ctx.tower, agent, 'tower_init')
      const info: TowerWorkspaceInfo = await ctx.tower.init(agent)
      return {
        workspace: {
          version: info.workspace.version,
          base: info.workspace.base,
          root: info.workspace.root,
          createdAt: info.workspace.createdAt,
        },
        adopted: info.adopted,
        missions: info.missions,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tower_status',
    description: 'Read the tower dashboard: every unmerged mission with its status, owner liveness, and review-gate state, plus the findings count and the recent activity tail. Use it before deciding spawns, reviews, merges, or teardown. Open to the lead and to mission sessions.',
    parameters: {},
    output: jsonOutput(STATUS_VALUE_SCHEMA),
    async execute(_args, exec) {
      const agent = callingAgent(exec.agent, 'tower_status')
      await assertAuthority(ctx.tower, agent, 'tower_status')
      const dashboard = await ctx.tower.status(agent)
      return {
        base: dashboard.base,
        missions: dashboard.missions.map(missionRow),
        findings: dashboard.findings,
        activity: dashboard.activity.map(entry => ({
          time: entry.time,
          kind: entry.kind,
          actor: entry.actor,
          detail: entry.detail,
          ...entry.mission !== undefined ? { mission: entry.mission } : {},
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tower_spawn',
    description: 'Create one mission: fork the recorded base branch into an isolated git worktree and start a mission child there. Lead-only. The child sees only `prompt` plus later tower messages — put the complete task, context, constraints, and definition of done in it.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short mission title for dashboards and activity entries.' },
      prompt: { type: 'string', required: true, description: 'The COMPLETE task text the mission child receives.' },
    },
    output: jsonOutput(MISSION_ROW_SCHEMA),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'tower_spawn')
      await assertAuthority(ctx.tower, agent, 'tower_spawn')
      const mission = await ctx.tower.spawnMission(agent, { title: args.title, prompt: args.prompt, signal: exec.signal })
      return missionRow(mission)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tower_mission',
    description: 'Control one mission. Lead-only. action "abort" interrupts the mission\'s live child (its inbox survives) and marks the mission aborted; the branch and worktree stay for inspection.',
    parameters: {
      ...missionIdParam(),
      action: { type: 'string', required: true, enum: ['abort'], description: 'The control operation to apply.' },
    },
    output: jsonOutput(MISSION_ROW_SCHEMA),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'tower_mission')
      await assertAuthority(ctx.tower, agent, 'tower_mission')
      const mission = await ctx.tower.abortMission(agent, TowerMissionId(args.mission_id))
      return missionRow(mission)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tower_send',
    description: 'Send one message through the tower: `to` is "lead", one mission id, or "all" (every live mission except the sender). Open to the lead and mission sessions. The lead cannot address a message to itself.',
    parameters: {
      to: { type: 'string', required: true, description: '"lead", one mission id, or "all".' },
      content: { type: 'string', required: true, description: 'Self-contained message text for the receiver.' },
    },
    output: jsonOutput(MESSAGE_ROW_SCHEMA),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'tower_send')
      await assertAuthority(ctx.tower, agent, 'tower_send')
      const message = await ctx.tower.sendMessage(agent, { to: args.to, content: args.content, signal: exec.signal })
      return messageRow(message)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tower_inbox',
    description: 'Read the messages addressed to this session ("all" broadcasts included), newest last. Open to the lead and mission sessions. The result is bounded when `limit` is omitted.',
    parameters: {
      limit: { type: 'integer', description: 'Maximum messages to read, taken from the newest. Defaults to the deployment bound.' },
    },
    output: jsonOutput(INBOX_VALUE_SCHEMA),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'tower_inbox')
      await assertAuthority(ctx.tower, agent, 'tower_inbox')
      const messages = await ctx.tower.inbox(agent, Math.min(args.limit ?? maxInbox, maxInbox))
      return { messages: messages.map(messageRow) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tower_finding',
    description: 'Record one shared finding every tower participant can read, or list the findings recorded so far. Open to the lead and mission sessions. Record a finding whenever you learn something the other participants need — a blocker, a discovered contract, a shared decision.',
    parameters: {
      action: { type: 'string', required: true, enum: ['record', 'list'], description: 'record stores a new finding; list returns every finding.' },
      title: { type: 'string', description: 'Short finding title. Required for record.' },
      body: { type: 'string', description: 'The complete finding detail. Required for record.' },
    },
    output: jsonOutput(FINDING_VALUE_SCHEMA),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'tower_finding')
      await assertAuthority(ctx.tower, agent, 'tower_finding')
      if (args.action === 'list') {
        return { findings: (await ctx.tower.listFindings(agent)).map(findingRow) }
      }
      if (args.title === undefined || args.title.trim() === '') {
        throw new Error('tower_finding record requires a non-empty `title`')
      }
      if (args.body === undefined || args.body.trim() === '') {
        throw new Error('tower_finding record requires a non-empty `body`')
      }
      const finding = await ctx.tower.recordFinding(agent, { title: args.title, body: args.body })
      return { finding: findingRow(finding) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tower_review',
    description: 'Record one review round on a mission branch, stamping its current tip commit. Lead-only. verdict "approve" marks the mission approved (only approved missions can merge); "reject" returns it to active for rework.',
    parameters: {
      ...missionIdParam(),
      verdict: { type: 'string', required: true, enum: ['approve', 'reject'], description: 'The review verdict.' },
      summary: { type: 'string', required: true, description: 'Review summary: what was examined and why the verdict holds.' },
    },
    output: jsonOutput(REVIEW_ROUND_SCHEMA),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'tower_review')
      await assertAuthority(ctx.tower, agent, 'tower_review')
      return await ctx.tower.recordReview(agent, {
        mission: TowerMissionId(args.mission_id),
        verdict: args.verdict,
        summary: args.summary,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tower_merge',
    description: 'Merge one APPROVED mission branch back into the recorded base (a merge commit lands on the base and the mission worktree is removed). Lead-only; asks the user for approval before merging. The mission must be approved with an approving latest round whose commit still equals its branch tip.',
    parameters: missionIdParam(),
    output: jsonOutput(MERGE_VALUE_SCHEMA),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'tower_merge')
      await assertAuthority(ctx.tower, agent, 'tower_merge')
      // Approval describes the real target, so read the dashboard first. An
      // unknown id skips the prompt and lets the facade fail loud below: no
      // merge can occur, and the race window can only turn an approved merge
      // into a refused one, never the reverse.
      const dashboard = await ctx.tower.status(agent)
      const row = dashboard.missions.find(mission => mission.id === args.mission_id)
      if (row !== undefined) {
        await requestApproval(
          ctx.get('approval'),
          agent,
          exec.callId,
          'tower_merge',
          `Merge tower mission ${row.id} ("${row.title}", branch ${row.branch}, status ${row.status}) into base "${dashboard.base}". `
            + 'This creates a merge commit on the base and removes the mission worktree.',
          exec.signal,
        )
      }
      const result: TowerMergeResult = await ctx.tower.merge(agent, TowerMissionId(args.mission_id))
      return { mission: missionRow(result.mission), mergeCommit: result.mergeCommit }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tower_teardown',
    description: 'End the workspace\'s active tower work: interrupt live mission children, remove mission worktrees (dirty ones are kept and reported unless force), and leave the .tower/ records in place as the audit trail. Lead-only; asks the user for approval first. Tower mode itself stays on.',
    parameters: {
      force: { type: 'boolean', description: 'Remove dirty worktrees too. Defaults to false (dirty worktrees are kept and reported).' },
    },
    output: jsonOutput(TEARDOWN_VALUE_SCHEMA),
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'tower_teardown')
      await assertAuthority(ctx.tower, agent, 'tower_teardown')
      const force = args.force === true
      const dashboard = await ctx.tower.status(agent)
      const live = dashboard.missions.filter(mission => mission.ownerLive).length
      await requestApproval(
        ctx.get('approval'),
        agent,
        exec.callId,
        'tower_teardown',
        `Tear down this tower workspace on base "${dashboard.base}": interrupt ${live} live mission child(ren) and remove `
          + `${dashboard.missions.length} mission worktree(s)${force ? ', including dirty ones' : ' (dirty worktrees are kept and reported)'}. `
          + 'The .tower/ audit record stays.',
        exec.signal,
      )
      const result: TowerTeardownResult = await ctx.tower.teardown(agent, { force, signal: exec.signal })
      return {
        removed: result.removed,
        kept: result.kept.map(entry => ({ id: entry.id, reason: entry.reason })),
        interrupted: result.interrupted,
      }
    },
  }))
}
