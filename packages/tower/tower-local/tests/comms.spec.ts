/**
 * Coordination suite: lead-mediated messages, inboxes, findings, teardown,
 * owner authority, dashboard bounds, config validation, and the activity
 * event. Booted compositions carry real deliveries; stubbed seams isolate
 * the addressing and fanout branches.
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TowerMessage } from '@deepseek-ai/dsh-tower/types'
import { TOWER_ACTIVITY_EVENT } from '../src/events.ts'
import type { TowerLocalActivityNotice } from '../src/events.ts'
import { Config } from '../src/index.ts'
import { TowerStore } from '../src/store.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import {
  activateTowerMode,
  boot,
  bootedWorkspace,
  commitFile,
  craftMission,
  fakeAgent,
  GatedAdapter,
  gitSync,
  liveChild,
  looseAgent,
  makeGitRepo,
  makePlainDir,
  minimalProvider,
  noGitProvider,
  runCleanups,
  seedWorkspace,
  spawn,
  stubAgents,
  stubSubagents,
  testSignal,
  waitForUserText,
} from './harness.ts'

afterEach(runCleanups)

/** Append one journaled message directly to the store. */
async function journalMessage(store: TowerStore, id: string, from: string, to: string, content: string): Promise<void> {
  const message: TowerMessage = { id, from, to, content, time: new Date().toISOString() }
  await store.appendMessage(message)
}

