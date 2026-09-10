/**
 * Behavior suite for the local tower provider: the full composition booted
 * through the real Loader, real git repos, and real continuable mission
 * children. Store-corruption and minimal-topology edge cases construct the
 * provider directly against a hand-mounted context.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TowerFindingId, TowerMissionId } from '@deepseek-ai/dsh-tower/types'
import { LocalTowerProvider } from '../src/provider.ts'
import { TowerStore } from '../src/store.ts'
import {
  activateTowerMode,
  boot,
  bootedWorkspace,
  craftMission,
  fakeAgent,
  gitSync,
  looseAgent,
  makeGitRepo,
  makePlainDir,
  minimalContext,
  minimalProvider,
  runCleanups,
  seedWorkspace,
  spawn,
} from './harness.ts'

afterEach(runCleanups)

describe('workspace init', () => {
  it('creates the store layout, excludes .tower from git status, and logs the init activity', async () => {
    const repo = makeGitRepo()
    const { ctx, lead } = await bootedWorkspace(repo)
    const dashboard = await ctx.tower.status(lead)
    expect(dashboard).toMatchObject({ base: 'main', missions: [], findings: 0 })
    const stored = JSON.parse(await readFile(join(repo, '.tower', 'workspace.json'), 'utf8')) as { base: string; root: string; version: number }
    expect(stored.version).toBe(1)
    expect(stored.base).toBe('main')
    expect(normalize(stored.root)).toBe(normalize(repo))
    expect(existsSync(join(repo, '.tower', 'missions'))).toBe(true)
    expect(existsSync(join(repo, '.tower', 'reviews'))).toBe(true)
    expect(existsSync(join(repo, '.tower', 'worktrees'))).toBe(true)
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter(line => line.trim() === '/.tower/')).toHaveLength(1)
    expect(gitSync(repo, 'status', '--porcelain')).toBe('')
    expect(dashboard.activity.some(entry => entry.kind === 'init')).toBe(true)

    // A second init adopts without duplicating the exclude entry.
    const again = await ctx.tower.init(lead)
    expect(again).toMatchObject({ adopted: true, missions: 0 })
    const reread = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(reread.split('\n').filter(line => line.trim() === '/.tower/')).toHaveLength(1)
  }, 60_000)

  it('preserves custom exclude content and recreates a deleted exclude file', async () => {
    const customized = makeGitRepo()
    await mkdir(join(customized, '.git', 'info'), { recursive: true })
    await writeFile(join(customized, '.git', 'info', 'exclude'), '# mine\n')
    await bootedWorkspace(customized)
    const exclude = await readFile(join(customized, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('# mine')
    expect(exclude).toContain('/.tower/')

    const deleted = makeGitRepo()
    await rm(join(deleted, '.git', 'info', 'exclude'))
    await bootedWorkspace(deleted)
    const recreated = await readFile(join(deleted, '.git', 'info', 'exclude'), 'utf8')
    expect(recreated).toContain('/.tower/')
  }, 90_000)

  it('adopts an existing workspace and reconciles dead owners to interrupted', async () => {
    const repo = makeGitRepo()
    const first = await boot({ repo, towerLocalConfig: [] })
    activateTowerMode(first.lead)
    await first.ctx.tower.init(first.lead)
    const spawned = await spawn(first, 'one')
    const store = new TowerStore(repo)
    await craftMission(repo, { id: 'm-7', status: 'spawning' })
    await craftMission(repo, { id: 'm-8', owner: SessionId('foreign-live') })
    await craftMission(repo, { id: 'm-9', status: 'merged' })
    await first.ctx.fiber.dispose()

    const second = await boot({ repo, towerLocalConfig: [] })
    fakeAgent(second.ctx, 'foreign-live', { cwd: repo })
    activateTowerMode(second.lead)
    const info = await second.ctx.tower.init(second.lead)
    expect(info.adopted).toBe(true)
    expect(info.missions).toBe(3)
    expect((await store.readMission(spawned.id))?.status).toBe('interrupted')
    expect((await store.readMission(TowerMissionId('m-7')))?.status).toBe('interrupted')
    expect((await store.readMission(TowerMissionId('m-8')))?.status).toBe('active')
    expect((await store.readMission(TowerMissionId('m-9')))?.status).toBe('merged')
    expect((await store.readActivity()).some(entry => entry.kind === 'adopt')).toBe(true)

    // Re-adoption leaves already-interrupted missions untouched.
    const again = await second.ctx.tower.init(second.lead)
    expect(again.missions).toBe(3)
    expect((await store.readMission(spawned.id))?.status).toBe('interrupted')
  }, 90_000)

  it('refuses adoption when the recorded base does not match the session base', async () => {
    const repo = makeGitRepo()
    const { ctx, lead } = await bootedWorkspace(repo)
    lead.session.append('tower/mode', { active: true, base: 'other' })
    await expect(ctx.tower.init(lead)).rejects.toThrow(/does not match the session's tower base/)
  }, 60_000)

  it('refuses init without active tower mode or a recorded base', async () => {
    const repo = makeGitRepo()
    const inactive = await minimalContext({ active: false, base: null })
    const inactiveProvider = new LocalTowerProvider(inactive, { childProvider: 'spawn', activityTail: 50 })
    await expect(inactiveProvider.init(looseAgent(inactive, 'lead', { cwd: repo })))
      .rejects.toThrow(/tower mode is not active/)

    const baseless = await minimalContext({ active: true, base: null })
    const baselessProvider = new LocalTowerProvider(baseless, { childProvider: 'spawn', activityTail: 50 })
    await expect(baselessProvider.init(looseAgent(baseless, 'lead', { cwd: repo })))
      .rejects.toThrow(/tower mode is not active/)
  }, 60_000)

  it('refuses init and operations without a session cwd', async () => {
    const repo = makeGitRepo()
    const ctx = await minimalContext()
    const provider = new LocalTowerProvider(ctx, { childProvider: 'spawn', activityTail: 50 })
    await expect(provider.init(looseAgent(ctx, 'cwdfree'))).rejects.toThrow(/no working directory/)
    await seedWorkspace(repo)
    await expect(provider.status(looseAgent(ctx, 'cwdfree-2'))).rejects.toThrow(/no working directory/)
  }, 60_000)
})

describe('store integrity', () => {
  it('fails loud on corrupt mission documents', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    await writeFile(join(store.missionsDir, 'm-1.json'), 'not json{')
    await expect(provider.status(caller)).rejects.toThrow(/corrupt store record/)
    await rm(join(store.missionsDir, 'm-1.json'))
    await writeFile(join(store.missionsDir, 'm-2.json'), '{"unexpected": true}')
    await expect(provider.status(caller)).rejects.toThrow(/corrupt store record/)
  }, 60_000)

  it('fails loud on a corrupt journal line, attributing the position', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    await store.appendFinding({
      id: TowerFindingId('f-1'), title: 'ok', body: 'fine', author: 'lead', time: new Date().toISOString(),
    })
    const { appendFile } = await import('node:fs/promises')
    await appendFile(store.findingsPath, 'garbage\n')
    await expect(provider.listFindings(caller)).rejects.toThrow(/line 2/)
  }, 60_000)

  it('propagates filesystem errors that are not absence', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    await mkdir(join(store.missionsDir, 'm-1.json'))
    await expect(provider.status(caller)).rejects.toThrow()
    await rm(join(store.missionsDir, 'm-1.json'), { recursive: true })
    await mkdir(store.findingsPath)
    await expect(provider.listFindings(caller)).rejects.toThrow()
  }, 60_000)

  it('propagates a missions path that is not a directory', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = new TowerStore(repo)
    await store.writeWorkspace({ version: 1, base: 'main', root: repo, createdAt: new Date().toISOString() })
    await writeFile(store.missionsDir, 'a file, not a directory')
    await expect(provider.status(caller)).rejects.toThrow()
  }, 60_000)

  it('skips stray files in the missions directory and allocates monotonic ids', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    await craftMission(repo, { id: 'm-1' })
    await craftMission(repo, { id: 'm-3' })
    await writeFile(join(store.missionsDir, 'notes.txt'), 'not a mission')
    expect(await store.nextMissionId()).toBe('m-4')
    expect((await provider.status(caller)).missions).toHaveLength(2)

    await store.appendFinding({
      id: TowerFindingId('manual'), title: 'foreign', body: 'pre-existing', author: 'lead', time: new Date().toISOString(),
    })
    expect(await store.nextFindingId()).toBe('f-1')
  }, 60_000)

  it('reads false from an empty .tower directory and no workspace record', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    await mkdir(join(repo, '.tower'))
    await expect(provider.status(caller)).rejects.toThrow(/no tower workspace record/)
    expect(await provider.isMissionOwner(caller.session)).toBe(false)
  }, 60_000)

  it('reads false outside any tower workspace', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    await expect(provider.status(caller)).rejects.toThrow(/no tower workspace reachable/)
    expect(await provider.isMissionOwner(caller.session)).toBe(false)
  }, 60_000)
})

describe('validateBase', () => {
  it('accepts a local branch and rejects tags, remote refs, and non-repositories', async () => {
    const repo = makeGitRepo()
    const ctx = await minimalContext()
    const provider = new LocalTowerProvider(ctx, { childProvider: 'spawn', activityTail: 50 })
    await expect(provider.validateBase(repo, 'main')).resolves.toBeUndefined()
    gitSync(repo, 'tag', 'v1')
    await expect(provider.validateBase(repo, 'v1')).rejects.toThrow(/not a local branch/)
    gitSync(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    await expect(provider.validateBase(repo, 'origin/main')).rejects.toThrow(/not a local branch/)
    await expect(provider.validateBase(repo, 'nope')).rejects.toThrow(/not a local branch/)
    await expect(provider.validateBase(makePlainDir(), 'main')).rejects.toThrow(/not inside a git work tree/)
  }, 60_000)
})
