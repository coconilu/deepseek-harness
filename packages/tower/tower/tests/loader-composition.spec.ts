/** Real Loader composition wires the tower service, command, projection, prompt section, and provider facade. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as sessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as commandsPlugin from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as towerPlugin from '@deepseek-ai/dsh-tower'
import * as turnBoundaryFixture from './fixtures/turn-boundary.ts'
import * as stubProviderFixture from './fixtures/stub-provider.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('dsh-tower real Loader composition', () => {
  it('composes the service, command, projection, prompt section, and provider facade from cordis.yml', async () => {
    root = await mkdtemp(join(tmpdir(), 'tower-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8'))
    const ctx = context = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', systemPromptPlugin],
      ['@deepseek-ai/dsh-session-projection', sessionProjectionPlugin],
      ['@deepseek-ai/dsh-commands', commandsPlugin],
      ['@deepseek-ai/dsh-tower', towerPlugin],
      ['./turn-boundary.ts', turnBoundaryFixture],
      ['./stub-provider.ts', stubProviderFixture],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error('Unexpected Loader import: ' + specifier)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    expect(ctx.get('tower')).toBeInstanceOf(towerPlugin.TowerService)

    const session = Session.create(SessionId('tower-loader-agent'))
    const withCwd = Session.create(SessionId('tower-loader-agent'), undefined, { ...session.header, cwd: '/repo' })
    const agent = { id: withCwd.id, session: withCwd, options: {} } as unknown as Agent
    const signal = new AbortController().signal

    expect(ctx.commands.list(agent)).toEqual([
      { name: 'tower', description: 'Enter or leave tower mode, or show its status', input: { hint: 'on <base>|off|status' } },
    ])
    expect((await ctx.commands.execute(agent, '/tower status', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode off.' })
    expect((await ctx.commands.execute(agent, '/tower on main', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Tower mode on (base: main).' })

    const modeEvents = withCwd.snapshotEvents().filter(event => event.type === 'tower/mode')
    expect(modeEvents).toHaveLength(1)
    expect(modeEvents[0]?.data).toEqual({ active: true, base: 'main' })
    expect(ctx.sessionProjections.snapshot(withCwd).values.tower)
      .toEqual({ active: true, pending: false, base: 'main' })

    const assembled = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(assembled.sections.find(section => section.name === 'tower:policy')?.text)
      .toBe('Test tower policy.')

    // The facade reaches the fixture's stub through the default `local`
    // provider name under the default maxMissions bound.
    const mission = await ctx.tower.spawnMission(agent, { title: 'Loader mission', prompt: 'p', signal })
    expect(mission.id).toBe('m-1')
    expect(stubProviderFixture.provider.calls)
      .toEqual(['status:tower-loader-agent', 'spawnMission:tower-loader-agent:Loader mission'])
  })
})
