import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import TowerService, { towerProjectionDefinition, TowerMissionId } from '../src/index.ts'
import type { Config, TowerUnitState } from '../src/index.ts'
import { StubTowerProvider, stubMission } from './stub-provider.ts'

const TOWER_SECTION = 'Test tower mode instructions.'
const TOWER_CONFIG = { section: TOWER_SECTION } satisfies Config
const SIGNAL = new AbortController().signal

/**
 * Drives the REAL plugin: mounts `dsh-tower` beside the real SystemPrompt and
 * projection registry, with fake Agents carrying real `Session`s. Request
 * boundaries are simulated by dispatching the real pre-step waterfall and the
 * following `step/start` session event used by the loop.
 */
async function agentWithSession(
  ctx: Context,
  id = 'agent-1',
  { active, base, cwd }: { active?: boolean; base?: string; cwd?: string } = {},
): Promise<Agent & { session: Session }> {
  let session = Session.create(SessionId(id))
  if (cwd !== undefined) {
    session = Session.create(SessionId(id), undefined, { ...session.header, cwd })
  }
  const agent = {
    id: SessionId(id),
    session,
    options: {},
    inject(message: UserMessage) {
      session.append('user/message', message, { surfaceOp: 'append' })
    },
  } as unknown as Agent & { session: Session }
  // Seeded tower state lands before the service reads it, matching resume.
  if (active !== undefined) {
    session.append('tower/mode', active ? { active: true, base: base ?? 'main' } : { active: false })
  }
  return agent
}

async function setup(config: Config = TOWER_CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(TowerService, config)
  return ctx
}

async function setupWithProvider(config: Config = TOWER_CONFIG): Promise<{ ctx: Context; provider: StubTowerProvider }> {
  const ctx = await setup(config)
  const provider = new StubTowerProvider('local')
  ctx.tower.registerProvider(provider)
  return { ctx, provider }
}

/** Mount the command registry and let the service's commands-injected child activate. */
async function mountCommands(ctx: Context): Promise<void> {
  await ctx.plugin(CommandRuntime)
  await new Promise(resolve => setImmediate(resolve))
}

function runTower(ctx: Context, agent: Agent, line: string) {
  return ctx.commands.execute(agent, line, [], SIGNAL)
}

/** Fold the log through the tower unit, as the projection registry does. */
function foldTowerMode(events: readonly SessionEvent[]): { active: boolean; base: string | null } {
  let state: TowerUnitState = towerProjectionDefinition.init()
  for (const event of events) state = towerProjectionDefinition.apply(state, event)
  return { active: state.active, base: state.base }
}

/** Dispatch pre-step processing and optionally its following step-start commit. */
async function boundary(
  ctx: Context,
  agent: Agent & { session: Session },
  type: 'pre-step' | 'step-start' = 'pre-step',
  outcome: 'enter' | 'reject' | 'aborted' = 'enter',
): Promise<void> {
  const events = agentEvents(ctx, agent)
  const message = createUserMessage({
    content: [{ type: 'text', text: 'boundary probe' }],
    source: { kind: 'user' },
  })
  const controller = new AbortController()
  if (outcome === 'aborted') controller.abort()
  const decision = await events.waterfall(
    'agent/pre-step',
    { messages: [message], turn: 1, step: 1, signal: controller.signal },
    () => Promise.resolve(outcome === 'reject'
      ? { kind: 'reject' as const }
      : { kind: 'enter' as const, messages: [message] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages.slice(1)) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  if (type === 'step-start') {
    const event = agent.session.append('step/start', { turn: 1, step: 1 })
    ctx.emit('session/event', agent.session, event)
  }
}

/** Open a turn so a selection queues for the boundary flush (the mid-turn shape). */
function openTurn(session: Session, turn = 0): void {
  session.append('turn/start', { turn })
}

/** Close the open turn (the between-turns shape: selections commit immediately). */
function closeTurn(session: Session, turn = 0): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Reach the command-only selection entry the `/tower` handler drives. */
function setMode(
  ctx: Context,
  agent: Agent,
  selection: { readonly active: true; readonly base: string } | { readonly active: false },
): string {
  return (ctx.tower as unknown as {
    setMode(agent: Agent, selection: typeof selection): string
  }).setMode(agent, selection)
}

describe('Config', () => {
  it('rejects a missing, blank, or out-of-bounds config at plugin load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await expect(ctx.plugin(TowerService, {} as Config)).rejects.toThrow(/invalid config/)
    await expect(ctx.plugin(TowerService, { section: '' })).rejects.toThrow(/invalid config/)
    await expect(ctx.plugin(TowerService, { section: 'x', maxMissions: 0 })).rejects.toThrow(/invalid config/)
    await expect(ctx.plugin(TowerService, { section: 'x', extra: 1 } as unknown as Config))
      .rejects.toThrow(/invalid config/)
  })

  it('applies the documented provider and mission defaults', async () => {
    // No `provider`/`maxMissions` keys: the facade resolves `local` and the
    // spawn bound reads 8 without either being configured.
    const { ctx, provider } = await setupWithProvider({ section: TOWER_SECTION })
    const agent = await agentWithSession(ctx, 'defaults', { active: true })
    await expect(ctx.tower.init(agent)).resolves.toMatchObject({ adopted: false })
    provider.missions = Array.from({ length: 8 }, (_, index) => stubMission(`m-${index + 1}`))
    await expect(ctx.tower.spawnMission(agent, { title: 't', prompt: 'p', signal: SIGNAL }))
      .rejects.toThrow('maxMissions 8')
  })

  it('fails direct construction with an invalid config', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    expect(() => new TowerService(ctx, {} as Config)).toThrow()
  })
})

