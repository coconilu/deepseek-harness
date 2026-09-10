/** Registers the in-memory tower stub as the default `local` provider for Loader composition. */

import type { Context } from '@deepseek-ai/cordis'
import { StubTowerProvider } from './stub-provider.ts'

export const name = 'tower-stub-provider'
export const inject = ['tower']

/** The registered provider instance, exported so the composing spec can observe delegation. */
export const provider = new StubTowerProvider()

/**
 * Register the stub under the default `local` provider name.
 * @param ctx - fixture composition.
 */
export function apply(ctx: Context): void {
  ctx.tower.registerProvider(provider)
}
