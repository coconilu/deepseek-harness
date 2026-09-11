/**
 * Tower capability Service Definition (`ctx.tower`): the logged tower mode
 * with its recorded base branch, a named-provider registry, and the
 * caller-authority-validating facade every tower operation crosses before
 * delegating to the provider selected by {@link Config.provider}. A tower
 * lets one lead session fan missions out to isolated git worktrees and merge
 * each back through a review gate; providers own the workspace store, git,
 * and mission child lifecycle.
 *
 * The `/tower` command flips the logged mode: `/tower on <base>` validates
 * the base through the selected provider before any event lands, then the
 * selection commits immediately between turns or awaits the next accepted
 * in-turn pre-step. The `tower` projection folds the log so resume and fork
 * restore the mode, and the `tower:policy` prompt section carries the
 * deployment's tower guidance while the mode is active.
 *
 * This package owns the Service Definition role of the capability seam; the
 * shipped provider (`@deepseek-ai/dsh-tower-local`) and the model-facing
 * consumer (`@deepseek-ai/dsh-tool-tower`) are separate packages.
 *
 * @module @deepseek-ai/dsh-tower
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {
  TowerDashboard,
  TowerFinding,
  TowerFindingRequest,
  TowerMergeResult,
  TowerMessage,
  TowerMessageRequest,
  TowerMissionId,
  TowerMissionView,
  TowerModeState,
  TowerProjection,
  TowerProvider,
  TowerReviewRequest,
  TowerReviewRound,
  TowerSpawnRequest,
  TowerTeardownRequest,
  TowerTeardownResult,
  TowerUnitState,
  TowerWorkspaceInfo,
  TowerService as TowerServiceContract,
} from './types.ts'

export type * from './types.ts'
export { TowerFindingId, TowerMissionId } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether tower mode is in force from this point on: log-only, non-surface,
     * whole-value replace. The last `tower/mode` wins; a log with none folds to
     * inactive through the projection unit's fold.
     * @param payload - the committed mode; `base` records the base branch of an activation and is absent on deactivation.
     */
    'tower/mode': { active: boolean; base?: string }
  }
}

/** Tower service plugin config: deployment-owned policy text and provider selection. */
export interface Config {
  /** Policy rendered as the `tower:policy` prompt section while tower mode is active. */
  section: string
  /** Registry name of the {@link TowerProvider} the facade delegates to (default `local`). */
  provider?: string
  /** Maximum unmerged missions per workspace, enforced in `spawnMission` (default 8). */
  maxMissions?: number
}

/** {@link Config} after schema defaults materialized. */
export interface ResolvedConfig {
  /** Policy rendered while tower mode is active. */
  readonly section: string
  /** Registry name of the provider the facade delegates to. */
  readonly provider: string
  /** Maximum unmerged missions per workspace. */
  readonly maxMissions: number
}

/** Zod validation for {@link Config}: blank strings, unknown keys, and non-positive bounds fail plugin load. */
// The cast bridges the defaulted fields, which Zod types as possibly-undefined
// inputs under exactOptionalPropertyTypes while the interface reads absent-or-value.
export const Config = zod.object({
  section: zod.string().min(1),
  provider: zod.string().min(1).default('local'),
  maxMissions: zod.number().int().positive().default(8),
}).strict() as unknown as ZodType<ResolvedConfig, Config>

/** One selected tower-mode target: an activation with its base, or deactivation. */
type TowerSelection = { readonly active: true; readonly base: string } | { readonly active: false }

const towerUnitStateSchema: ZodType<TowerUnitState> = zod.object({
  active: zod.boolean(),
  base: zod.string().nullable(),
  wanted: zod.boolean().nullable(),
  running: zod.object({
    wanted: zod.boolean(),
  }).strict().nullable(),
  activeAtLastHeader: zod.boolean().nullable(),
}).strict()

/** Wire payload schema of the `tower` projection. */
// The cast bridges the optional wire base, which Zod types as `string | undefined`
// under exactOptionalPropertyTypes while the wire type reads absent-or-string.
const towerProjectionSchema = zod.object({
  active: zod.boolean(),
  pending: zod.boolean(),
  base: zod.string().optional(),
}) as unknown as ZodType<TowerProjection>

/**
 * Parse one `/tower` command's input into the mode it selects: `off`, or
 * `on <base>` with the base token. `undefined` covers `status` and every
 * non-selecting (invalid) input, which the handler rejects.
 */