describe('sendMessage', () => {
  it('delivers a lead message to the mission child and records it', async () => {
    const repo = makeGitRepo()
    // The child's first turn holds on the gate so the delivery reaches a
    // deterministically resident child; releasing lets it process the queue.
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: release.promise },
      { chunks: textResponse('followup') },
      { chunks: textResponse('spare') },
    ])
    const booted = await bootedWorkspace(repo, [], { adapter })
    const view = await spawn(booted, 'one')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = liveChild(booted.ctx, view.owner)
    const message = await booted.ctx.tower.sendMessage(booted.lead, { to: view.id, content: 'hello child', signal: testSignal() })
    expect(message).toMatchObject({ from: 'lead', to: view.id, content: 'hello child' })
    release.resolve(undefined)
    await waitForUserText(child.session, 'hello child')
    const inbox = await booted.ctx.tower.inbox(child)
    expect(inbox.some(item => item.id === message.id)).toBe(true)
    const activity = await new TowerStore(repo).readActivity()
    expect(activity.some(entry => entry.kind === 'message' && entry.detail.includes('message from lead to m-1'))).toBe(true)
  }, 90_000)

  it('delivers a mission message to the lead inbox', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo, [], { hangFirst: 1 })
    const view = await spawn(booted, 'one')
    const child = liveChild(booted.ctx, view.owner)
    const message = await booted.ctx.tower.sendMessage(child, { to: 'lead', content: 'report from child', signal: testSignal() })
    expect(message.from).toBe(view.id)
    await waitForUserText(booted.lead.session, 'report from child')
    const inbox = await booted.ctx.tower.inbox(booted.lead)
    expect(inbox.some(item => item.from === view.id && item.content === 'report from child')).toBe(true)
  }, 90_000)

  it('fans a broadcast out to every other live mission child', async () => {
    const repo = makeGitRepo()
    // Independent gates sequence the residency: child one settles after the
    // lead broadcast while child two stays resident for the peer fanout.
    const releaseOne = Promise.withResolvers<undefined>()
    const releaseTwo = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('one first'), gate: releaseOne.promise },
      { chunks: textResponse('two first'), gate: releaseTwo.promise },
      { chunks: textResponse('one followup') },
      { chunks: textResponse('two followup') },
      { chunks: textResponse('spare one') },
      { chunks: textResponse('spare two') },
    ])
    const booted = await bootedWorkspace(repo, [], { adapter })
    const first = await spawn(booted, 'one')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const second = await spawn(booted, 'two')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const firstChild = liveChild(booted.ctx, first.owner)
    const secondChild = liveChild(booted.ctx, second.owner)

    await booted.ctx.tower.sendMessage(booted.lead, { to: 'all', content: 'lead broadcast', signal: testSignal() })
    releaseOne.resolve(undefined)
    await waitForUserText(firstChild.session, 'lead broadcast')

    // A settled sender still addresses the fanout; delivery goes through the lead.
    await booted.ctx.tower.sendMessage(firstChild, { to: 'all', content: 'peer broadcast', signal: testSignal() })
    releaseTwo.resolve(undefined)
    await waitForUserText(secondChild.session, 'lead broadcast')
    await waitForUserText(secondChild.session, 'peer broadcast')
    // The sender is excluded from its own fanout.
    expect(firstChild.session.snapshotEvents().some(event =>
      event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('peer broadcast')),
    )).toBe(false)
    const leadInbox = await booted.ctx.tower.inbox(booted.lead)
    expect(leadInbox.filter(item => item.to === 'all')).toHaveLength(2)
  }, 120_000)

  it('delivers through the stubbed seam and rejects bad addresses', async () => {
    const repo = makeGitRepo()
    const { ctx, provider, caller } = await minimalProvider(repo)
    const capture = stubSubagents(ctx)
    const store = await seedWorkspace(repo)
    const mission = await craftMission(repo, { id: 'm-1', owner: SessionId('child-1') })

    const message = await provider.sendMessage(caller, { to: mission.id, content: 'hello', signal: testSignal() })
    expect(message.from).toBe('lead')
    expect(capture.sent).toHaveLength(1)
    expect(capture.sent.at(0)?.target).toBe(SessionId('child-1'))
    expect(capture.sent.at(0)?.text).toBe('[tower message from lead]\nhello')

    await expect(provider.sendMessage(caller, { to: 'lead', content: 'x', signal: testSignal() }))
      .rejects.toThrow(/cannot address a tower message to itself/)
    await expect(provider.sendMessage(caller, { to: 'm-99', content: 'x', signal: testSignal() }))
      .rejects.toThrow(/unknown tower message address/)
    const failed = await craftMission(repo, { id: 'm-2', status: 'failed' })
    await expect(provider.sendMessage(caller, { to: failed.id, content: 'x', signal: testSignal() }))
      .rejects.toThrow(/is failed; it cannot receive tower messages/)
    expect(await store.readMessages()).toHaveLength(1)
  }, 60_000)

  it('refuses an already-aborted signal before recording', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    const controller = new AbortController()
    controller.abort()
    await expect(provider.sendMessage(caller, { to: 'all', content: 'x', signal: controller.signal }))
      .rejects.toThrow(/abort/i)
    expect(await store.readMessages()).toEqual([])
  }, 60_000)

  it('fans out only to live, addressed, non-self mission children', async () => {
    const repo = makeGitRepo()
    const { ctx, provider } = await minimalProvider(repo)
    const capture = stubSubagents(ctx)
    stubAgents(ctx, ['the-lead', 'live-c', 'live-c2', 'live-c3'])
    await seedWorkspace(repo)
    const caller = looseAgent(ctx, 'probe', { cwd: repo, parentSession: SessionId('the-lead') })
    await craftMission(repo, { id: 'm-1', owner: caller.id })
    await craftMission(repo, { id: 'm-2', owner: SessionId('dead') })
    await craftMission(repo, { id: 'm-3', owner: SessionId('live-c') })
    await craftMission(repo, { id: 'm-4', status: 'approved', owner: SessionId('live-c2') })
    await craftMission(repo, { id: 'm-5', status: 'interrupted', owner: SessionId('live-c3') })
    await craftMission(repo, { id: 'm-6' })

    const message = await provider.sendMessage(caller, { to: 'all', content: 'roll call', signal: testSignal() })
    expect(message.from).toBe('m-1')
    expect(capture.sent.map(item => item.target)).toEqual([SessionId('live-c'), SessionId('live-c2')])
    expect(capture.sent.every(item => item.sender.id === SessionId('the-lead'))).toBe(true)
    expect(capture.sent.at(0)?.text).toBe('[tower message from m-1]\nroll call')
  }, 60_000)

  it('fails loud when a mission caller cannot reach the mediating lead', async () => {
    const repo = makeGitRepo()
    const { ctx, provider } = await minimalProvider(repo)
    stubSubagents(ctx)
    await seedWorkspace(repo)
    const parentless = looseAgent(ctx, 'probe', { cwd: repo })
    await craftMission(repo, { id: 'm-1', owner: parentless.id })
    await craftMission(repo, { id: 'm-2', owner: SessionId('child-2') })
    await expect(provider.sendMessage(parentless, { to: 'lead', content: 'x', signal: testSignal() }))
      .rejects.toThrow(/no recorded parent session to receive lead messages/)
    await expect(provider.sendMessage(parentless, { to: 'm-2', content: 'x', signal: testSignal() }))
      .rejects.toThrow(/has no recorded parent session/)

    const orphaned = looseAgent(ctx, 'orphan', { cwd: repo, parentSession: SessionId('ghost-lead') })
    await craftMission(repo, { id: 'm-3', owner: orphaned.id })
    await expect(provider.sendMessage(orphaned, { to: 'm-2', content: 'x', signal: testSignal() }))
      .rejects.toThrow(/lead session is not live to mediate mission delivery/)
  }, 60_000)

  it('fails loud when the addressed mission has no child to deliver to', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    await seedWorkspace(repo)
    const ownerless = await craftMission(repo, { id: 'm-1' })
    await expect(provider.sendMessage(caller, { to: ownerless.id, content: 'x', signal: testSignal() }))
      .rejects.toThrow(/has no mission child to deliver to/)
  }, 60_000)

  it('keeps the record pullable when delivery fails', async () => {
    const repo = makeGitRepo()
    const { ctx, provider, caller } = await minimalProvider(repo)
    stubSubagents(ctx, { send: new Error('inbox closed') })
    const store = await seedWorkspace(repo)
    const mission = await craftMission(repo, { id: 'm-1', owner: SessionId('child-1') })
    await expect(provider.sendMessage(caller, { to: mission.id, content: 'lost', signal: testSignal() }))
      .rejects.toThrow(/inbox closed/)
    const messages = await store.readMessages()
    expect(messages).toHaveLength(1)
    expect(messages.at(0)?.content).toBe('lost')
    const childCaller = looseAgent(ctx, 'child-1', { cwd: repo })
    expect((await provider.inbox(childCaller)).at(0)?.content).toBe('lost')
  }, 60_000)
})

