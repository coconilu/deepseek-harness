/** Real Loader composition: cordis.yml boots the tower facade, stub provider, and the tower tools. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TowerService from '@deepseek-ai/dsh-tower'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as toolTower from '../src/index.ts'
import * as stubFixture from './fixtures/stub-tower.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A caller registered with the composed AgentRegistry, carrying a real cwd session. */
function agent(ctx: Context, id: string, mode: boolean): Agent {
  const scope = ctx.plugin(() => {})
  const session = Session.create(SessionId(id))
  const carrier = Session.create(SessionId(id), undefined, { ...session.header, cwd: '/repo' })
  if (mode) carrier.append('tower/mode', { active: true, base: 'main' })
  const value: Agent = {
    id: SessionId(id), options: {}, session: carrier, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

/**
 * Boot a cordis.yml carrying the given tool-tower config lines through the
 * real Loader with module stubs standing in for package resolution.
 * @param toolLines - YAML lines nested under the tool plugin's `config:` key.
 */
async function boot(toolLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-tower-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-tower'",
    '  config:',
    "    section: 'Test tower policy.'",
    "- name: './stub-tower.ts'",
    "- name: '@deepseek-ai/dsh-tool-tower'",
    ...toolLines.length > 0 ? ['  config:', ...toolLines] : [],
    '',
  ].join('\n'))

  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-tower', TowerService],
    ['./stub-tower.ts', stubFixture],
    ['@deepseek-ai/dsh-tool-tower', toolTower],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

const TOOL_NAMES = [
  'tower_init', 'tower_status', 'tower_spawn', 'tower_mission', 'tower_send',
  'tower_inbox', 'tower_finding', 'tower_review', 'tower_merge', 'tower_teardown',
].sort()

describe('dsh-tool-tower real Loader composition', () => {
  it('composes the ten tools over the facade from cordis.yml and serves a lead end to end', async () => {
    const ctx = await boot(['    maxInbox: 3'])
    expect(ctx.get('tower')).toBeInstanceOf(TowerService)
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('tower_')).sort())
      .toEqual(TOOL_NAMES)

    const lead = agent(ctx, 'tower-loader-lead', true)
    const init = await ctx.tools.execute({
      callId: ToolCallId('loader-init'),
      name: 'tower_init',
      arguments: {},
      signal: new AbortController().signal,
      agent: lead,
    })
    expect(init.isError).toBe(false)
    if (!init.isError) expect(init.value).toMatchObject({ workspace: { base: 'main', root: '/repo' }, adopted: false })
    expect(stubFixture.provider.calls).toEqual([`init:${String(lead.id)}`])

    const inbox = await ctx.tools.execute({
      callId: ToolCallId('loader-inbox'),
      name: 'tower_inbox',
      arguments: {},
      signal: new AbortController().signal,
      agent: lead,
    })
    expect(inbox.isError).toBe(false)
    expect(stubFixture.provider.calls.at(-1)).toBe(`inbox:${String(lead.id)}:3`)
  })

  it('serves a recorded mission owner through the composed registry without tower mode', async () => {
    const ctx = await boot([])
    const owner = agent(ctx, 'tower-loader-owner', false)
    stubFixture.provider.owners.add('tower-loader-owner')
    const status = await ctx.tools.execute({
      callId: ToolCallId('loader-owner-status'),
      name: 'tower_status',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    expect(status.isError).toBe(false)
  })

  it('fails plugin load when maxInbox is out of range', async () => {
    await expect(boot(['    maxInbox: 0'])).rejects.toThrow(/maxInbox/u)
  })
})
