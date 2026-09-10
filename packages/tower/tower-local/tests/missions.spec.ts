/**
 * Mission lifecycle suite: spawn provisioning and rollback, abort, review
 * rounds, and the merge gate. The booted composition drives real children
 * and git flows; minimal providers cover the refusal branches.
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TowerMissionId } from '@deepseek-ai/dsh-tower/types'
import { TowerStore } from '../src/store.ts'
import {
  bootedWorkspace,
  commitFile,
  craftMission,
  gitSync,
  liveChild,
  makeGitRepo,
  minimalProvider,
  runCleanups,
  seedWorkspace,
  spawn,
  stubSubagents,
  testSignal,
  waitForUserText,
} from './harness.ts'

afterEach(runCleanups)

describe('spawnMission', () => {
  it('provisions a worktree, starts the mission child, and records the spawn', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo, [], { hangFirst: 1 })
    const view = await spawn(booted, 'one')
    expect(view.id).toBe('m-1')
    expect(view.status).toBe('active')
    expect(view.ownerLive).toBe(true)
    expect(view.tipMatchesReview).toBe(false)
    expect(gitSync(repo, 'branch', '--list', 'tower/m-1', '--format=%(refname:short)')).toBe('tower/m-1')
    expect(existsSync(view.worktree)).toBe(true)
    const child = liveChild(booted.ctx, view.owner)
    await waitForUserText(child.session, 'task: one')
    const store = new TowerStore(repo)
    expect((await store.readMission(view.id))?.owner).toBe(child.id)
    const activity = await store.readActivity()
    expect(activity.some(entry => entry.kind === 'spawn' && entry.mission === view.id)).toBe(true)
  }, 90_000)

  it('refuses an already-aborted signal before allocating anything', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    const controller = new AbortController()
    controller.abort()
    await expect(provider.spawnMission(caller, { title: 'x', prompt: 'x', signal: controller.signal }))
      .rejects.toThrow(/abort/i)
    expect(await store.listMissions()).toEqual([])
  }, 60_000)

  it('records the mission failed when worktree provisioning fails', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo, 'ghost')
    await expect(provider.spawnMission(caller, { title: 'x', prompt: 'x', signal: testSignal() }))
      .rejects.toThrow(/worktree add/)
    const mission = (await store.listMissions()).at(0)
    expect(mission?.status).toBe('failed')
    const activity = await store.readActivity()
    expect(activity.some(entry => entry.kind === 'spawn' && entry.detail.includes('worktree provisioning failed'))).toBe(true)
  }, 60_000)

  it('rolls the worktree and branch back when the mission child fails to start', async () => {
    const repo = makeGitRepo()
    const { ctx, provider, caller } = await minimalProvider(repo)
    stubSubagents(ctx, { start: new Error('child boom') })
    const store = await seedWorkspace(repo)
    await expect(provider.spawnMission(caller, { title: 'x', prompt: 'x', signal: testSignal() }))
      .rejects.toThrow(/child boom/)
    const mission = (await store.listMissions()).at(0)
    expect(mission?.status).toBe('failed')
    expect(existsSync(mission?.worktree ?? '')).toBe(false)
    expect(gitSync(repo, 'branch', '--list', 'tower/m-1')).toBe('')
    const activity = await store.readActivity()
    expect(activity.some(entry => entry.detail.includes('mission child failed to start: child boom'))).toBe(true)
  }, 60_000)
})

describe('abortMission', () => {
  it('marks the mission aborted and interrupts its live child', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo, [], { hangFirst: 1 })
    const view = await spawn(booted, 'one')
    const aborted = await booted.ctx.tower.abortMission(booted.lead, view.id)
    expect(aborted.status).toBe('aborted')
    const store = new TowerStore(repo)
    const activity = await store.readActivity()
    expect(activity.some(entry => entry.kind === 'abort' && entry.mission === view.id)).toBe(true)
  }, 90_000)

  it('refuses unknown and non-abortable missions', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    await seedWorkspace(repo)
    await expect(provider.abortMission(caller, TowerMissionId('m-99'))).rejects.toThrow(/unknown mission/)
    const failed = await craftMission(repo, { id: 'm-1', status: 'failed' })
    await expect(provider.abortMission(caller, failed.id)).rejects.toThrow(/only an active or interrupted mission can be aborted/)
  }, 60_000)

  it('skips the interrupt for an ownerless record and still sends it for a dead owner', async () => {
    const repo = makeGitRepo()
    const { ctx, provider, caller } = await minimalProvider(repo)
    const capture = stubSubagents(ctx)
    await seedWorkspace(repo)
    const ownerless = await craftMission(repo, { id: 'm-1' })
    expect((await provider.abortMission(caller, ownerless.id)).status).toBe('aborted')
    expect(capture.interrupted).toEqual([])
    const dead = await craftMission(repo, { id: 'm-2', status: 'interrupted', owner: SessionId('ghost') })
    expect((await provider.abortMission(caller, dead.id)).status).toBe('aborted')
    expect(capture.interrupted).toEqual([SessionId('ghost')])
  }, 60_000)
})

describe('recordReview', () => {
  it('stamps the branch tip per round and moves the mission status', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo)
    const view = await spawn(booted, 'one')
    const firstTip = commitFile(view.worktree, 'feature.txt', 'v1\n')
    const approved = await booted.ctx.tower.recordReview(booted.lead, { mission: view.id, verdict: 'approve', summary: 'looks good' })
    expect(approved).toMatchObject({ round: 1, verdict: 'approve', commit: firstTip, reviewer: 'lead' })
    let dashboard = await booted.ctx.tower.status(booted.lead)
    expect(dashboard.missions.at(0)).toMatchObject({ status: 'approved', tipMatchesReview: true })
    commitFile(view.worktree, 'feature.txt', 'v2\n')
    dashboard = await booted.ctx.tower.status(booted.lead)
    expect(dashboard.missions.at(0)?.tipMatchesReview).toBe(false)
    const rejected = await booted.ctx.tower.recordReview(booted.lead, { mission: view.id, verdict: 'reject', summary: 'rework' })
    expect(rejected).toMatchObject({ round: 2, verdict: 'reject' })
    expect((await booted.ctx.tower.status(booted.lead)).missions.at(0)?.status).toBe('active')
    const activity = await new TowerStore(repo).readActivity()
    expect(activity.filter(entry => entry.kind === 'review')).toHaveLength(2)
  }, 90_000)

  it('refuses reviews on terminal missions and attributes a mission reviewer', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    await seedWorkspace(repo)
    const failed = await craftMission(repo, { id: 'm-1', status: 'failed' })
    await expect(provider.recordReview(caller, { mission: failed.id, verdict: 'approve', summary: 'x' }))
      .rejects.toThrow(/reviews require an active, interrupted, or approved mission/)

    gitSync(repo, 'branch', 'tower/m-2')
    gitSync(repo, 'branch', 'tower/m-3')
    await craftMission(repo, { id: 'm-2', owner: caller.id })
    const reviewed = await craftMission(repo, { id: 'm-3' })
    const round = await provider.recordReview(caller, { mission: reviewed.id, verdict: 'approve', summary: 'peer ok' })
    expect(round.reviewer).toBe('m-2')
    expect(round.commit).toBe(gitSync(repo, 'rev-parse', 'refs/heads/tower/m-3'))
  }, 60_000)
})

describe('merge', () => {
  it('merges an approved mission into the base and removes the worktree', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo)
    const view = await spawn(booted, 'one')
    commitFile(view.worktree, 'feature.txt', 'v1\n')
    await booted.ctx.tower.recordReview(booted.lead, { mission: view.id, verdict: 'approve', summary: 'ok' })
    const result = await booted.ctx.tower.merge(booted.lead, view.id)
    expect(result.mission.status).toBe('merged')
    expect(result.mergeCommit).toBe(gitSync(repo, 'rev-parse', 'HEAD'))
    expect(gitSync(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    expect(existsSync(view.worktree)).toBe(false)
    expect(gitSync(repo, 'show', 'HEAD:feature.txt')).toBe('v1')
    const store = new TowerStore(repo)
    const entry = (await store.readActivity()).find(item => item.kind === 'merge')
    expect(entry?.detail).toContain(`merged tower/m-1 into main as ${result.mergeCommit.slice(0, 12)}`)
    expect((await booted.ctx.tower.status(booted.lead)).missions).toEqual([])
  }, 90_000)

  it('refuses an unapproved mission', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo)
    const view = await spawn(booted, 'one')
    await expect(booted.ctx.tower.merge(booted.lead, view.id)).rejects.toThrow(/only an approved mission can merge/)
  }, 90_000)

  it('refuses an approved mission whose latest round rejects', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    const mission = await craftMission(repo, { id: 'm-1', status: 'approved' })
    await store.appendReview(mission.id, {
      round: 1, verdict: 'reject', commit: 'deadbeef', summary: 'no', reviewer: 'lead', time: new Date().toISOString(),
    })
    await expect(provider.merge(caller, mission.id)).rejects.toThrow(/approved without an approving latest review round/)
  }, 60_000)

  it('refuses when the branch tip moved past the approved commit', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo)
    const view = await spawn(booted, 'one')
    commitFile(view.worktree, 'feature.txt', 'v1\n')
    await booted.ctx.tower.recordReview(booted.lead, { mission: view.id, verdict: 'approve', summary: 'ok' })
    commitFile(view.worktree, 'feature.txt', 'v2\n')
    await expect(booted.ctx.tower.merge(booted.lead, view.id)).rejects.toThrow(/no longer matches the approved commit/)
  }, 90_000)

  it('refuses a dirty mission worktree', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo)
    const view = await spawn(booted, 'one')
    commitFile(view.worktree, 'feature.txt', 'v1\n')
    await booted.ctx.tower.recordReview(booted.lead, { mission: view.id, verdict: 'approve', summary: 'ok' })
    await writeFile(join(view.worktree, 'dirty.txt'), 'uncommitted\n')
    await expect(booted.ctx.tower.merge(booted.lead, view.id)).rejects.toThrow(/uncommitted changes/)
  }, 90_000)

  it('refuses when the main checkout left the recorded base', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo)
    const view = await spawn(booted, 'one')
    commitFile(view.worktree, 'feature.txt', 'v1\n')
    await booted.ctx.tower.recordReview(booted.lead, { mission: view.id, verdict: 'approve', summary: 'ok' })
    gitSync(repo, 'checkout', '-b', 'side')
    await expect(booted.ctx.tower.merge(booted.lead, view.id)).rejects.toThrow(/not the recorded base/)
  }, 90_000)

  it('surfaces a merge conflict from git stdout and keeps the mission approved', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo)
    const view = await spawn(booted, 'one')
    await writeFile(join(view.worktree, 'README.md'), 'mission line\n')
    gitSync(view.worktree, 'add', 'README.md')
    gitSync(view.worktree, 'commit', '-m', 'mission edit')
    await writeFile(join(repo, 'README.md'), 'lead line\n')
    gitSync(repo, 'add', 'README.md')
    gitSync(repo, 'commit', '-m', 'lead edit')
    await booted.ctx.tower.recordReview(booted.lead, { mission: view.id, verdict: 'approve', summary: 'ok' })
    await expect(booted.ctx.tower.merge(booted.lead, view.id)).rejects.toThrow(/CONFLICT/)
    expect((await new TowerStore(repo).readMission(view.id))?.status).toBe('approved')
  }, 90_000)
})