describe('inbox', () => {
  it('filters by caller address and applies limits from the newest', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    await journalMessage(store, '1', 'lead', 'm-1', 'a')
    await journalMessage(store, '2', 'm-1', 'all', 'b')
    await journalMessage(store, '3', 'lead', 'm-2', 'c')
    await journalMessage(store, '4', 'm-2', 'lead', 'd')

    expect((await provider.inbox(caller)).map(item => item.content)).toEqual(['b', 'd'])
    expect((await provider.inbox(caller, 1)).map(item => item.content)).toEqual(['d'])
    expect(await provider.inbox(caller, 0)).toEqual([])
    expect(await provider.inbox(caller, -3)).toEqual([])

    await craftMission(repo, { id: 'm-1', owner: caller.id })
    expect((await provider.inbox(caller)).map(item => item.content)).toEqual(['a', 'b'])
  }, 60_000)
})

describe('findings', () => {
  it('records findings from the lead and mission children', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo, [], { hangFirst: 1 })
    const view = await spawn(booted, 'one')
    const child = liveChild(booted.ctx, view.owner)
    const byLead = await booted.ctx.tower.recordFinding(booted.lead, { title: 'alpha', body: 'from the lead' })
    const byChild = await booted.ctx.tower.recordFinding(child, { title: 'beta', body: 'from the mission' })
    expect(byLead).toMatchObject({ id: 'f-1', author: 'lead' })
    expect(byChild).toMatchObject({ id: 'f-2', author: view.id })
    expect((await booted.ctx.tower.listFindings(child)).map(item => item.id)).toEqual(['f-1', 'f-2'])
    expect((await booted.ctx.tower.status(booted.lead)).findings).toBe(2)
    const activity = await new TowerStore(repo).readActivity()
    expect(activity.filter(entry => entry.kind === 'finding')).toHaveLength(2)
  }, 90_000)
})

