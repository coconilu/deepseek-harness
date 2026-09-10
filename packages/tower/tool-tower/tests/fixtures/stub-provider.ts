/**
 * In-memory {@link TowerProvider} stub for the tool-tower suites: records
 * every call, reports a caller-owned mission list with liveness/review-gate
 * fields, a session-id owner set, a configurable inbox, and a fixed activity
 * tail. No git, no store, no child lifecycle.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { TowerFindingId, TowerMissionId } from '@deepseek-ai/dsh-tower'
import type {
  TowerDashboard,
  TowerFinding,
  TowerFindingRequest,
  TowerMergeResult,
  TowerMessage,
  TowerMessageRequest,
  TowerMissionView,
  TowerProvider,
  TowerReviewRequest,
  TowerReviewRound,
  TowerSpawnRequest,
  TowerTeardownRequest,
  TowerTeardownResult,
  TowerWorkspaceInfo,
} from '@deepseek-ai/dsh-tower'

/** Build one mission row for the stub's dashboard and operation results. */
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

/** Build one inbox message for the stub's journal. */
export function stubMessage(id: string, to: string, content: string): TowerMessage {
  return { id, from: 'lead', to, content, time: '2026-09-10T00:00:00.000Z' }
}

/** In-memory tower backend: one call log, one mission list, one owner set. */
export class StubTowerProvider implements TowerProvider {
  /** The registry name the facade resolves (the default `local`). */
  readonly name = 'local'

  /** Every invoked provider method, in order. */
  readonly calls: string[] = []
  /** Unmerged missions reported by `status`. */
  missions: TowerMissionView[] = []
  /** Session ids that own an unmerged mission. */
  readonly owners = new Set<string>()
  /** Messages the inbox returns, newest last. */
  inboxMessages: TowerMessage[] = []
  /** Activity entries the dashboard reports. */
  activity: TowerDashboard['activity'] = []
  /** Missions teardown reports as kept, when set by a test. */
  kept: TowerTeardownResult['kept'] = []

  async validateBase(cwd: string, base: string): Promise<void> {
    this.calls.push(`validateBase:${cwd}:${base}`)
  }

  async init(caller: Agent): Promise<TowerWorkspaceInfo> {
    this.calls.push(`init:${caller.id}`)
    return {
      workspace: { version: 1, base: 'main', root: '/repo', createdAt: '2026-09-10T00:00:00.000Z' },
      adopted: false,
      missions: this.missions.length,
    }
  }

  async status(caller: Agent): Promise<TowerDashboard> {
    this.calls.push(`status:${caller.id}`)
    return { base: 'main', missions: this.missions, findings: 0, activity: this.activity }
  }

  async spawnMission(caller: Agent, request: TowerSpawnRequest): Promise<TowerMissionView> {
    this.calls.push(`spawnMission:${caller.id}:${request.title}`)
    const mission = stubMission(`m-${this.missions.length + 1}`)
    this.missions = [...this.missions, mission]
    return mission
  }

  async abortMission(caller: Agent, id: TowerMissionId): Promise<TowerMissionView> {
    this.calls.push(`abortMission:${caller.id}:${id}`)
    return stubMission(id, { status: 'aborted' })
  }

  async sendMessage(caller: Agent, request: TowerMessageRequest): Promise<TowerMessage> {
    this.calls.push(`sendMessage:${caller.id}:${request.to}`)
    return { id: 'msg-1', from: 'lead', to: request.to, content: request.content, time: '2026-09-10T00:00:00.000Z' }
  }

  async inbox(caller: Agent, limit?: number): Promise<TowerMessage[]> {
    this.calls.push(`inbox:${caller.id}:${String(limit)}`)
    return this.inboxMessages
  }

  async recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding> {
    this.calls.push(`recordFinding:${caller.id}:${request.title}`)
    return { id: TowerFindingId('f-1'), title: request.title, body: request.body, author: 'lead', time: '2026-09-10T00:00:00.000Z' }
  }

  async listFindings(caller: Agent): Promise<TowerFinding[]> {
    this.calls.push(`listFindings:${caller.id}`)
    return []
  }

  async recordReview(caller: Agent, request: TowerReviewRequest): Promise<TowerReviewRound> {
    this.calls.push(`recordReview:${caller.id}:${request.mission}:${request.verdict}`)
    return { round: 1, verdict: request.verdict, commit: 'deadbeef', summary: request.summary, reviewer: 'lead', time: '2026-09-10T00:00:00.000Z' }
  }

  async merge(caller: Agent, id: TowerMissionId): Promise<TowerMergeResult> {
    this.calls.push(`merge:${caller.id}:${id}`)
    return { mission: stubMission(id, { status: 'merged' }), mergeCommit: 'cafe1234' }
  }

  async teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult> {
    this.calls.push(`teardown:${caller.id}:${String(request.force)}`)
    return { removed: [], kept: this.kept, interrupted: 0 }
  }

  async isMissionOwner(session: Session): Promise<boolean> {
    return this.owners.has(session.id)
  }
}