function parseTowerArgs(args: string): { readonly wanted: true; readonly base: string } | { readonly wanted: false } | undefined {
  if (args === 'off') return { wanted: false }
  const on = /^on\s+(\S+)$/.exec(args)
  if (on === null) return undefined
  const base = on[1]
  /* v8 ignore next -- the capture participates whenever the expression matches */
  if (base === undefined) return undefined
  return { wanted: true, base }
}

/** Whether two selections name the same target. */
function selectionsEqual(left: TowerSelection, right: TowerSelection): boolean {
  if (!left.active || !right.active) return left.active === right.active
  return left.base === right.base
}

/** Render a thrown value for one command's error text. */
function commandErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Projection of logged tower selections and committed mode. */
export const towerProjectionDefinition = {
  key: 'tower',
  stateVersion: 1,
  stateSchema: towerUnitStateSchema,
  init: () => ({ active: false, base: null, wanted: null, running: null, activeAtLastHeader: null }),
  apply: (state, event) => {
    if (event.type === 'command/run' && event.data.name === 'tower') {
      if (event.data.args === undefined) return state
      const parsed = parseTowerArgs(event.data.args.trim())
      if (parsed === undefined) return state
      return { ...state, running: { wanted: parsed.wanted } }
    }
    if (event.type === 'command/done' && state.running !== null) {
      const wanted = event.data.kind === 'success' && state.running.wanted !== state.active
        ? state.running.wanted
        : null
      return { ...state, wanted, running: null }
    }
    if (event.type === 'tower/mode') {
      return { ...state, active: event.data.active, base: event.data.base ?? null, wanted: null }
    }
    if (event.type === 'request/header') {
      return { ...state, activeAtLastHeader: state.active }
    }
    return state
  },
  wire: {
    viewSchema: towerProjectionSchema,
    view: (state) => {
      const wanted = state.running?.wanted ?? state.wanted
      return {
        active: state.active,
        pending: wanted !== null && wanted !== state.active,
        ...state.base !== null ? { base: state.base } : {},
      }
    },
  },
} satisfies ProjectionDefinition<'tower', TowerUnitState>

/**
 * `ctx.tower`: owns the logged tower mode and pending selections, the
 * provider registry, caller-authority validation, the `tower:policy` prompt
 * section, and the `/tower` command; every facade operation delegates to the
 * {@link Config.provider}-named provider once authority passes. Client
 * carriers expose the projection's cropped `{ active, pending, base? }` view.
 */
export class TowerService extends Service implements TowerServiceContract {
  static inject = ['systemPrompt', 'sessionProjections']
  static Config = Config

  /** Validated deployment-owned tower policy. */
  private readonly section: string
  /** The selected provider's registry name. */
  private readonly providerName: string
  /** Maximum unmerged missions per workspace. */
  private readonly maxMissions: number
  private readonly providers = new Map<string, TowerProvider>()

