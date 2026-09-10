/**
 * The provider's commit-time activity notification: after an entry lands in
 * the workspace activity journal, observers receive it synchronously through
 * the Cordis event bus. The merge entry additionally carries the merged
 * branch tip so synchronous checks (the package invariant companion) can
 * compare it against the review journal without running git.
 *
 * @module @deepseek-ai/dsh-tower-local/events
 */

import type { TowerActivityEntry } from '@deepseek-ai/dsh-tower/types'

/** Cordis event name carrying one {@link TowerLocalActivityNotice}. */
export const TOWER_ACTIVITY_EVENT = 'tower-local/activity'

/** One committed activity entry plus the facts a synchronous observer cannot re-derive. */
export interface TowerLocalActivityNotice {
  /** Absolute git root owning the `.tower/` store that recorded the entry. */
  readonly root: string
  /** The committed journal entry. */
  readonly entry: TowerActivityEntry
  /** The merged mission branch tip; present exactly for `merge` entries. */
  readonly commit?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One tower-local activity entry committed to the workspace journal. The
     * dispatch is synchronous and runs before the recording operation
     * returns, so a synchronous listener's throw reaches that operation;
     * listeners must be synchronous, must tolerate stores they do not own,
     * and must not call back into the emitting provider (its storage
     * transaction is still open).
     * @param notice - the store root, the committed entry, and the merged branch tip when any.
     * @mode emit
     */
    'tower-local/activity'(notice: TowerLocalActivityNotice): void
  }
}
