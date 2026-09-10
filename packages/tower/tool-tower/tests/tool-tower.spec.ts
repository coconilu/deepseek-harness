/** Unit composition of dsh-tool-tower over the real tool registry, tower facade, and approval seam. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TowerService from '@deepseek-ai/dsh-tower'
import { TowerMissionId } from '@deepseek-ai/dsh-tower'
import { StubTowerProvider, stubMission, stubMessage } from './fixtures/stub-provider.ts'
import * as toolTower from '../src/index.ts'

const TOOL_NAMES = [
  'tower_init',
  'tower_status',
  'tower_spawn',
  'tower_mission',
  'tower_send',
  'tower_inbox',
  'tower_finding',
  'tower_review',
  'tower_merge',
  'tower_teardown',
].sort()

interface ApprovalAsk {
  toolName: string
  reason?: string
}

interface Harness {
  ctx: Context
  provider: StubTowerProvider
  toolFiber: { dispose: () => Promise<void> }
  answer: (outcome: ApprovalOutcome | undefined) => void
  asks: ApprovalAsk[]
}

let callNumber = 0
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/**
 * Mount the real plugins the tools sit between: prompt/session projections
 * behind the tower facade, the tool registry, the approval seam, and an
 * in-memory provider. Only the Agent wrapper is a stand-in.
 * @param withApproval - compose the approval seam (default true).
 */
async function setup(withApproval = true): Promise<Harness> {
  const ctx = context = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TowerService, { section: 'Test tower policy.' })
  const provider = new StubTowerProvider()
  ctx.tower.registerProvider(provider)
  const asks: ApprovalAsk[] = []
  let answer: ApprovalOutcome | undefined
  if (withApproval) {
    await ctx.plugin(ApprovalService)
    ctx.on('approval/request', async (req, next) => {
      asks.push({ toolName: req.toolName, ...req.reason !== undefined ? { reason: req.reason } : {} })
      return answer ?? next()
    })
  }
  const toolFiber = await ctx.plugin(toolTower)
  return { ctx, toolFiber, provider, answer: (outcome) => { answer = outcome }, asks }
}

/** A caller backed by a real Session — the tools read `agent.session` and its cwd. */
function agentWithSession(id: string, options: { cwd?: string; mode?: boolean } = {}): Agent {
  const session = Session.create(SessionId(id))
  const carrier = options.cwd === undefined
    ? session
    : Session.create(SessionId(id), undefined, { ...session.header, cwd: options.cwd })
  if (options.mode === true) carrier.append('tower/mode', { active: true, base: 'main' })
  return { id: SessionId(id), session: carrier } as unknown as Agent
}

