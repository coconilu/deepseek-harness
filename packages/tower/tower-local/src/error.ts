/**
 * Package-owned failure type for `@deepseek-ai/dsh-tower-local`: one error
 * class with a machine-routable code, so store, git, and lifecycle failures
 * stay attributable to this provider.
 *
 * @module @deepseek-ai/dsh-tower-local/error
 */

/** Stable classification of one {@link TowerLocalError}. */
export type TowerLocalErrorCode =
  /** The caller's working directory is not inside a git work tree. */
  | 'NO_GIT'
  /** The git work tree carries no `.tower/workspace.json`. */
  | 'NO_WORKSPACE'
  /** Every other provider failure (corrupt store, git rejection, lifecycle refusal). */
  | 'TOWER_LOCAL'

/** One loud tower-local failure, prefixed so the provider is identifiable in logs. */
export class TowerLocalError extends Error {
  override readonly name = 'TowerLocalError'
  /** The stable machine-routable code. */
  readonly code: TowerLocalErrorCode

  /**
   * Construct one provider failure.
   * @param message - the failure detail, without the provider prefix.
   * @param code - the classification; defaults to `TOWER_LOCAL`.
   * @param options - standard error options (cause chaining).
   */
  constructor(message: string, code: TowerLocalErrorCode = 'TOWER_LOCAL', options?: ErrorOptions) {
    super(`tower-local: ${message}`, options)
    this.code = code
  }
}