describe('ctx.tower mode state', () => {
  it('reads the folded mode and base', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    expect(ctx.tower.mode(agent)).toEqual({ active: false, base: null })
    agent.session.append('tower/mode', { active: true, base: 'dev' })
    expect(ctx.tower.mode(agent)).toEqual({ active: true, base: 'dev' })
    agent.session.append('tower/mode', { active: false })
    expect(ctx.tower.mode(agent)).toEqual({ active: false, base: null })
  })

  it('fails when the required tower projection key is absent', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'missing-tower-projection')
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)
    expect(() => ctx.tower.mode(agent)).toThrow('tower requires the tower session projection')
  })

  it('requires the turnBoundary projection for a selection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    new TowerService(ctx, TOWER_CONFIG)
    const agent = await agentWithSession(ctx, 'missing-turn-boundary')
    // A differing selection reaches the open-turn read; a no-op returns first.
    expect(() => setMode(ctx, agent, { active: true, base: 'dev' }))
      .toThrow('tower requires the turnBoundary session projection')
  })

  it('commits a between-turns selection immediately, base included', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'idle-commit')
    expect(setMode(ctx, agent, { active: true, base: 'dev' })).toBe('committed')
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: true, base: 'dev' })
    expect(setMode(ctx, agent, { active: false })).toBe('committed')
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: false, base: null })
    await boundary(ctx, agent, 'step-start')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tower/mode')).toHaveLength(2)
  })

  it('queues a mid-turn selection and flushes it at the next accepted pre-step', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    expect(setMode(ctx, agent, { active: true, base: 'dev' })).toBe('queued')
    expect(ctx.tower.mode(agent)).toEqual({ active: false, base: null })
    await boundary(ctx, agent)
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: true, base: 'dev' })
  })

  it('drops a no-op selection (target equals the pending or logged target)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    expect(setMode(ctx, agent, { active: false })).toBe('noop')
    openTurn(agent.session)
    expect(setMode(ctx, agent, { active: true, base: 'dev' })).toBe('queued')
    expect(setMode(ctx, agent, { active: true, base: 'dev' })).toBe('noop')
  })

  it('treats a base switch as a distinct selection', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'base-switch', { active: true, base: 'main' })
    expect(setMode(ctx, agent, { active: true, base: 'main' })).toBe('noop')
    expect(setMode(ctx, agent, { active: true, base: 'dev' })).toBe('committed')
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: true, base: 'dev' })
  })

  it('cancels a mid-turn pending selection that returns to the logged target', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    expect(setMode(ctx, agent, { active: true, base: 'dev' })).toBe('queued')
    expect(setMode(ctx, agent, { active: false })).toBe('cancelled')
    await boundary(ctx, agent)
    expect(agent.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)
  })

  it('cancels a between-turns reversal of a mid-turn pending intent without logging', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    expect(setMode(ctx, agent, { active: true, base: 'dev' })).toBe('queued')
    closeTurn(agent.session)
    expect(setMode(ctx, agent, { active: false })).toBe('cancelled')
    expect(agent.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)
  })

  it('does not flush when the step is rejected or the signal is aborted', async () => {
    const ctx = await setup()
    const rejected = await agentWithSession(ctx, 'rejected')
    openTurn(rejected.session)
    setMode(ctx, rejected, { active: true, base: 'dev' })
    await boundary(ctx, rejected, 'pre-step', 'reject')
    expect(rejected.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)

    const aborted = await agentWithSession(ctx, 'aborted')
    openTurn(aborted.session)
    setMode(ctx, aborted, { active: true, base: 'dev' })
    await boundary(ctx, aborted, 'pre-step', 'aborted')
    expect(aborted.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)
  })

  it('clears a flushed selection that already matches the logged target without appending', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    setMode(ctx, agent, { active: true, base: 'dev' })
    setMode(ctx, agent, { active: false })
    await boundary(ctx, agent)
    expect(agent.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)
  })

  it('contains an append failure and keeps the selection pending for the next boundary', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    setMode(ctx, agent, { active: true, base: 'dev' })
    const original = agent.session.append.bind(agent.session)
    agent.session.append = (((type: string, ...rest: unknown[]) => {
      if (type === 'tower/mode') throw new Error('backend gone')
      return (original as (...args: unknown[]) => unknown)(type, ...rest)
    }) as unknown) as typeof agent.session.append
    await boundary(ctx, agent, 'step-start')
    expect(warn).toHaveBeenCalledOnce()
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: false, base: null })
    agent.session.append = original
    await boundary(ctx, agent, 'step-start')
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: true, base: 'dev' })
  })
})

