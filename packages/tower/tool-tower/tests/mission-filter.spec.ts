/** Mission children composed with MISSION_TOOL_FILTER cannot reach the lead-only tower tools. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { StubTowerProvider } from './fixtures/stub-provider.ts'
import TowerService from '@deepseek-ai/dsh-tower'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MISSION_TOOL_FILTER } from '../src/index.ts'
import * as toolTower from '../src/index.ts'

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

const SIGNAL = new AbortController().signal

/** The lead-only names a filtered mission child must never see. */
const LEAD_ONLY_NAMES = ['tower_init', 'tower_spawn', 'tower_mission', 'tower_review', 'tower_merge', 'tower_teardown']

/** The comms names a filtered mission child must still see. */
const COMMS_NAMES = ['tower_status', 'tower_send', 'tower_inbox', 'tower_finding']

const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Compose the real agent-loop stack with the tower facade, the tools, and an in-memory provider. */
async function setup(script: ConstructorParameters<typeof MockAdapter>[0]): Promise<{
  ctx: Context
  lead: Awaited<ReturnType<Context['agentLoop']['create']>>
  provider: StubTowerProvider
}> {
  const ctx = context = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-tower-filter-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TowerService, { section: 'Test tower policy.' })
  const provider = new StubTowerProvider()
  ctx.tower.registerProvider(provider)
  await ctx.plugin(toolTower)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('tool-tower-filter-lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, provider }
}

function call(ctx: Context, agent: NonNullable<Parameters<Context['tools']['execute']>[0]['agent']>, name: string, args: unknown = {}): ReturnType<Context['tools']['execute']> {
  return ctx.tools.execute({
    callId: ToolCallId(`tower-filter-call-${Math.random()}`),
    name,
    arguments: args,
    signal: SIGNAL,
    agent,
  })
}

describe('tower tools under the mission tool filter', () => {
  it('hides every lead-only tool from a mission child while keeping the comms set reachable', async () => {
    const { ctx, lead, provider } = await setup(['hang'])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'filtered mission child',
      request: {
        prompt: [{ type: 'text', text: 'work the mission under the tower filter' }],
        parent: lead,
        toolFilter: MISSION_TOOL_FILTER,
      },
      signal: SIGNAL,
    })
    const childId = started.childId
    try {
      const child = await vi.waitFor(() => {
        const found = ctx.agents.get(childId)
        expect(found?.status).toBe('running')
        return found!
      }, { timeout: 10_000 })

      const scope = scopeOf(child.ctx)
      if (scope === undefined) throw new Error('expected the mission child to carry an agent scope')
      const names = (await ctx.systemPrompt.assemble({ scope })).tools.map(schema => schema.name)
      expect(names.filter(name => LEAD_ONLY_NAMES.includes(name)).sort()).toEqual([])
      expect(names.filter(name => COMMS_NAMES.includes(name)).sort()).toEqual([...COMMS_NAMES].sort())

      const leadScope = scopeOf(lead.ctx)
      if (leadScope === undefined) throw new Error('expected the lead to carry an agent scope')
      const leadNames = (await ctx.systemPrompt.assemble({ scope: leadScope })).tools
        .map(schema => schema.name)
      expect(leadNames.filter(name => LEAD_ONLY_NAMES.includes(name)).sort()).toEqual([...LEAD_ONLY_NAMES].sort())

      // The filter is one visibility: an unknown-name denial, not a hidden call.
      const denied = await call(ctx, child, 'tower_spawn', { title: 'no', prompt: 'nope' })
      expect(denied.isError).toBe(true)
      const deniedText = denied.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(deniedText).toContain('unknown tool "tower_spawn"')

      provider.owners.add(String(childId))
      const status = await call(ctx, child, 'tower_status')
      expect(status.isError).toBe(false)
    } finally {
      ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: lead })
      await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 10_000 })
    }
  }, 30_000)

  it('ships the filter with exactly the six lead-only names', () => {
    expect(MISSION_TOOL_FILTER).toEqual({ deny: LEAD_ONLY_NAMES })
    expect('allow' in MISSION_TOOL_FILTER).toBe(false)
    expect(unsupportedInbox).toBeTypeOf('function')
  })
})
