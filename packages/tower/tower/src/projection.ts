/**
 * The `tower` session projection's types and projection-key declarations,
 * owned as a leaf module: the package's `./client` face re-exports this file
 * so client carriers type the projection without the host `ctx.tower`
 * Context merge that lives on `./types` ("one program must not hold both
 * sides"). `./types` re-exports the same content for host consumers.
 *
 * @module @deepseek-ai/dsh-tower/projection
 */

/** Unit state of the `tower` session projection: logged tower mode. */
export interface TowerUnitState {
  /** The committed mode. */
  readonly active: boolean
  /** The base recorded with the latest activation. */
  readonly base: string | null
  /** The selected state awaiting the next accepted in-turn pre-step. */
  readonly wanted: boolean | null
  /** The running `/tower` command correlation, like the plan unit's. */
  readonly running: { readonly wanted: boolean } | null
  /** The committed mode at the last request header. */
  readonly activeAtLastHeader: boolean | null
}

/** Cropped wire view of the `tower` projection for client carriers. */
export interface TowerProjection {
  readonly active: boolean
  readonly pending: boolean
  /** The logged base branch when active. */
  readonly base?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host tower fold state. */
    tower: TowerUnitState
  }
  interface SessionProjectionMap {
    /** Tower mode folded from the tower command lifecycle and `tower/mode` events. */
    tower: TowerProjection
  }
}
