/**
 * Shared harness for the tower-local suites: synchronous test-side git
 * helpers, throwaway git repos, the full composition booted through the real
 * Loader from a generated cordis.yml, structurally complete fake agents for
 * authority edge cases, and temp-root cleanup.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TowerService from '@deepseek-ai/dsh-tower'
import * as TowerLocal from '@deepseek-ai/dsh-tower-local'
import { TowerMissionId } from '@deepseek-ai/dsh-tower/types'
import type { TowerMission } from '@deepseek-ai/dsh-tower/types'
import { LocalTowerProvider } from '../src/provider.ts'
import { TowerStore } from '../src/store.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const cleanups: Array<() => Promise<void>> = []

/** Register one teardown step run by the suite's afterEach. */
export function trackCleanup(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup)
}

/** Run every registered teardown step, aggregating failures. */
export async function runCleanups(): Promise<void> {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'tower-local test cleanup failed')
}

/** Run git synchronously on the test side and return trimmed stdout. */
export function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** Create one throwaway repo on branch `main` with one commit; cleanup is tracked. */
export function makeGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-tower-local-repo-'))
  gitSync(repo, 'init', '-b', 'main')
  gitSync(repo, 'config', 'user.email', 'tower@example.invalid')
  gitSync(repo, 'config', 'user.name', 'Tower Test')
  writeFileSync(join(repo, 'README.md'), '# test repo\n')
  gitSync(repo, 'add', 'README.md')
  gitSync(repo, 'commit', '-m', 'initial')
  trackCleanup(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return repo
}

/** Write and commit one file inside a checkout; returns the new tip. */
export function commitFile(cwd: string, name: string, content: string): string {
  writeFileSync(join(cwd, name), content)
  gitSync(cwd, 'add', name)
  gitSync(cwd, 'commit', '-m', `add ${name}`)
  return gitSync(cwd, 'rev-parse', 'HEAD')
}

/** Options for one Loader-composition boot. */
export interface BootOptions {
  /** The git repo the lead session works in. */
  readonly repo: string
  /**
   * YAML lines nested under the tower-local entry's `config:` key. An empty
   * list emits `config: {}` (schema defaults); `undefined` omits the plugin.
   */
  readonly towerLocalConfig?: readonly string[]
  /** Mock adapter script size: one entry per model call the test expects. */
  readonly scriptSize?: number
  /** Leading script entries that hang: hanging turns keep mission children live. */
  readonly hangFirst?: number
  /** Custom model adapter; supersedes `scriptSize`/`hangFirst` when provided. */
  readonly adapter?: LlmAdapter
}

/** One booted composition: context, lead agent, and mock adapter. */
export interface Booted {
  readonly ctx: Context
  readonly lead: Agent
  readonly adapter: LlmAdapter
}

const PLUGIN_MODULES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ['@deepseek-ai/dsh-subagent', SubagentRuntime],
  ['@deepseek-ai/dsh-subagent-spawn-in-process', SubagentSpawn],
  ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
  ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
  ['@deepseek-ai/dsh-tower', TowerService],
  ['@deepseek-ai/dsh-tower-local', TowerLocal],
])

