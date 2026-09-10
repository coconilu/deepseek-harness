/**
 * Invariant companion suite: the merge-review contract checked synchronously
 * at activity commit time, against the real invariants registry.
 */

import { mkdir } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { TowerMissionId } from '@deepseek-ai/dsh-tower/types'
import { TOWER_ACTIVITY_EVENT } from '../src/events.ts'
import type { TowerLocalActivityNotice } from '../src/events.ts'
import * as TowerLocalInvariant from '../src/invariant.ts'
import { TowerStore } from '../src/store.ts'
import { makePlainDir, runCleanups, trackCleanup } from './harness.ts'

afterEach(runCleanups)

/** Boot the invariants registry plus this package's companion. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(TowerLocalInvariant)
  trackCleanup(async () => {
    await ctx.fiber.dispose()
  })
  return ctx
}

/** One merge activity notice over `root`, with overrides for the refusal cases. */
function mergeNotice(
  root: string,
  overrides: Partial<TowerLocalActivityNotice> & { mission?: TowerMissionId | undefined } = {},
): TowerLocalActivityNotice {
  const { mission, ...rest } = overrides
  return {
    root,
    entry: {
      time: new Date().toISOString(),
      kind: 'merge',
      actor: 'lead',
      ...mission !== undefined ? { mission } : {},
      detail: 'merged tower/m-1 into main',
    },
    commit: 'abc123',
    ...rest,
  }
}

/** Seed one approving review round for `commit` in `root`'s store. */
async function seedReview(root: string, mission: TowerMissionId, commit: string): Promise<void> {
  await new TowerStore(root).appendReview(mission, {
    round: 1, verdict: 'approve', commit, summary: 'ok', reviewer: 'lead', time: new Date().toISOString(),
  })
}

describe('tower-local invariant companion', () => {
  it('ignores non-merge entries', async () => {
    const ctx = await setup()
    const root = makePlainDir()
    ctx.emit(TOWER_ACTIVITY_EVENT, {
      root,
      entry: { time: new Date().toISOString(), kind: 'spawn', actor: 'lead', detail: 'spawned' },
    })
  })

  it('rejects a merge entry without a mission id or the merged commit', async () => {
    const ctx = await setup()
    const root = makePlainDir()
    expect(() => {
      ctx.emit(TOWER_ACTIVITY_EVENT, mergeNotice(root, { mission: undefined }))
    }).toThrow(/merge activity without a mission id/)
    expect(() => {
      ctx.emit(TOWER_ACTIVITY_EVENT, mergeNotice(root, { mission: TowerMissionId('m-1'), commit: undefined }))
    }).toThrow(/without the merged commit/)
  })

  it('rejects a merge without an approving review round for that commit', async () => {
    const ctx = await setup()
    const root = makePlainDir()
    const mission = TowerMissionId('m-1')
    // No review journal at all.
    expect(() => {
      ctx.emit(TOWER_ACTIVITY_EVENT, mergeNotice(root, { mission }))
    }).toThrow(/has no approving review round for that commit/)
    // An approving round for a different commit does not count.
    await seedReview(root, mission, 'other')
    expect(() => {
      ctx.emit(TOWER_ACTIVITY_EVENT, mergeNotice(root, { mission }))
    }).toThrow(/has no approving review round for that commit/)
  })

  it('accepts a merge backed by an approving review for the exact commit', async () => {
    const ctx = await setup()
    const root = makePlainDir()
    const mission = TowerMissionId('m-1')
    await seedReview(root, mission, 'abc123')
    ctx.emit(TOWER_ACTIVITY_EVENT, mergeNotice(root, { mission }))
  })

  it('propagates an unreadable review journal instead of passing', async () => {
    const ctx = await setup()
    const root = makePlainDir()
    const mission = TowerMissionId('m-1')
    await mkdir(new TowerStore(root).reviewsPath(mission), { recursive: true })
    expect(() => {
      ctx.emit(TOWER_ACTIVITY_EVENT, mergeNotice(root, { mission }))
    }).toThrow()
  })

  it('stops checking once the companion fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(TowerLocalInvariant)
    trackCleanup(async () => {
      await ctx.fiber.dispose()
    })
    const root = makePlainDir()
    await fiber.dispose()
    ctx.emit(TOWER_ACTIVITY_EVENT, mergeNotice(root, { mission: TowerMissionId('m-1') }))
  })
})
