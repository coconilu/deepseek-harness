/**
 * Shared in-memory {@link TowerProvider} stub for the tower Service Definition
 * suites: records every call, validates bases against a configurable failure,
 * and reports a caller-owned mission list plus a session-id owner set.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { TowerFindingId, TowerMissionId } from '../src/index.ts'
import type {
  TowerDashboard,
  TowerFinding,
  TowerFindingRequest,
  TowerMergeResult,
  TowerMessage,
  TowerMessageRequest,
  TowerMissionId as MissionId,
  TowerMissionView,
  TowerProvider,
  TowerReviewRequest,
  TowerReviewRound,
  TowerSpawnRequest,
  TowerTeardownRequest,
  TowerTeardownResult,
  TowerWorkspaceInfo,
} from '../src/index.ts'

/** Build one mission row for the stub's dashboard and spawn results. */
export function stubMission(id: string, overrides: Partial<TowerMissionView> = {}): TowerMissionView {
  return {
    id: TowerMissionId(id),
    title: `Mission ${id}`,
    prompt: 'do the thing',
    base: 'main',
    branch: `tower/${id}`,
    worktree: `/repo/.tower/worktrees/${id}`,
    status: 'active',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ownerLive: true,
    tipMatchesReview: false,
    ...overrides,
  }
}

/** In-memory tower backend: one call log, one mission list, one owner set. */
export class StubTowerProvider implements TowerProvider {
  /** Every invoked provider method, in order. */
  readonly calls: string[] = []
  /** Unmerged missions reported by `status`. */
  missions: TowerMissionView[] = []
  /** Session ids that own an unmerged mission. */
  readonly owners = new Set<string>()
  /** `(cwd, base)` pairs passed to `validateBase`. */
  readonly validateBaseCalls: readonly [string, string][] = []
  /** When set, `validateBase` throws this value. */
  validateBaseError: unknown

  constructor(readonly name: string) {}

  async validateBase(cwd: string, base: string): Promise<void> {
    (this.validateBaseCalls as [string, string][]).push([cwd, base])
    // Tests set non-Error values to pin the facade's non-Error failure path.
    if (this.validateBaseError !== undefined) throw this.validateBaseError
  }

  init(caller: Agent): Promise<TowerWorkspaceInfo> {
    this.calls.push(`init:${caller.id}`)
    return Promise.resolve({
      workspace: { version: 1, base: 'main', root: '/repo', createdAt: '2026-09-10T00:00:00.000Z' },
      adopted: false,
      missions: this.missions.length,
    })
  }

  status(caller: Agent): Promise<TowerDashboard> {
    this.calls.push(`status:${caller.id}`)
    return Promise.resolve({ base: 'main', missions: this.missions, findings: 0, activity: [] })
  }

  spawnMission(caller: Agent, request: TowerSpawnRequest): Promise<TowerMissionView> {
    this.calls.push(`spawnMission:${caller.id}:${request.title}`)
    const mission = stubMission(`m-${this.missions.length + 1}`)
    this.missions = [...this.missions, mission]
    return Promise.resolve(mission)
  }

  abortMission(caller: Agent, id: MissionId): Promise<TowerMissionView> {
    this.calls.push(`abortMission:${caller.id}:${id}`)
    return Promise.resolve(stubMission(id, { status: 'aborted' }))
  }

  sendMessage(caller: Agent, request: TowerMessageRequest): Promise<TowerMessage> {
    this.calls.push(`sendMessage:${caller.id}:${request.to}`)
    return Promise.resolve({
      id: 'msg-1',
      from: 'lead',
      to: request.to,
      content: request.content,
      time: '2026-09-10T00:00:00.000Z',
    })
  }

  inbox(caller: Agent, limit?: number): Promise<TowerMessage[]> {
    this.calls.push(`inbox:${caller.id}:${String(limit)}`)
    return Promise.resolve([])
  }

  recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding> {
    this.calls.push(`recordFinding:${caller.id}:${request.title}`)
    return Promise.resolve({
      id: TowerFindingId('f-1'),
      title: request.title,
      body: request.body,
      author: 'lead',
      time: '2026-09-10T00:00:00.000Z',
    })
  }

  listFindings(caller: Agent): Promise<TowerFinding[]> {
    this.calls.push(`listFindings:${caller.id}`)
    return Promise.resolve([])
  }

  recordReview(caller: Agent, request: TowerReviewRequest): Promise<TowerReviewRound> {
    this.calls.push(`recordReview:${caller.id}:${request.mission}:${request.verdict}`)
    return Promise.resolve({
      round: 1,
      verdict: request.verdict,
      commit: 'deadbeef',
      summary: request.summary,
      reviewer: 'lead',
      time: '2026-09-10T00:00:00.000Z',
    })
  }

  merge(caller: Agent, id: MissionId): Promise<TowerMergeResult> {
    this.calls.push(`merge:${caller.id}:${id}`)
    return Promise.resolve({ mission: stubMission(id, { status: 'merged' }), mergeCommit: 'cafe' })
  }

  teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult> {
    this.calls.push(`teardown:${caller.id}:${String(request.force)}`)
    return Promise.resolve({ removed: [], kept: [], interrupted: 0 })
  }

  isMissionOwner(session: Session): Promise<boolean> {
    return Promise.resolve(this.owners.has(session.id))
  }
}