  /** Latest selection per session awaiting the next accepted in-turn pre-step. */
  private readonly pendingIntents = new WeakMap<Session, TowerSelection>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'tower')
    const resolved = Config.parse(config)
    this.section = resolved.section
    this.providerName = resolved.provider
    this.maxMissions = resolved.maxMissions
    ctx.on('agent/pre-step', (input, next) => this.onPreStep(input, next))

    ctx.systemPrompt.section({
      name: 'tower:policy',
      order: ctx.systemPrompt.getSectionOrder('TOWER_POLICY'),
      text: (context) => {
        if (context.agent === undefined) return ''
        const pending = this.pendingIntents.get(context.agent.session)
        if (pending !== undefined) return pending.active ? this.section : ''
        return this.mode(context.agent).active ? this.section : ''
      },
    })

    ctx.sessionProjections.register(towerProjectionDefinition)

    // The command child activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'tower',
        description: 'Enter or leave tower mode, or show its status',
        input: { hint: 'on <base>|off|status' },
        handler: invocation => this.handleCommand(invocation),
      })
    })
  }

  registerProvider(provider: TowerProvider): void {
    const name = provider.name
    void this.ctx.effect(function* (this: TowerService) {
      if (this.providers.has(name)) {
        throw new Error(`a tower provider named "${name}" is already registered`)
      }
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
      }
    }.bind(this), 'tower.registerProvider()')
  }

  mode(agent: Agent): TowerModeState {
    const state = this.towerState(agent.session)
    return { active: state.active, base: state.base }
  }

  async init(caller: Agent): Promise<TowerWorkspaceInfo> {
    this.assertLead(caller, 'init')
    return this.expectProvider().init(caller)
  }

  async status(caller: Agent): Promise<TowerDashboard> {
    await this.assertParticipant(caller, 'status')
    return this.expectProvider().status(caller)
  }

  async spawnMission(caller: Agent, request: TowerSpawnRequest): Promise<TowerMissionView> {
    this.assertLead(caller, 'spawnMission')
    const provider = this.expectProvider()
    const dashboard = await provider.status(caller)
    if (dashboard.missions.length >= this.maxMissions) {
      throw new Error(`tower.spawnMission refused: the workspace already has ${dashboard.missions.length} unmerged missions (maxMissions ${this.maxMissions})`)
    }
    return provider.spawnMission(caller, request)
  }

  async abortMission(caller: Agent, id: TowerMissionId): Promise<TowerMissionView> {
    this.assertLead(caller, 'abortMission')
    return this.expectProvider().abortMission(caller, id)
  }

  async sendMessage(caller: Agent, request: TowerMessageRequest): Promise<TowerMessage> {
    await this.assertParticipant(caller, 'sendMessage')
    return this.expectProvider().sendMessage(caller, request)
  }

  async inbox(caller: Agent, limit?: number): Promise<TowerMessage[]> {
    await this.assertParticipant(caller, 'inbox')
    return this.expectProvider().inbox(caller, limit)
  }

  async recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding> {
    await this.assertParticipant(caller, 'recordFinding')
    return this.expectProvider().recordFinding(caller, request)
  }

  async listFindings(caller: Agent): Promise<TowerFinding[]> {
    await this.assertParticipant(caller, 'listFindings')
    return this.expectProvider().listFindings(caller)
  }

  async recordReview(caller: Agent, request: TowerReviewRequest): Promise<TowerReviewRound> {
    this.assertLead(caller, 'recordReview')
    return this.expectProvider().recordReview(caller, request)
  }

  async merge(caller: Agent, id: TowerMissionId): Promise<TowerMergeResult> {
    this.assertLead(caller, 'merge')
    return this.expectProvider().merge(caller, id)
  }

  async teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult> {
    this.assertLead(caller, 'teardown')
    return this.expectProvider().teardown(caller, request)
  }

  async isMissionOwner(session: Session): Promise<boolean> {
    return this.expectProvider().isMissionOwner(session)
  }

  /** Execute one `/tower` invocation against the receiving agent's session. */
  private async handleCommand({ agent, rawInput }: CommandInvocation): Promise<CommandResult> {
    const input = rawInput.trim()
    if (input === 'status') {
      const mode = this.mode(agent)
      return {
        kind: 'success',
        text: !mode.active
          ? 'Tower mode off.'
          : mode.base === null
            ? 'Tower mode on.'
            : `Tower mode on (base: ${mode.base}).`,
      }
    }
    const parsed = parseTowerArgs(input)
    if (parsed === undefined) {
      return { kind: 'error', text: 'Usage: /tower on <base> | /tower off | /tower status.' }
    }
    if (!parsed.wanted) {
      switch (this.setMode(agent, { active: false })) {
        case 'committed':
          return { kind: 'success', text: 'Tower mode off.' }
        case 'queued':
          return { kind: 'success', text: 'Leaving tower mode (applies from the next step).' }
        case 'cancelled':
          return { kind: 'success', text: 'Tower mode entry cancelled.' }
        case 'noop':
          // Repeat the queued wording while an exit still awaits the next
          // accepted pre-step; only a truly inactive session reads idempotent.
          return this.mode(agent).active
            ? { kind: 'success', text: 'Leaving tower mode (applies from the next step).' }
            : { kind: 'success', text: 'Tower mode is already inactive.' }
      }
    }
    let provider: TowerProvider
    try {
      provider = this.expectProvider()
    } catch (error) {
      return { kind: 'error', text: commandErrorText(error) }
    }
    const cwd = agent.session.header.cwd
    if (cwd === undefined) {
      return { kind: 'error', text: 'Tower mode requires a session working directory; this session has no cwd.' }
    }
    // The base names a branch at the earliest resolvable point, before the
    // selection queues or lands: a typo fails here and logs no mode event.
    try {
      await provider.validateBase(cwd, parsed.base)
    } catch (error) {
      return { kind: 'error', text: commandErrorText(error) }
    }
    switch (this.setMode(agent, { active: true, base: parsed.base })) {
      case 'committed':
        return { kind: 'success', text: `Tower mode on (base: ${parsed.base}).` }
      case 'queued':
        return { kind: 'success', text: `Entering tower mode (base: ${parsed.base}; applies from the next step).` }
      case 'cancelled':
        return { kind: 'success', text: 'Tower mode change cancelled.' }
      case 'noop':
        return { kind: 'success', text: `Tower mode is already active (base: ${parsed.base}).` }
    }
  }

  /**
   * Select the tower-mode target. Between turns the selection appends
   * immediately because no in-turn pre-step will run until another prompt
   * starts a turn. During an open turn it remains pending until the next
   * accepted in-turn pre-step. Selecting the current or already-pending
   * target is a no-op.
   */
  private setMode(agent: Agent, selection: TowerSelection): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const target = this.pendingIntents.get(session) ?? this.loggedSelection(session)
    if (selectionsEqual(selection, target)) return 'noop'
    if (this.hasOpenTurn(session)) {
      this.pendingIntents.set(session, selection)
      return this.loggedMatches(session, selection) ? 'cancelled' : 'queued'
    }
    if (this.loggedMatches(session, selection)) {
      // Back to the logged target: the pending selection clears, nothing lands.
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    session.append('tower/mode', selection.active ? { active: true, base: selection.base } : { active: false })
    this.pendingIntents.delete(session)
    return 'committed'
  }

  /**
   * Flush one pending selection at an accepted in-turn pre-step. The pre-step
   * runs outside Session.append publication, so the log-only mode event lands
   * inside an open turn without re-entering the session; a failed append
   * stays pending for a later accepted pre-step and cannot block the step.
   */
  private async onPreStep(
    { agent, signal }: { agent: Agent; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    const pending = this.pendingIntents.get(agent.session)
    if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
    try {
      this.flushPending(agent.session, pending)
    } catch (error) {
      this.ctx.logger.warn('dsh-tower: failed to append selected tower mode at step start: %o', error)
    }
    return decision
  }

  /** Append one pending selection at an accepted in-turn pre-step. */
  private flushPending(session: Session, pending: TowerSelection): void {
    if (this.loggedMatches(session, pending)) {
      this.pendingIntents.delete(session)
      return
    }
    session.append('tower/mode', pending.active ? { active: true, base: pending.base } : { active: false })
    // Delete only after append succeeds so a later accepted in-turn pre-step
    // can retry a failed durable write.
    this.pendingIntents.delete(session)
  }

  /** The logged target as a selection: active with its base, or inactive. */
  private loggedSelection(session: Session): TowerSelection {
    const state = this.towerState(session)
    return state.active && state.base !== null ? { active: true, base: state.base } : { active: false }
  }

  /** Whether the logged target already equals the selection. */
  private loggedMatches(session: Session, selection: TowerSelection): boolean {
    return selectionsEqual(selection, this.loggedSelection(session))
  }

  private hasOpenTurn(session: Session): boolean {
    const state = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (state === undefined) throw new Error('tower requires the turnBoundary session projection')
    return state.openTurnStartSeq !== null
  }

  /** Read the required tower projection state or fail at the first service access. */
  private towerState(session: Session): TowerUnitState {
    const state = this.ctx.sessionProjections.stateOf(session, 'tower')
    if (state === undefined) throw new Error('tower requires the tower session projection')
    return state
  }

  /** Resolve the selected provider or fail loud. */
  private expectProvider(): TowerProvider {
    const provider = this.providers.get(this.providerName)
    if (provider === undefined) {
      throw new Error(`no tower provider registered for "${this.providerName}"`)
    }
    return provider
  }

  /** Assert the caller's session carries active tower mode (lead authority). */
  private assertLead(caller: Agent, operation: string): void {
    if (this.mode(caller).active) return
    throw new Error(`tower.${operation} is lead-only: the caller's session does not have tower mode active`)
  }

  /** Assert lead authority or a recorded mission ownership for the caller's session. */
  private async assertParticipant(caller: Agent, operation: string): Promise<void> {
    if (this.mode(caller).active) return
    if (await this.expectProvider().isMissionOwner(caller.session)) return
    throw new Error(`tower.${operation} requires an active tower mode or a recorded mission owner for the caller's session`)
  }
}

export default TowerService
