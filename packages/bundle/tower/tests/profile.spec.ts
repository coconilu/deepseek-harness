/**
 * The tower profile bundle's composition contract: the shipped patch document
 * mounts the tower Service Definition, its local provider, and the tower tool
 * consumer as three rows after dsh-base, and the composed tree registers the
 * /tower command, the ten tower_* tools, and the tower:policy prompt section.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as commandsPlugin from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TowerService from '@deepseek-ai/dsh-tower'
import * as ToolTower from '@deepseek-ai/dsh-tool-tower'
import * as TowerLocal from '@deepseek-ai/dsh-tower-local'
import * as turnBoundaryFixture from './fixtures/turn-boundary.ts'

/** The model-facing policy the bundle ships as the tower Service Definition's section. */
const SECTION_TEXT = 'Tower mode is active: you are the lead. Use the tower_* tools to fan work out instead of doing everything in one session. Call tower_init once to create or adopt the tower at the calling session\'s git root; it records the base branch and the .tower/ coordination store. Split the work into missions with tower_spawn: each mission runs in its own git worktree branched from the base, driven by a child agent, so the mission prompt must be self-contained. Monitor with tower_status, exchange context with tower_send and tower_inbox, and record shared discoveries with tower_finding. A mission lands only through the review gate: record a review round with tower_review, and call tower_merge only after an approve verdict covers the mission\'s current commit. Use tower_mission to abort a mission; tower_teardown ends the workspace\'s active work. tower_merge and tower_teardown ask the user for approval first: any other outcome means nothing happened, so never retry without the user\'s explicit approval.'

/** The ten tool names the tool consumer registers. */
const TOOL_NAMES = [
  'tower_init', 'tower_status', 'tower_spawn', 'tower_mission', 'tower_send',
  'tower_inbox', 'tower_finding', 'tower_review', 'tower_merge', 'tower_teardown',
].sort()

interface PatchRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
  insert?: PatchRow[]
}

interface BundleManifest {
  private?: boolean
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

const cleanups: (() => Promise<void>)[] = []

/** Track one teardown step run by the suite's afterEach. */
function trackCleanup(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup)
}

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'tower profile test cleanup failed')
})

/** One throwaway git repo on branch `main` with one commit. */
function makeGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-tower-profile-repo-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'tower-profile@example.invalid')
  git('config', 'user.name', 'Tower Profile Test')
  writeFileSync(join(repo, 'README.md'), '# tower profile test\n')
  git('add', 'README.md')
  git('commit', '-m', 'initial')
  trackCleanup(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return repo
}

/**
 * The bundle's parsed patch rows, read through the manifest's dsh.bundle.patch
 * pointer, after pinning the manifest shape every bundle keeps.
 */
function bundlePatches(): PatchRow[] {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as BundleManifest
  expect(manifest.private).toBeUndefined()
  expect(manifest.publishConfig?.access).toBe('public')
  expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  expect(manifest.dependencies).toMatchObject({
    '@deepseek-ai/dsh-tool-tower': 'workspace:^',
    '@deepseek-ai/dsh-tower': 'workspace:^',
    '@deepseek-ai/dsh-tower-local': 'workspace:^',
  })
  const parsed = yaml.load(
    readFileSync(join(packageRoot, manifest.dsh!.bundle!.patch!), 'utf8'),
    { schema: entryListSchema },
  )
  expect(Array.isArray(parsed)).toBe(true)
  return parsed as PatchRow[]
}

describe('tower profile bundle', () => {
  it('ships one insert patch carrying the three tower rows and their profile config', () => {
    const patches = bundlePatches()
    expect(patches).toHaveLength(1)
    const rows = patches[0]!.insert ?? []
    expect(rows.find(row => row.id === 'tower')).toMatchObject({
      name: '@deepseek-ai/dsh-tower',
      config: {
        section: SECTION_TEXT,
        provider: 'local',
        maxMissions: 8,
      },
    })
    expect(rows.find(row => row.id === 'tower-local')).toMatchObject({
      name: '@deepseek-ai/dsh-tower-local',
      config: { childProvider: 'spawn' },
    })
    expect(rows.find(row => row.id === 'tool-tower')).toMatchObject({
      name: '@deepseek-ai/dsh-tool-tower',
    })
  })

  it('composes the three plugins through the Loader and registers the command, tools, and policy section', async () => {
    const patches = bundlePatches()
    const home = mkdtempSync(join(tmpdir(), 'dsh-tower-profile-boot-'))
    trackCleanup(async () => {
      await rm(home, { recursive: true, force: true })
    })
    const repo = makeGitRepo()
    const configPath = join(home, 'cordis.yml')
    writeFileSync(configPath, `${[
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: './fixtures/turn-boundary.ts'",
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-subagent'",
      "- name: '@deepseek-ai/dsh-subprocess-local'",
    ].join('\n')}\n`)

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(home).href + '/'
    trackCleanup(async () => {
      await ctx.fiber.dispose()
    })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['./fixtures/turn-boundary.ts', turnBoundaryFixture],
      ['@deepseek-ai/dsh-commands', commandsPlugin],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-subagent', SubagentRuntime],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-tower', TowerService],
      ['@deepseek-ai/dsh-tower-local', TowerLocal],
      ['@deepseek-ai/dsh-tool-tower', ToolTower],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href, patches },
    })
    await ctx.loader.await()

    // All three patch rows composed into one tree.
    expect(ctx.get('tower')).toBeInstanceOf(TowerService)

    // The local provider registered under the configured name: /tower on
    // <base> validates the base through it (the git engine over the real
    // subprocess runtime) before any mode event lands.
    const plainSession = Session.create(SessionId('tower-profile-lead'))
    const leadSession = Session.create(SessionId('tower-profile-lead'), undefined, {
      ...plainSession.header,
      cwd: repo,
    })
    const agent = { id: leadSession.id, session: leadSession, options: {} } as unknown as Agent
    const signal = new AbortController().signal

    expect(ctx.commands.list(agent)).toEqual([
      {
        name: 'tower',
        description: 'Enter or leave tower mode, or show its status',
        input: { hint: 'on <base>|off|status' },
      },
    ])
    expect((await ctx.commands.execute(agent, '/tower status', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode off.' })
    expect((await ctx.commands.execute(agent, '/tower on main', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode on (base: main).' })

    const modeEvents = leadSession.snapshotEvents().filter(event => event.type === 'tower/mode')
    expect(modeEvents).toHaveLength(1)
    expect(modeEvents[0]!.data).toEqual({ active: true, base: 'main' })
    expect(ctx.sessionProjections.snapshot(leadSession).values.tower)
      .toEqual({ active: true, pending: false, base: 'main' })

    // The ten model-facing tools registered with the composed tree.
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('tower_')).sort())
      .toEqual(TOOL_NAMES)

    // The configured policy section renders verbatim while tower mode is active.
    const assembled = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(assembled.sections.find(section => section.name === 'tower:policy')?.text)
      .toBe(SECTION_TEXT)
  })
})
