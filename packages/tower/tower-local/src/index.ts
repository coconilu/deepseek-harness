/**
 * Local tower provider plugin: registers the `.tower/` coordination store
 * plus git-worktree backend on `ctx.tower` under the name `local`.
 *
 * @module @deepseek-ai/dsh-tower-local
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tower/types'
import { z } from 'zod'
import { LocalTowerProvider } from './provider.ts'

/** Cordis plugin name. */
export const name = 'tower-local'

/** Services the provider drives: the tower registry, mission children, git processes. */
export const inject = ['tower', 'subagents', 'subprocess']

/** Plugin config: mission child composition and dashboard bounds. */
export interface Config {
  /** `ctx.subagents` provider name composing mission children (default `spawn`). */
  childProvider: string
  /**
   * Tool names denied from every mission child's tool set (default none). An
   * unknown or reserved name fails the mission child's start loudly.
   */
  childToolFilter: readonly string[]
  /** Maximum activity entries one `status` dashboard returns (default 50). */
  activityTail: number
}

/** Zod validation for {@link Config}: blank names, unknown keys, and non-positive bounds fail plugin load. */
// The cast bridges the defaulted fields, which Zod types as optional inputs
// while the interface reads them as materialized values.
export const Config = z.strictObject({
  childProvider: z.string().min(1).default('spawn'),
  childToolFilter: z.array(z.string().min(1)).default([]),
  activityTail: z.number().int().positive().default(50),
}) as unknown as z.ZodType<Config>

/**
 * Register the local backend on the tower service.
 * @param ctx - plugin context carrying the injected services.
 * @param config - validated provider config.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tower.registerProvider(new LocalTowerProvider(ctx, config))
}