describe('teardown', () => {
  it('drains live children and removes clean worktrees, keeping dirty ones without force', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo, [], { hangFirst: 2 })
    const first = await spawn(booted, 'one')
    const second = await spawn(booted, 'two')
    await writeFile(join(second.worktree, 'dirty.txt'), 'uncommitted\n')

    const result = await booted.ctx.tower.teardown(booted.lead, { force: false, signal: testSignal() })
    expect(result.removed).toEqual([first.id])
    expect(result.kept).toEqual([{ id: second.id, reason: 'worktree has uncommitted changes' }])
    expect(result.interrupted).toBe(2)
    expect(existsSync(first.worktree)).toBe(false)
    expect(existsSync(second.worktree)).toBe(true)

    const forced = await booted.ctx.tower.teardown(booted.lead, { force: true, signal: testSignal() })
    expect(forced.removed).toEqual([second.id])
    expect(forced.kept).toEqual([])
    expect(existsSync(second.worktree)).toBe(false)
    const activity = await new TowerStore(repo).readActivity()
    expect(activity.filter(entry => entry.kind === 'teardown')).toHaveLength(2)
  }, 120_000)

  it('never drains foreign live agents and skips vanished worktrees', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo)
    fakeAgent(booted.ctx, 'foreign', { cwd: repo })
    await craftMission(repo, { id: 'm-9', owner: SessionId('foreign') })
    const result = await booted.ctx.tower.teardown(booted.lead, { force: false, signal: testSignal() })
    expect(result.interrupted).toBe(0)
    expect(result.removed).toEqual([])
    expect(result.kept).toEqual([])
    expect(booted.ctx.agents.get(SessionId('foreign'))).toBeDefined()
  }, 90_000)

  it('reports a locked worktree as kept with the removal failure', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    const locked = await craftMission(repo, { id: 'm-1', owner: SessionId('child-1') })
    gitSync(repo, 'worktree', 'add', locked.worktree, '-b', locked.branch, 'main')
    gitSync(repo, 'worktree', 'lock', locked.worktree)
    await craftMission(repo, { id: 'm-2', status: 'merged' })

    const result = await provider.teardown(caller, { force: true, signal: testSignal() })
    expect(result.removed).toEqual([])
    expect(result.kept).toHaveLength(1)
    expect(result.kept.at(0)?.id).toBe(locked.id)
    expect(result.kept.at(0)?.reason).toContain('worktree removal failed')
    expect(result.interrupted).toBe(0)
    expect(await store.listMissions()).toHaveLength(2)
  }, 60_000)

  it('refuses an already-aborted signal', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await minimalProvider(repo)
    await seedWorkspace(repo)
    const controller = new AbortController()
    controller.abort()
    await expect(provider.teardown(caller, { force: false, signal: controller.signal }))
      .rejects.toThrow(/abort/i)
  }, 60_000)
})

