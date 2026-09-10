/** Tower projection behavior. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import TowerService from '../src/index.ts'

interface Bench {
  ctx: Context
  session: Session
  values(): Record<string, unknown>
}

async function harness(withTower: boolean): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withTower) await ctx.plugin(TowerService, { section: 'tower policy' })
  const session = ctx.sessions.create()
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return {
    ctx,
    session,
    values: () => ctx.sessionProjections.snapshot(session).values,
  }
}

/** Append one logged /tower selection record (the executor's command/run shape). */
function runTowerCommand(session: Session, args: string, index: number): CommandId {
  const commandId = CommandId(`tower-proj-${String(index)}`)
  session.append('command/run', {
    commandId,
    name: 'tower',
    args,
    source: { kind: 'user' },
  })
  return commandId
}

/** Append the paired settlement for one projected tower command. */
function settleTowerCommand(session: Session, commandId: CommandId, kind: 'success' | 'error'): void {
  session.append('command/done', { commandId, kind })
}

/** Commit one tower/mode flip (the service's committed-selection shape). */
function commitTowerMode(session: Session, active: boolean, base?: string): void {
  session.append('tower/mode', active ? { active: true, base: base ?? 'main' } : { active: false })
}

describe('tower projection unit', () => {
  it('serves inactive/not-pending for the empty log', async () => {
    const bench = await harness(true)
    expect(bench.values().tower).toEqual({ active: false, pending: false })
  })

  it('a logged /tower on selection reads pending until tower/mode records it', async () => {
    const bench = await harness(true)
    const commandId = runTowerCommand(bench.session, ' on dev', 0)
    expect(bench.values().tower).toEqual({ active: false, pending: true })
    settleTowerCommand(bench.session, commandId, 'success')
    expect(bench.values().tower).toEqual({ active: false, pending: true })
    commitTowerMode(bench.session, true, 'dev')
    expect(bench.values().tower).toEqual({ active: true, pending: false, base: 'dev' })
  })

  it('drops a tower selection when its command settles with an error', async () => {
    const bench = await harness(true)
    commitTowerMode(bench.session, true, 'main')
    const commandId = runTowerCommand(bench.session, ' off', 0)
    expect(bench.values().tower).toEqual({ active: true, pending: true, base: 'main' })
    settleTowerCommand(bench.session, commandId, 'error')
    expect(bench.values().tower).toEqual({ active: true, pending: false, base: 'main' })
  })

  it('folds `off` args and non-selecting records correctly, and a matching selection is not pending', async () => {
    const bench = await harness(true)
    commitTowerMode(bench.session, true, 'main')
    // Another command's record never touches tower state.
    bench.session.append('command/run', {
      commandId: CommandId('other-1'), name: 'compact', args: '', source: { kind: 'user' },
    })
    expect(bench.values().tower).toEqual({ active: true, pending: false, base: 'main' })
    // A command lifecycle with omitted input carries no tower selection.
    bench.session.append('command/run', {
      commandId: CommandId('tower-no-input'), name: 'tower', source: { kind: 'user' },
    })
    expect(bench.values().tower).toEqual({ active: true, pending: false, base: 'main' })
    // A status query selects nothing.
    runTowerCommand(bench.session, ' status', 1)
    expect(bench.values().tower).toEqual({ active: true, pending: false, base: 'main' })
    runTowerCommand(bench.session, ' off', 2)
    expect(bench.values().tower).toEqual({ active: true, pending: true, base: 'main' })
    commitTowerMode(bench.session, false)
    expect(bench.values().tower).toEqual({ active: false, pending: false })
    // Selecting the already-committed state folds to not-pending (net zero).
    runTowerCommand(bench.session, 'off', 3)
    expect(bench.values().tower).toEqual({ active: false, pending: false })
  })

  it('freezes the active state across a request/header into activeAtLastHeader', async () => {
    const bench = await harness(true)
    commitTowerMode(bench.session, true, 'main')
    expect(bench.values().tower).toEqual({ active: true, pending: false, base: 'main' })
    expect(bench.ctx.sessionProjections.stateOf(bench.session, 'tower')?.activeAtLastHeader).toBeNull()
    bench.session.append('request/header', {
      header: { config: { provider: 'test', model: 'test-model' } },
      reason: 'initial',
    })
    expect(bench.values().tower).toEqual({ active: true, pending: false, base: 'main' })
    expect(bench.ctx.sessionProjections.stateOf(bench.session, 'tower')?.activeAtLastHeader).toBe(true)
    commitTowerMode(bench.session, false)
    expect(bench.values().tower).toEqual({ active: false, pending: false })
    expect(bench.ctx.sessionProjections.stateOf(bench.session, 'tower')?.activeAtLastHeader).toBe(true)
    bench.session.append('request/header', {
      header: { config: { provider: 'test', model: 'test-model' } },
      reason: 'change',
    })
    expect(bench.values().tower).toEqual({ active: false, pending: false })
    expect(bench.ctx.sessionProjections.stateOf(bench.session, 'tower')?.activeAtLastHeader).toBe(false)
  })

  it('has no tower key when dsh-tower is not composed', async () => {
    const bench = await harness(false)
    expect('tower' in bench.values()).toBe(false)
  })

  it('drops the key when the tower fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    const fiber = await bench.ctx.plugin(TowerService, { section: 'tower policy' })
    expect(bench.values().tower).toEqual({ active: false, pending: false })
    await fiber.dispose()
    expect('tower' in bench.values()).toBe(false)
  })

  it('cold replay recovers pending from the log alone (a fresh registry refolds it)', async () => {
    const bench = await harness(true)
    const commandId = runTowerCommand(bench.session, ' on dev', 0)
    settleTowerCommand(bench.session, commandId, 'success')
    // A second registry over the same log (the cold-read shape): no service
    // memory involved, the fold alone answers {active:false, pending:true}.
    const cold = await harness(true)
    for (const event of bench.session.snapshotEvents()) {
      if (event.type === 'command/run' || event.type === 'command/done' || event.type === 'tower/mode') {
        cold.session.append(event.type, event.data)
      }
    }
    expect(cold.values().tower).toEqual({ active: false, pending: true })
  })
})
