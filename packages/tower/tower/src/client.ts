/**
 * Client-namespace projection of the tower domain: a pure re-export of the
 * package's projection leaf. Client code imports ONLY the client namespace
 * (repo discipline), so `./client` serves the `tower` projection types and
 * key declarations without the host `ctx.tower` Context merge on `./types`
 * ("one program must not hold both sides").
 *
 * @module @deepseek-ai/dsh-tower/client
 */

export type * from './projection.ts'