describe('isMissionOwner', () => {
  it('answers true for a recorded owner and false after merge', async () => {
    const repo = makeGitRepo()
    const { ctx, provider, caller } = await minimalProvider(repo)
    await seedWorkspace(repo)
    await craftMission(repo, { id: 'm-1', owner: caller.id })
    await craftMission(repo, { id: 'm-2', status: 'merged', owner: SessionId('other') })
    expect(await provider.isMissionOwner(caller.session)).toBe(true)
    const other = looseAgent(ctx, 'other', { cwd: repo })
    expect(await provider.isMissionOwner(other.session)).toBe(false)
  }, 60_000)

  it('reads false outside git and stays loud on store corruption', async () => {
    const repo = makeGitRepo()
    const { ctx, provider, caller } = await minimalProvider(repo)
    const store = await seedWorkspace(repo)
    const cwdfree = looseAgent(ctx, 'cwdfree')
    expect(await provider.isMissionOwner(cwdfree.session)).toBe(false)
    const plain = looseAgent(ctx, 'plain', { cwd: makePlainDir() })
    expect(await provider.isMissionOwner(plain.session)).toBe(false)
    await writeFile(join(store.missionsDir, 'm-1.json'), 'not json{')
    await expect(provider.isMissionOwner(caller.session)).rejects.toThrow(/corrupt store record/)
  }, 60_000)

  it('propagates a git-resolution failure instead of reading false', async () => {
    const repo = makeGitRepo()
    const { provider, caller } = await noGitProvider(repo)
    await expect(provider.isMissionOwner(caller.session)).rejects.toThrow(/git is not installed/)
  }, 60_000)
})

describe('dashboard bounds and config', () => {
  it('bounds the activity tail by the configured value', async () => {
    const repo = makeGitRepo()
    const booted = await bootedWorkspace(repo, ['    activityTail: 1'])
    await spawn(booted, 'one')
    const dashboard = await booted.ctx.tower.status(booted.lead)
    expect(dashboard.activity).toHaveLength(1)
    expect(dashboard.activity.at(0)?.kind).toBe('spawn')
  }, 90_000)

  it('rejects invalid plugin config at load', async () => {
    const repo = makeGitRepo()
    await expect(boot({ repo, towerLocalConfig: ['    activityTail: -1'] })).rejects.toThrow()
  }, 60_000)

  it('materializes the child tool filter default and validates deny names', () => {
    expect(Config.parse({})).toEqual({ childProvider: 'spawn', childToolFilter: [], activityTail: 50 })
    expect(Config.parse({ childToolFilter: ['tower_spawn', 'tower_review'] }))
      .toMatchObject({ childProvider: 'spawn', childToolFilter: ['tower_spawn', 'tower_review'], activityTail: 50 })
    expect(() => Config.parse({ childToolFilter: ['ok', ''] })).toThrow()
    expect(() => Config.parse({ childToolFilter: ['ok', 7] })).toThrow()
    expect(() => Config.parse({ childToolFilter: 'tower_spawn' })).toThrow()
  })

  it('rejects an invalid child tool filter at plugin load', async () => {
    const repo = makeGitRepo()
    await expect(boot({ repo, towerLocalConfig: ['    childToolFilter:', '      - ""'] })).rejects.toThrow()
  }, 60_000)
})

describe('activity event', () => {
  it('emits one notice per committed entry, carrying the merged tip only for merges', async () => {
    const repo = makeGitRepo()
    const booted = await boot({ repo, towerLocalConfig: [] })
    const notices: TowerLocalActivityNotice[] = []
    booted.ctx.on(TOWER_ACTIVITY_EVENT, (notice) => {
      notices.push(notice)
    })
    activateTowerMode(booted.lead)
    await booted.ctx.tower.init(booted.lead)
    expect(notices).toHaveLength(1)
    expect(notices.at(0)?.entry.kind).toBe('init')
    expect(normalize(notices.at(0)?.root ?? '')).toBe(normalize(repo))
    expect(notices.at(0)?.commit).toBeUndefined()

    const view = await spawn(booted, 'one')
    const tip = commitFile(view.worktree, 'feature.txt', 'v1\n')
    await booted.ctx.tower.recordReview(booted.lead, { mission: view.id, verdict: 'approve', summary: 'ok' })
    await booted.ctx.tower.merge(booted.lead, view.id)
    const mergeNotice = notices.find(notice => notice.entry.kind === 'merge')
    expect(mergeNotice?.commit).toBe(tip)
    expect(notices.filter(notice => 'commit' in notice)).toHaveLength(1)
  }, 90_000)
})
