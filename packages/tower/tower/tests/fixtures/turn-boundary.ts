/** Turn-boundary projection fixture for the tower Loader composition. */

import type { Context } from '@deepseek-ai/cordis'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'

export const name = 'tower-turn-boundary-fixture'
export const inject = ['sessionProjections']

/**
 * Register the real turn-boundary unit the tower service reads for open turns.
 * @param ctx - fixture composition.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
}