function call(ctx: Context, agent: Agent | undefined, name: string, args: unknown = {}): ReturnType<Context['tools']['execute']> {
  return ctx.tools.execute({
    callId: ToolCallId(`tower-call-${++callNumber}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...agent !== undefined ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const SPAWN_ARGS = { title: 'Fix the flake', prompt: 'Reproduce and pin the flaky test.' }

/** The lead tools every lead-only denial test names, with their valid input. */
const LEAD_ONLY_CALLS: readonly { name: string; args: unknown }[] = [
  { name: 'tower_init', args: {} },
  { name: 'tower_spawn', args: SPAWN_ARGS },
  { name: 'tower_mission', args: { mission_id: 'm-1', action: 'abort' } },
  { name: 'tower_review', args: { mission_id: 'm-1', verdict: 'approve', summary: 'looks right' } },
  { name: 'tower_merge', args: { mission_id: 'm-1' } },
  { name: 'tower_teardown', args: {} },
]

/** The comms tools every owner-allowed test names, with their valid input. */
const COMMS_CALLS: readonly { name: string; args: unknown }[] = [
  { name: 'tower_status', args: {} },
  { name: 'tower_send', args: { to: 'lead', content: 'progress note' } },
  { name: 'tower_inbox', args: {} },
  { name: 'tower_finding', args: { action: 'list' } },
]

describe('dsh-tool-tower registration', () => {
  it('registers the ten tower tools and exports the mission filter and plugin shape', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('tower_')).sort())
      .toEqual(TOOL_NAMES)
    expect(toolTower.MISSION_TOOL_FILTER).toEqual({
      deny: ['tower_init', 'tower_spawn', 'tower_mission', 'tower_review', 'tower_merge', 'tower_teardown'],
    })
    expect('default' in toolTower).toBe(false)
    expect(toolTower.name).toBe('tool-tower')
    expect(toolTower.inject).toEqual(['tower', 'tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolTower) as Record<string, unknown>
    expect(unwrapped).toBe(toolTower)
    expect(unwrapped.name).toBe('tool-tower')
    expect(unwrapped.inject).toEqual(['tower', 'tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('unregisters the tools when their contributing fiber is disposed and reinstates them on re-apply', async () => {
    const { ctx, toolFiber } = await setup()
    expect(ctx.tools.schemas().some(schema => schema.name === 'tower_init')).toBe(true)

    await toolFiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('tower_'))).toBe(false)

    toolTower.apply(ctx, { maxInbox: 20 })
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('tower_')).sort())
      .toEqual(TOOL_NAMES)
  })

  it('answers a no-agent dispatch with the loud caller requirement', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, undefined, 'tower_status')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('tower_status requires a calling Agent')
  })
})

describe('dsh-tool-tower authority', () => {
  it('serves every comms tool to a recorded mission owner without tower mode', async () => {
    const { ctx, provider } = await setup()
    const owner = agentWithSession('mission-owner')
    provider.owners.add('mission-owner')
    for (const { name, args } of COMMS_CALLS) {
      const result = await call(ctx, owner, name, args)
      expect(result.isError, `${name} should pass for a mission owner`).toBe(false)
    }
  })

  it('refuses comms tools to a session that is neither lead nor owner', async () => {
    const { ctx } = await setup()
    const outsider = agentWithSession('outsider')
    const result = await call(ctx, outsider, 'tower_status')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('tower_status requires active tower mode or a recorded mission owner')
  })

  it('refuses every lead-only tool to a mission owner whose session lacks tower mode', async () => {
    const { ctx, provider } = await setup()
    const owner = agentWithSession('mission-owner-2')
    provider.owners.add('mission-owner-2')
    for (const { name } of LEAD_ONLY_CALLS) {
      const result = await call(ctx, owner, name, LEAD_ONLY_CALLS.find(entry => entry.name === name)?.args)
      expect(result.isError, `${name} should stay lead-only`).toBe(true)
      expect(text(result)).toContain(`${name} is lead-only: the calling session does not have tower mode active`)
    }
    expect(provider.calls).toEqual([])
  })

  it('refuses a lead-only tool to a plain session with tower mode off', async () => {
    const { ctx } = await setup()
    const outsider = agentWithSession('plain')
    const result = await call(ctx, outsider, 'tower_spawn', SPAWN_ARGS)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('tower_spawn is lead-only')
  })
})

describe('dsh-tool-tower delegation', () => {
  it('init reports the workspace through the facade and keeps the projection compact', async () => {
    const { ctx, provider } = await setup()
    const lead = agentWithSession('lead-init', { cwd: '/repo', mode: true })
    const result = await call(ctx, lead, 'tower_init')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({
      workspace: { version: 1, base: 'main', root: '/repo', createdAt: '2026-09-10T00:00:00.000Z' },
      adopted: false,
      missions: 0,
    })
    expect(provider.calls).toEqual([`init:${String(lead.id)}`])
  })

  it('status projects mission rows without prompt/owner and includes latestReview plus activity', async () => {
    const { ctx, provider } = await setup()
    const lead = agentWithSession('lead-status', { cwd: '/repo', mode: true })
    provider.missions = [
      stubMission('m-1', {
        latestReview: { round: 1, verdict: 'approve', commit: 'deadbeef', summary: 'clean', reviewer: 'lead', time: '2026-09-10T01:00:00.000Z' },
        tipMatchesReview: true,
      }),
    ]
    provider.activity = [
      {
        time: '2026-09-10T01:30:00.000Z',
        kind: 'review',
        actor: 'lead',
        mission: TowerMissionId('m-1'),
        detail: 'approve round 1',
      },
      {
        time: '2026-09-10T01:45:00.000Z',
        kind: 'init',
        actor: 'lead',
        detail: 'workspace initialized on base "main"',
      },
    ]
    const result = await call(ctx, lead, 'tower_status')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({
      base: 'main',
      missions: [{
        id: 'm-1',
        title: 'Mission m-1',
        status: 'active',
        branch: 'tower/m-1',
        base: 'main',
        worktree: '/repo/.tower/worktrees/m-1',
        ownerLive: true,
        tipMatchesReview: true,
        latestReview: { round: 1, verdict: 'approve', commit: 'deadbeef', summary: 'clean', reviewer: 'lead', time: '2026-09-10T01:00:00.000Z' },
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
      }],
      findings: 0,
      activity: [
        {
          time: '2026-09-10T01:30:00.000Z',
          kind: 'review',
          actor: 'lead',
          detail: 'approve round 1',
          mission: 'm-1',
        },
        {
          time: '2026-09-10T01:45:00.000Z',
          kind: 'init',
          actor: 'lead',
          detail: 'workspace initialized on base "main"',
        },
      ],
    })
    expect(text(result)).toBe(JSON.stringify(result.value))
    const rows = (result.value as { missions: object[] }).missions
    expect(rows).toHaveLength(1)
    expect(Object.hasOwn(rows[0]!, 'prompt')).toBe(false)
    expect(Object.hasOwn(rows[0]!, 'owner')).toBe(false)
  })

  it('spawn forwards title, prompt, and the caller signal, and drops prompt/owner from the row', async () => {
    const { ctx, provider } = await setup()
    const lead = agentWithSession('lead-spawn', { cwd: '/repo', mode: true })
    const result = await call(ctx, lead, 'tower_spawn', SPAWN_ARGS)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({
      id: 'm-1',
      title: 'Mission m-1',
      status: 'active',
      branch: 'tower/m-1',
      base: 'main',
      worktree: '/repo/.tower/worktrees/m-1',
      ownerLive: true,
      tipMatchesReview: false,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    })
    // The facade's own maxMissions gate reads the dashboard before spawning.
    expect(provider.calls).toEqual([`status:${String(lead.id)}`, `spawnMission:${String(lead.id)}:Fix the flake`])
  })

  it('mission abort delegates with the branded id and returns the aborted row', async () => {
    const { ctx, provider } = await setup()
    const lead = agentWithSession('lead-abort', { cwd: '/repo', mode: true })
    const result = await call(ctx, lead, 'tower_mission', { mission_id: 'm-1', action: 'abort' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ id: 'm-1', status: 'aborted' })
    expect(provider.calls).toEqual([`abortMission:${String(lead.id)}:m-1`])
  })

  it('send delegates the address and content and returns the recorded message', async () => {
    const { ctx, provider } = await setup()
    const lead = agentWithSession('lead-send', { cwd: '/repo', mode: true })
    const result = await call(ctx, lead, 'tower_send', { to: 'all', content: 'status check' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({
      id: 'msg-1',
      from: 'lead',
      to: 'all',
      content: 'status check',
      time: '2026-09-10T00:00:00.000Z',
    })
    expect(provider.calls).toEqual([`sendMessage:${String(lead.id)}:all`])
  })

  it('inbox applies the deployment bound when limit is omitted and clamps explicit limits', async () => {
    const { ctx, provider } = await setup()
    const lead = agentWithSession('lead-inbox', { cwd: '/repo', mode: true })
    provider.inboxMessages = [stubMessage('msg-1', 'lead', 'first'), stubMessage('msg-2', 'all', 'second')]

    const defaulted = await call(ctx, lead, 'tower_inbox')
    expect(defaulted.isError).toBe(false)
    if (!defaulted.isError) expect(defaulted.value).toEqual({ messages: provider.inboxMessages })
    expect(provider.calls.at(-1)).toBe(`inbox:${String(lead.id)}:20`)

    const explicit = await call(ctx, lead, 'tower_inbox', { limit: 3 })
    expect(explicit.isError).toBe(false)
    expect(provider.calls.at(-1)).toBe(`inbox:${String(lead.id)}:3`)

    const oversized = await call(ctx, lead, 'tower_inbox', { limit: 500 })
    expect(oversized.isError).toBe(false)
    expect(provider.calls.at(-1)).toBe(`inbox:${String(lead.id)}:20`)
  })

  it('finding records with title and body and lists every recorded finding', async () => {
    const { ctx, provider } = await setup()
    const lead = agentWithSession('lead-finding', { cwd: '/repo', mode: true })

    const listed = await call(ctx, lead, 'tower_finding', { action: 'list' })
    expect(listed.isError).toBe(false)
    if (!listed.isError) expect(listed.value).toEqual({ findings: [] })
    expect(provider.calls.at(-1)).toBe(`listFindings:${String(lead.id)}`)

    const recorded = await call(ctx, lead, 'tower_finding', {
      action: 'record',
      title: 'Contract found',
      body: 'tower_merge requires an approved mission.',
    })
    expect(recorded.isError).toBe(false)
    if (!recorded.isError) {
      expect(recorded.value).toEqual({
        finding: {
          id: 'f-1',
          title: 'Contract found',
          body: 'tower_merge requires an approved mission.',
          author: 'lead',
          time: '2026-09-10T00:00:00.000Z',
        },
      })
    }
    expect(provider.calls.at(-1)).toBe(`recordFinding:${String(lead.id)}:Contract found`)
  })

  it('finding record fails loud on a blank title or body without touching the provider', async () => {
    const { ctx, provider } = await setup()
    const lead = agentWithSession('lead-finding-invalid', { cwd: '/repo', mode: true })

    const noTitle = await call(ctx, lead, 'tower_finding', { action: 'record', body: 'x' })
    expect(noTitle.isError).toBe(true)
    expect(text(noTitle)).toContain('tower_finding record requires a non-empty `title`')

    const blankBody = await call(ctx, lead, 'tower_finding', { action: 'record', title: 't', body: '   ' })
    expect(blankBody.isError).toBe(true)
    expect(text(blankBody)).toContain('tower_finding record requires a non-empty `body`')
    expect(provider.calls).toEqual([])
  })

  it('review delegates the verdict and returns the recorded round', async () => {
    const { ctx, provider } = await setup()
    const lead = agentWithSession('lead-review', { cwd: '/repo', mode: true })
    const result = await call(ctx, lead, 'tower_review', {
      mission_id: 'm-1',
      verdict: 'approve',
      summary: 'diff reviewed, tests green',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({
      round: 1,
      verdict: 'approve',
      commit: 'deadbeef',
      summary: 'diff reviewed, tests green',
      reviewer: 'lead',
      time: '2026-09-10T00:00:00.000Z',
    })
    expect(provider.calls).toEqual([`recordReview:${String(lead.id)}:m-1:approve`])
  })
})

describe('dsh-tool-tower approval gate', () => {
  /** Mount a lead whose session holds an open turn, the prerequisite of every approval ask. */
  async function leadWithOpenTurn(withApproval = true) {
    const harness = await setup(withApproval)
    const lead = agentWithSession('lead-merge', { cwd: '/repo', mode: true })
    lead.session.append('turn/start', { turn: 1 })
    return { ...harness, lead }
  }

  it('merge asks the user with the real target and merges on allowed-once', async () => {
    const { ctx, provider, answer, asks, lead } = await leadWithOpenTurn()
    provider.missions = [stubMission('m-1', { status: 'approved', tipMatchesReview: true })]
    answer('allowed-once')

    const result = await call(ctx, lead, 'tower_merge', { mission_id: 'm-1' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ mission: { id: 'm-1', status: 'merged' }, mergeCommit: 'cafe1234' })
    expect(asks).toHaveLength(1)
    expect(asks[0]?.toolName).toBe('tower_merge')
    expect(asks[0]?.reason).toContain('Merge tower mission m-1 ("Mission m-1", branch tower/m-1, status approved) into base "main"')
    expect(provider.calls).toContain(`merge:${String(lead.id)}:m-1`)
  })

  it('merge refuses without delegating when the answer is rejected or no answerer exists', async () => {
    const rejected = await leadWithOpenTurn()
    rejected.provider.missions = [stubMission('m-1', { status: 'approved' })]
    rejected.answer('rejected')
    const rejectedResult = await call(rejected.ctx, rejected.lead, 'tower_merge', { mission_id: 'm-1' })
    expect(rejectedResult.isError).toBe(true)
    expect(text(rejectedResult)).toContain('tower_merge was not approved (outcome: rejected)')
    expect(rejected.provider.calls.some(entry => entry.startsWith('merge:'))).toBe(false)

    const unavailable = await leadWithOpenTurn()
    unavailable.provider.missions = [stubMission('m-1', { status: 'approved' })]
    const unavailableResult = await call(unavailable.ctx, unavailable.lead, 'tower_merge', { mission_id: 'm-1' })
    expect(unavailableResult.isError).toBe(true)
    expect(text(unavailableResult)).toContain('tower_merge was not approved (outcome: unavailable)')
    expect(unavailable.provider.calls.some(entry => entry.startsWith('merge:'))).toBe(false)
  })

  it('merge fails closed when no approval service is composed', async () => {
    const { ctx, provider, lead } = await leadWithOpenTurn(false)
    provider.missions = [stubMission('m-1', { status: 'approved' })]
    const result = await call(ctx, lead, 'tower_merge', { mission_id: 'm-1' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('tower_merge requires the approval seam')
    expect(provider.calls.some(entry => entry.startsWith('merge:'))).toBe(false)
  })

  it('merge skips the prompt for an unknown mission and lets the facade fail loud', async () => {
    const { ctx, provider, answer, asks, lead } = await leadWithOpenTurn()
    const result = await call(ctx, lead, 'tower_merge', { mission_id: 'm-9' })
    expect(result.isError).toBe(false)
    expect(asks).toEqual([])
    answer(undefined)
    expect(provider.calls).toEqual([`status:${String(lead.id)}`, `merge:${String(lead.id)}:m-9`])
  })

  it('teardown asks the user with removal facts and delegates the force choice', async () => {
    const forced = await leadWithOpenTurn()
    forced.provider.missions = [stubMission('m-1'), stubMission('m-2', { ownerLive: false })]
    forced.provider.kept = [{ id: stubMission('m-2').id, reason: 'worktree has uncommitted changes' }]
    forced.answer('allowed-once')
    const forcedResult = await call(forced.ctx, forced.lead, 'tower_teardown', { force: true })
    expect(forcedResult.isError).toBe(false)
    if (!forcedResult.isError) {
      expect(forcedResult.value.kept).toEqual([{ id: 'm-2', reason: 'worktree has uncommitted changes' }])
    }
    expect(forced.provider.calls.at(-1)).toBe(`teardown:${String(forced.lead.id)}:true`)
    expect(forced.asks[0]?.reason).toContain('interrupt 1 live mission child(ren) and remove 2 mission worktree(s), including dirty ones')
    expect(forced.asks[0]?.reason).toContain('base "main"')

    const gentle = await leadWithOpenTurn()
    gentle.answer('allowed-once')
    const gentleResult = await call(gentle.ctx, gentle.lead, 'tower_teardown')
    expect(gentleResult.isError).toBe(false)
    expect(gentle.provider.calls.at(-1)).toBe(`teardown:${String(gentle.lead.id)}:false`)
    expect(gentle.asks[0]?.reason).toContain('(dirty worktrees are kept and reported)')
  })

  it('teardown refuses without delegating on rejection', async () => {
    const { ctx, provider, answer, lead } = await leadWithOpenTurn()
    answer('rejected')
    const result = await call(ctx, lead, 'tower_teardown', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('tower_teardown was not approved (outcome: rejected)')
    expect(provider.calls.some(entry => entry.startsWith('teardown:'))).toBe(false)
  })
})
