/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tower-local`.
 * @module @deepseek-ai/dsh-tower-local/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { TOWER_ACTIVITY_EVENT } from './events.ts'
import { TowerStore } from './store.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-tower-local'

/** Cordis companion plugin name. */
export const name = 'tower-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the merge-review contract: every merge activity entry must be
 * backed by an approving review round for the exact merged commit in the
 * same workspace. The activity journal and the review journals are
 * independent records, so a merge recorded without its review means the
 * gate was bypassed, and a later read would see a merged mission the review
 * trail cannot explain. The listener is synchronous because the provider's
 * dispatch reaches the recording operation only from synchronous listeners.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on(TOWER_ACTIVITY_EVENT, (notice) => {
    if (notice.entry.kind !== 'merge') return
    const mission = notice.entry.mission
    if (mission === undefined) {
      fail(`tower-local merge activity without a mission id in store ${notice.root}`)
    }
    if (notice.commit === undefined) {
      fail(`tower-local merge activity for "${mission}" without the merged commit`)
    }
    const reviews = new TowerStore(notice.root).readReviewsSync(mission)
    if (!reviews.some(review => review.verdict === 'approve' && review.commit === notice.commit)) {
      fail(`tower-local merge of "${mission}" at ${notice.commit} has no approving review round for that commit`)
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