/** Boot the full tower stack through the real Loader from a generated cordis.yml. */
export async function boot(options: BootOptions): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tower-local-boot-'))
  const persist = join(home, 'persistence').replaceAll('\\', '/')
  const entries = [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    '  config: {}',
    "- name: '@deepseek-ai/dsh-tools'",
    '  config: {}',
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-subagent'",
    "- name: '@deepseek-ai/dsh-subagent-spawn-in-process'",
    '  config:',
    '    providerName: spawn',
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: "${persist}"`,
    "- name: '@deepseek-ai/dsh-tower'",
    '  config:',
    '    section: test tower policy',
  ]
  if (options.towerLocalConfig !== undefined) {
    entries.push("- name: '@deepseek-ai/dsh-tower-local'")
    if (options.towerLocalConfig.length === 0) {
      entries.push('  config: {}')
    } else {
      entries.push('  config:', ...options.towerLocalConfig)
    }
  }
  const configPath = join(home, 'cordis.yml')
  writeFileSync(configPath, `${entries.join('\n')}\n`)

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!PLUGIN_MODULES.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return PLUGIN_MODULES.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const scriptSize = options.scriptSize ?? 60
  const hangFirst = options.hangFirst ?? 0
  const adapter = options.adapter ?? new MockAdapter(Array.from({ length: scriptSize }, (_, index) =>
    index < hangFirst ? 'hang' as const : textResponse('mock reply')))
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' }, { cwd: options.repo })
  trackCleanup(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return { ctx, lead, adapter }
}

/** Activate tower mode on the lead's session through the durable log event. */
export function activateTowerMode(lead: Agent, base = 'main'): void {
  lead.session.append('tower/mode', { active: true, base })
}

/** Header facts a fake session carries. */
export interface FakeAgentHeader {
  readonly cwd?: string
  readonly parentSession?: SessionId
}

/** Build one structurally complete Agent without loop wiring or registration. */
export function looseAgent(ctx: Context, id: string, header: FakeAgentHeader = {}): Agent {
  const scope = ctx.plugin(() => {})
  const sessionId = SessionId(id)
  const sessionHeader: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: Date.now(),
    isSeeded: false,
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
  }
  const session = Session.create(sessionId, undefined, sessionHeader)
  return {
    id: sessionId,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Build and register one structurally complete Agent without loop wiring. */
export function fakeAgent(ctx: Context, id: string, header: FakeAgentHeader = {}): Agent {
  const value = looseAgent(ctx, id, header)
  ctx.agents.register(value)
  return value
}

/** Create one throwaway plain directory (not a git repo); cleanup is tracked. */
export function makePlainDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tower-local-plain-'))
  trackCleanup(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return dir
}

/** Deliveries and interrupts captured against a stubbed subagents service. */
export interface SubagentCapture {
  readonly sent: { readonly sender: Agent; readonly target: SessionId; readonly text: string }[]
  readonly interrupted: SessionId[]
  readonly drained: SessionId[][]
}

/**
 * Mount a stub subagents service recording the provider's seam calls; the
 * configured errors make the matching seam operation reject.
 */
export function stubSubagents(ctx: Context, errors: { readonly start?: Error; readonly send?: Error } = {}): SubagentCapture {
  type Service = Context['subagents']
  const capture: SubagentCapture = { sent: [], interrupted: [], drained: [] }
  ctx.provide('subagents', {
    startContinuable: async () => {
      if (errors.start !== undefined) throw errors.start
      return { childId: SessionId('stub-child') }
    },
    interrupt: (target: SessionId) => {
      capture.interrupted.push(target)
    },
    sendMessage: async (sender: Agent, target: SessionId, content: readonly { type: string; text?: string }[]) => {
      if (errors.send !== undefined) throw errors.send
      capture.sent.push({ sender, target, text: content.map(block => block.text ?? '').join('') })
      return undefined
    },
    drainContinuableChildren: async (_parent: Agent, ids: readonly SessionId[]) => {
      capture.drained.push([...ids])
    },
  } as unknown as Service)
  return capture
}

/** Mount a stub agents registry: `live` ids resolve to loose agents; nothing is owned. */
export function stubAgents(ctx: Context, live: readonly string[]): void {
  ctx.provide('agents', {
    get: (id: SessionId) => live.includes(id) ? looseAgent(ctx, id) : undefined,
    isOwnedBy: () => false,
  } as unknown as Context['agents'])
}

/** The live child agent owning one spawned mission. */
export function liveChild(ctx: Context, owner: SessionId | undefined): Agent {
  if (owner === undefined) throw new Error('mission has no owner')
  const child = ctx.agents.get(owner)
  if (child === undefined) throw new Error(`child ${owner} is not live`)
  return child
}

/** Poll one live session's log until a user message carries `text`. */
export async function waitForUserText(session: Session, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(session.snapshotEvents().some(event =>
      event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text.includes(text)),
    )).toBe(true)
  }, { timeout: 15_000, interval: 50 })
}

/** Boot a minimal context: real subprocess plus a tower-mode stub, no agents service. */
export async function minimalContext(mode: { active: boolean; base: string | null } = { active: true, base: 'main' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('tower', {
    mode: () => mode,
    registerProvider: () => {},
  })
  trackCleanup(async () => {
    await ctx.fiber.dispose()
  })
  return ctx
}

/** Direct provider over a minimal context, with a lead-shaped caller rooted at `repo`. */
export async function minimalProvider(repo: string): Promise<{ ctx: Context; provider: LocalTowerProvider; caller: Agent }> {
  const ctx = await minimalContext()
  const provider = new LocalTowerProvider(ctx, { childProvider: 'spawn', activityTail: 50 })
  return { ctx, provider, caller: looseAgent(ctx, 'probe', { cwd: repo }) }
}

/** Direct provider whose subprocess seam cannot resolve the git executable. */
export async function noGitProvider(repo: string): Promise<{ provider: LocalTowerProvider; caller: Agent }> {
  const ctx = new Context()
  ctx.provide('tower', {
    mode: () => ({ active: true, base: 'main' }),
    registerProvider: () => {},
  })
  ctx.provide('subprocess', {
    resolveExecutable: () => Promise.reject(new Error('git is not installed')),
  } as unknown as Context['subprocess'])
  trackCleanup(async () => {
    await ctx.fiber.dispose()
  })
  const provider = new LocalTowerProvider(ctx, { childProvider: 'spawn', activityTail: 50 })
  return { provider, caller: looseAgent(ctx, 'probe', { cwd: repo }) }
}

/** Create a store with layout and workspace record but no missions. */
export async function seedWorkspace(repo: string, base = 'main'): Promise<TowerStore> {
  const store = new TowerStore(repo)
  await store.ensureLayout()
  await store.writeWorkspace({ version: 1, base, root: repo, createdAt: new Date().toISOString() })
  return store
}

/** Hand-write one mission record into a repo's store. */
export async function craftMission(repo: string, overrides: Omit<Partial<TowerMission>, 'id'> & { id: string }): Promise<TowerMission> {
  const store = new TowerStore(repo)
  const time = new Date().toISOString()
  const mission: TowerMission = {
    title: `crafted ${overrides.id}`,
    prompt: 'crafted',
    base: 'main',
    branch: `tower/${overrides.id}`,
    worktree: join(store.worktreesDir, overrides.id),
    status: 'active',
    createdAt: time,
    updatedAt: time,
    ...overrides,
    id: TowerMissionId(overrides.id),
  }
  await store.writeMission(mission)
  return mission
}

/** Fresh cancellation for one facade call. */
export function testSignal(): AbortSignal {
  return new AbortController().signal
}

/** One scripted response that may hold the model call open until `gate` resolves. */
export interface GatedEntry {
  readonly chunks: StreamChunk[]
  readonly gate?: Promise<undefined>
}

/** Adapter whose gated entries hold a model call open until the test releases them. */
export class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private index = 0

  constructor(private readonly script: readonly GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script[this.index]
    this.index += 1
    if (entry === undefined) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate !== undefined) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** Extra boot tuning for {@link bootedWorkspace}: hang counts or a custom adapter. */
export interface BootedWorkspaceOptions {
  readonly hangFirst?: number
  readonly adapter?: LlmAdapter
}

/** Boot, activate tower mode on base `main`, and initialize the workspace. */
export async function bootedWorkspace(
  repo: string,
  towerLocalConfig: readonly string[] = [],
  options: BootedWorkspaceOptions = {},
): Promise<Booted> {
  const booted = await boot({ repo, towerLocalConfig, ...options })
  activateTowerMode(booted.lead)
  await booted.ctx.tower.init(booted.lead)
  return booted
}

/** Spawn one mission through the facade. */
export function spawn(booted: Booted, title: string, prompt = `task: ${title}`) {
  return booted.ctx.tower.spawnMission(booted.lead, { title, prompt, signal: testSignal() })
}
