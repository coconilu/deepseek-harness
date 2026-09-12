# Agent Note: Cross-client activity lights the blank shell

Status: implemented

English | [中文](2026-09-12-cross-client-activity-lights-blank-shell.zh.md)

## Problem

[The command-result blank-shell fix](2026-09-11-command-result-blank-shell-visibility.md) restored the render path for a command submitted locally and recorded the remaining limitation: a command executed by another client (CLI, ACP) against a session this browser holds blank never brought the transcript on screen. The mechanism behind that limitation is target activation. Conversation assembly materializes target snapshots only for targets in the monotonic active set, and that set grew from exactly two triggers — shell view selection and a target source's first subscriber. A session whose consumer never mounted therefore had zero active targets: the external events arrived and Definitions matched them, but `activityTargets()` stayed empty and the shell phase stayed `blank`, so `ConversationSession` went on rendering null. Activation is also what makes activity classification possible at all — only a materialized snapshot can be asked `isActive`.

## Decision

The Assembler now activates targets from session activity itself. [`ConversationNodeAssembler.activateWithoutConsumers()`](../../../../packages/client/ui-conversation/src/client/conversation/assembler.ts) adds every defined view target to the active set when activity has landed (the event window is non-empty) and no target is active yet; the per-Session binding calls it — `engageConsumerless` in [the Conversation binding feed](../../../../packages/client/ui-conversation/src/client/conversation/assembly.ts) — after every replace, prepend, append, and Assistant settlement, so the same flush materializes the first snapshots. Activation stays monotonic and activity-triggered: a session that receives no events is never activated and keeps the hero, and a session that receives its first event pays the activation once, exactly as shell selection would have. What counts as visible activity remains owned by each target's `isActive`; the Chat rules from the command-result fix apply unchanged, so a textless lifecycle settlement keeps the hero even though the target is now active.

## Alternatives considered

**Activate targets when a session binds.** The command-result fix already rejected this for eager per-session builder work and for severing shell activity from a user gesture, and a binding's initially empty window proves nothing. Activity-triggered activation charges only sessions that actually receive events.

**Flip the host list's blank bit when a command settles.** That is a host-side protocol addition that changes blank semantics shared with connectWorkspace reuse eligibility, and activity classification would stay client-side regardless. The remaining list-visibility gap for sessions this browser does not hold current is tracked separately.

**Lower the client Session's blank bit when durable events arrive.** The client mirror follows the host summary's authority (blank = no logged turn/start), and lowering it locally would diverge the mirror without fixing the shell — the shell leaves blank through target activity, not through the Session bit.

## Consequences

Activity another client produces against a session this browser holds — a settled command with a visible result, or any model-turn node — now reaches the shell without a mounted consumer: the transcript leaves the blank phase on the first classified activity and renders the durable rows, errors included, exactly as a local submission would. Sessions that receive no activity behave exactly as before, and the submission-local engagement edge stays the first-paint path for local sends. The residual gap moves rather than disappears: a held blank session that is not the current selection still has no channel to learn about command-only activity (the host list has no live push for it, and the workspace tree hides blank summaries), so its transcript becomes reachable once the session is selected.

## Testing

The Conversation registry tests pin all four edges: a consumer-less binding lights the shell on external `command/run` plus `command/done` (error with text), a textless success settlement keeps the blank phase, binding or an empty window alone never activates a target, and a shell-selected target still lights on external activity ([conversation-registry.client.spec.ts](../../../../packages/client/ui-conversation/tests/conversation-registry.client.spec.ts)). The command-result fix's suites — the command runtime engage edge, the Chat activity classification, and the goal-command browser case — remain the coverage for the submission-local path.

## Related

[Command results engage the blank shell](2026-09-11-command-result-blank-shell-visibility.md) owns the submission-local engagement edge and the Chat activity rules this note relies on; [Client Conversation node assembly](../architecture/2026-08-09-client-conversation-node-assembly.md) owns the active-target set and View Builder mechanics this note extends.
