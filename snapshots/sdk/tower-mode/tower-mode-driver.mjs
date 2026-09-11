/**
 * Scenario-local fixture driver for the tower-mode SDK snapshot.
 *
 * The scenario pins the SDK notification wire face of the `tower/mode`
 * SessionEventMap member: the event this driver appends is the exact durable
 * emission the tower Service Definition performs on mode selection (and the
 * SDK server forwards every session event as a `session.event` notification).
 * The full tower surface — the real `/tower` command lifecycle, the
 * `tower:policy` prompt section, the ten tools, and the git-backed mission
 * lifecycle — is exercised by the headless tower-merge-flow scenario.
 *
 * The driver appends the event on the root session's first accepted pre-step,
 * inside the turn, so the notification lands between the step's system
 * message and the model request like a live mode selection.
 *
 * @module tower-mode-fixture
 */

export const name = 'tower-mode-fixture'

export const inject = ['agents']

/**
 * Mount the tower/mode emission driver.
 * @param {import('@deepseek-ai/cordis').Context} ctx - composition context.
 */
export function apply(ctx) {
  let emitted = false
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (!emitted && agent.session.header.parentSession === undefined) {
      emitted = true
      agent.session.append('tower/mode', { active: true, base: 'main' })
    }
    return next()
  })
}