describe('the tower:policy prompt section', () => {
  it('renders the configured section only while the mode is active or pending', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    const sectionOf = async (target?: Agent) => (await ctx.systemPrompt.assemble(
      target === undefined ? {} : { agent: target, scope: target },
    )).sections.find(section => section.name === 'tower:policy')?.text

    expect(await sectionOf()).toBe('')
    expect(await sectionOf(agent)).toBe('')
    agent.session.append('tower/mode', { active: true, base: 'main' })
    expect(await sectionOf(agent)).toBe(TOWER_SECTION)

    const entering = await agentWithSession(ctx, 'entering')
    openTurn(entering.session)
    setMode(ctx, entering, { active: true, base: 'dev' })
    expect(await sectionOf(entering)).toBe(TOWER_SECTION)

    const leaving = await agentWithSession(ctx, 'leaving', { active: true })
    openTurn(leaving.session)
    setMode(ctx, leaving, { active: false })
    expect(await sectionOf(leaving)).toBe('')
  })
})

describe('/tower', () => {
  it('registers only when a commands service is composed', async () => {
    const bare = await setup()
    expect(bare.get('commands')).toBeUndefined()

    const ctx = await setup()
    await mountCommands(ctx)
    const agent = await agentWithSession(ctx, 'listed')
    expect(ctx.commands.list(agent)).toEqual([
      { name: 'tower', description: 'Enter or leave tower mode, or show its status', input: { hint: 'on <base>|off|status' } },
    ])
    expect(await runTower(ctx, agent, '/plan')).toBeUndefined()
  })

  it('echoes the current mode and base on /tower status without logging', async () => {
    const ctx = await setup()
    await mountCommands(ctx)
    const inactive = await agentWithSession(ctx, 'status-inactive')
    expect((await runTower(ctx, inactive, '/tower status'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode off.' })

    const active = await agentWithSession(ctx, 'status-active', { active: true, base: 'dev' })
    expect((await runTower(ctx, active, '/tower status'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode on (base: dev).' })

    const baseless = await agentWithSession(ctx, 'status-baseless')
    baseless.session.append('tower/mode', { active: true })
    expect((await runTower(ctx, baseless, '/tower status'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode on.' })

    expect(inactive.session.snapshotEvents().filter(event => event.type === 'tower/mode')).toHaveLength(0)
    expect(active.session.snapshotEvents().filter(event => event.type === 'tower/mode')).toHaveLength(1)
  })

  it('rejects unknown input with the usage line', async () => {
    const ctx = await setup()
    await mountCommands(ctx)
    const agent = await agentWithSession(ctx, 'usage')
    for (const line of ['/tower', '/tower on', '/tower frobnicate', '/tower on main extra']) {
      expect((await runTower(ctx, agent, line))?.result)
        .toEqual({ kind: 'error', text: 'Usage: /tower on <base> | /tower off | /tower status.' })
    }
  })

  it('validates the base through the selected provider before any event lands', async () => {
    const { ctx, provider } = await setupWithProvider()
    await mountCommands(ctx)
    const agent = await agentWithSession(ctx, 'on-committed', { cwd: '/repo' })
    expect((await runTower(ctx, agent, '/tower on dev'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode on (base: dev).' })
    expect(provider.validateBaseCalls).toEqual([['/repo', 'dev']])
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: true, base: 'dev' })
  })

  it('fails /tower on loud without a registered provider or a session cwd', async () => {
    const ctx = await setup()
    await mountCommands(ctx)
    const noProvider = await agentWithSession(ctx, 'on-no-provider', { cwd: '/repo' })
    expect((await runTower(ctx, noProvider, '/tower on dev'))?.result)
      .toEqual({ kind: 'error', text: 'no tower provider registered for "local"' })
    expect(noProvider.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)

    const { ctx: withProvider, provider } = await setupWithProvider()
    await mountCommands(withProvider)
    const noCwd = await agentWithSession(withProvider, 'on-no-cwd')
    expect((await runTower(withProvider, noCwd, '/tower on dev'))?.result)
      .toEqual({ kind: 'error', text: 'Tower mode requires a session working directory; this session has no cwd.' })
    expect(provider.validateBaseCalls).toEqual([])
    expect(noCwd.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)
  })

  it('logs nothing when validateBase rejects, with the provider message verbatim', async () => {
    const { ctx, provider } = await setupWithProvider()
    await mountCommands(ctx)
    provider.validateBaseError = new Error('branch "nope" does not exist')
    const agent = await agentWithSession(ctx, 'on-invalid', { cwd: '/repo' })
    expect((await runTower(ctx, agent, '/tower on nope'))?.result)
      .toEqual({ kind: 'error', text: 'branch "nope" does not exist' })
    expect(agent.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)

    provider.validateBaseError = 'not a local branch'
    const plain = await agentWithSession(ctx, 'on-invalid-plain', { cwd: '/repo' })
    expect((await runTower(ctx, plain, '/tower on nope'))?.result)
      .toEqual({ kind: 'error', text: 'not a local branch' })
    expect(plain.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)
  })

  it('queues /tower on mid-turn and flushes it at the boundary', async () => {
    const { ctx } = await setupWithProvider()
    await mountCommands(ctx)
    const agent = await agentWithSession(ctx, 'on-queued', { cwd: '/repo' })
    openTurn(agent.session)
    expect((await runTower(ctx, agent, '/tower on dev'))?.result)
      .toEqual({ kind: 'success', text: 'Entering tower mode (base: dev; applies from the next step).' })
    expect(ctx.tower.mode(agent)).toEqual({ active: false, base: null })
    await boundary(ctx, agent)
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: true, base: 'dev' })
  })

  it('reads /tower on as idempotent on the current base and switches base otherwise', async () => {
    const { ctx, provider } = await setupWithProvider()
    await mountCommands(ctx)
    const agent = await agentWithSession(ctx, 'on-noop', { active: true, base: 'main', cwd: '/repo' })
    expect((await runTower(ctx, agent, '/tower on main'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode is already active (base: main).' })
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: true, base: 'main' })
    expect((await runTower(ctx, agent, '/tower on dev'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode on (base: dev).' })
    expect(foldTowerMode(agent.session.snapshotEvents())).toEqual({ active: true, base: 'dev' })
    expect(provider.validateBaseCalls).toEqual([['/repo', 'main'], ['/repo', 'dev']])
  })

  it('cancels a pending exit when /tower on reselects the logged base mid-turn', async () => {
    const { ctx } = await setupWithProvider()
    await mountCommands(ctx)
    const agent = await agentWithSession(ctx, 'on-cancelled', { active: true, base: 'main', cwd: '/repo' })
    openTurn(agent.session)
    await runTower(ctx, agent, '/tower off')
    expect((await runTower(ctx, agent, '/tower on main'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode change cancelled.' })
    await boundary(ctx, agent)
    expect(ctx.tower.mode(agent)).toEqual({ active: true, base: 'main' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tower/mode')).toHaveLength(1)
  })

  it('leaves tower mode on /tower off, immediately between turns and queued mid-turn', async () => {
    const ctx = await setup()
    await mountCommands(ctx)
    const idle = await agentWithSession(ctx, 'off-idle', { active: true })
    expect((await runTower(ctx, idle, '/tower off'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode off.' })
    expect(foldTowerMode(idle.session.snapshotEvents())).toEqual({ active: false, base: null })

    const active = await agentWithSession(ctx, 'off-queued', { active: true })
    openTurn(active.session)
    expect((await runTower(ctx, active, '/tower off'))?.result)
      .toEqual({ kind: 'success', text: 'Leaving tower mode (applies from the next step).' })
    expect((await runTower(ctx, active, '/tower off'))?.result)
      .toEqual({ kind: 'success', text: 'Leaving tower mode (applies from the next step).' })
    await boundary(ctx, active)
    expect(ctx.tower.mode(active)).toEqual({ active: false, base: null })
  })

  it('treats /tower off as idempotent while inactive and cancels a pending entry', async () => {
    const { ctx } = await setupWithProvider()
    await mountCommands(ctx)
    const inactive = await agentWithSession(ctx, 'off-noop')
    expect((await runTower(ctx, inactive, '/tower off'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode is already inactive.' })

    const entering = await agentWithSession(ctx, 'off-cancelled', { cwd: '/repo' })
    openTurn(entering.session)
    await runTower(ctx, entering, '/tower on dev')
    expect((await runTower(ctx, entering, '/tower off'))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode entry cancelled.' })
    await boundary(ctx, entering)
    expect(entering.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)
  })

  it('removes the contributed command when the tower plugin is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(CommandRuntime)
    const fiber = await ctx.plugin(TowerService, TOWER_CONFIG)
    await new Promise(resolve => setImmediate(resolve))
    const agent = await agentWithSession(ctx)
    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['tower'])

    await fiber.dispose()
    expect(ctx.commands.list(agent)).toEqual([])
  })
})

describe('the provider registry', () => {
  it('rejects a duplicate provider name', async () => {
    const ctx = await setup()
    ctx.tower.registerProvider(new StubTowerProvider('local'))
    expect(() => {
      ctx.tower.registerProvider(new StubTowerProvider('local'))
    }).toThrow('a tower provider named "local" is already registered')
  })

  it('removes a provider when its registering fiber disposes (HMR safety)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'hmr-provider', { active: true })
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.tower.registerProvider(new StubTowerProvider('local'))
    }, { inject: ['tower'] }))
    await expect(ctx.tower.init(agent)).resolves.toMatchObject({ adopted: false })

    await fiber.dispose()
    await expect(ctx.tower.init(agent)).rejects.toThrow('no tower provider registered for "local"')
  })

  it('fails every facade operation loud when the selected provider is absent', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'no-provider-facade', { active: true })
    await expect(ctx.tower.status(agent)).rejects.toThrow('no tower provider registered for "local"')
    await expect(ctx.tower.spawnMission(agent, { title: 't', prompt: 'p', signal: SIGNAL }))
      .rejects.toThrow('no tower provider registered for "local"')
    await expect(ctx.tower.isMissionOwner(agent.session))
      .rejects.toThrow('no tower provider registered for "local"')
  })
})

describe('the caller-authority facade', () => {
  const leadOnlyOps: [string, (tower: TowerService, agent: Agent) => Promise<unknown>][] = [
    ['init', (tower, agent) => tower.init(agent)],
    ['spawnMission', (tower, agent) => tower.spawnMission(agent, { title: 't', prompt: 'p', signal: SIGNAL })],
    ['abortMission', (tower, agent) => tower.abortMission(agent, TowerMissionId('m-1'))],
    ['recordReview', (tower, agent) => tower.recordReview(agent, { mission: TowerMissionId('m-1'), verdict: 'approve', summary: 's' })],
    ['merge', (tower, agent) => tower.merge(agent, TowerMissionId('m-1'))],
    ['teardown', (tower, agent) => tower.teardown(agent, { force: false, signal: SIGNAL })],
  ]
  const participantOps: [string, (tower: TowerService, agent: Agent) => Promise<unknown>][] = [
    ['status', (tower, agent) => tower.status(agent)],
    ['sendMessage', (tower, agent) => tower.sendMessage(agent, { to: 'lead', content: 'hi', signal: SIGNAL })],
    ['inbox', (tower, agent) => tower.inbox(agent, 3)],
    ['recordFinding', (tower, agent) => tower.recordFinding(agent, { title: 't', body: 'b' })],
    ['listFindings', (tower, agent) => tower.listFindings(agent)],
  ]

  it.each(leadOnlyOps)('%s rejects a caller without active tower mode before touching the provider', async (operation, call) => {
    const { ctx, provider } = await setupWithProvider()
    const agent = await agentWithSession(ctx, `lead-only-${operation}`)
    await expect(call(ctx.tower, agent)).rejects.toThrow(`tower.${operation} is lead-only`)
    expect(provider.calls).toEqual([])
  })

  it.each(leadOnlyOps)('%s delegates for an active lead', async (_operation, call) => {
    const { ctx, provider } = await setupWithProvider()
    const agent = await agentWithSession(ctx, 'lead', { active: true })
    await expect(call(ctx.tower, agent)).resolves.toBeDefined()
    expect(provider.calls.length).toBeGreaterThan(0)
  })

  it.each(participantOps)('%s rejects an inactive caller who owns no mission', async (operation, call) => {
    const { ctx, provider } = await setupWithProvider()
    const agent = await agentWithSession(ctx, `participant-denied-${operation}`)
    await expect(call(ctx.tower, agent))
      .rejects.toThrow(`tower.${operation} requires an active tower mode or a recorded mission owner`)
    expect(provider.calls).toEqual([])
  })

  it.each(participantOps)('%s admits a recorded mission owner', async (_operation, call) => {
    const { ctx, provider } = await setupWithProvider()
    const agent = await agentWithSession(ctx, 'mission-owner')
    provider.owners.add(agent.session.id)
    await expect(call(ctx.tower, agent)).resolves.toBeDefined()
    expect(provider.calls.length).toBeGreaterThan(0)
  })

  it.each(participantOps)('%s admits an active lead', async (_operation, call) => {
    const { ctx } = await setupWithProvider()
    const agent = await agentWithSession(ctx, 'lead-participant', { active: true })
    await expect(call(ctx.tower, agent)).resolves.toBeDefined()
  })

  it('enforces maxMissions on the complete unmerged result before delegating', async () => {
    const { ctx, provider } = await setupWithProvider({ section: TOWER_SECTION, maxMissions: 2 })
    const agent = await agentWithSession(ctx, 'bounded', { active: true })
    provider.missions = [stubMission('m-1')]
    await expect(ctx.tower.spawnMission(agent, { title: 'third', prompt: 'p', signal: SIGNAL }))
      .resolves.toMatchObject({ id: 'm-2' })
    expect(provider.calls).toEqual(['status:bounded', 'spawnMission:bounded:third'])

    provider.missions = [stubMission('m-1'), stubMission('m-2')]
    await expect(ctx.tower.spawnMission(agent, { title: 'over', prompt: 'p', signal: SIGNAL }))
      .rejects.toThrow('tower.spawnMission refused: the workspace already has 2 unmerged missions (maxMissions 2)')
    expect(provider.calls).toEqual(['status:bounded', 'spawnMission:bounded:third', 'status:bounded'])
  })

  it('reads mission ownership through the selected provider', async () => {
    const { ctx, provider } = await setupWithProvider()
    const agent = await agentWithSession(ctx, 'ownership')
    expect(await ctx.tower.isMissionOwner(agent.session)).toBe(false)
    provider.owners.add(agent.session.id)
    expect(await ctx.tower.isMissionOwner(agent.session)).toBe(true)
  })
})

describe('HMR disposal', () => {
  it('unregisters the service, listeners, prompt section, and projection with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    await ctx.plugin(SystemPrompt)
    const fiber = await ctx.plugin(TowerService, TOWER_CONFIG)
    const agent = await agentWithSession(ctx, 'disposed-recovery')
    openTurn(agent.session)
    setMode(ctx, agent, { active: true, base: 'dev' })
    expect(ctx.get('tower')).toBeInstanceOf(TowerService)
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).toContain('tower:policy')
    expect(ctx.sessionProjections.snapshot(agent.session).values).toHaveProperty('tower')

    await fiber.dispose()
    expect(ctx.get('tower')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).not.toContain('tower:policy')
    expect(ctx.sessionProjections.snapshot(agent.session).values).not.toHaveProperty('tower')
    await boundary(ctx, agent, 'step-start')
    expect(agent.session.snapshotEvents().some(event => event.type === 'tower/mode')).toBe(false)
  })
})
