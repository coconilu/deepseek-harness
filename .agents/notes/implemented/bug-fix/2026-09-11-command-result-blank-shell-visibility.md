# Agent Note: Command results engage the blank shell

Status: implemented

English | [中文](2026-09-11-command-result-blank-shell-visibility.zh.md)

## Problem

An admitted slash command's only visible outcome is its durable lifecycle: the host executor logs `command/run` plus `command/done`, and the composer deliberately never echoes the result. The web client folds those events into a command Chat node, but on a fresh session the node never reached the screen. A command submission did not flip the Session's blank→engaged edge (`promptAttempted` is set only by the model-prompt path), the session-list blank relay has no live push for command-only activity, and while the shell stays in the `blank` phase `ConversationSession` renders null — so the assembled node, an error result's `Usage:` text included, was never drawn. `/goal` escaped this only because ui-goal contributes a separate non-command `command-input` node that activates the Chat view; a generic command such as `/tower on` returned its error with no UI change at all, which read as the command doing nothing.

## Decision

Three pieces restore the render path. The command execute transaction engages the session like a prompt: `engageSubmission` in [the command UI runtime](../../../../packages/client/ui-commands/src/client/service.ts) registers a submission echo and retires it in the same tick — the edge latches, and because no durable user message will ever observe a command's submission identity, the echo leaves before it can paint. The Chat target's shell-activity check in [`chatViewDefinition`](../../../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts) counts a settled command that carries a visible result — an error outcome, or a success with text — so a command-only transcript also leaves the blank phase when history loads; a textless lifecycle settlement keeps the hero. A command row whose outcome is an error with text is a disclosure ([GenericCommandCard](../../../../packages/client/ui-chat/src/client/chat/GenericCommandCard.tsx)), keeping the full settlement text reachable when the one-line red summary ellipsizes.

## Alternatives considered

**Surface handler errors as composer notices.** The notice channel already carries admission failures, so reusing it for handler errors is a small change. It gives transient feedback where the product's decision is a persistent flow row, it says nothing about success results, and it double-reports on sessions where the row does render.

**Activate the Chat target when a session binds.** Eager activation would advance the view builder for every bound session, including ones the reader never opened a transcript for, and it severs shell activity from a user gesture. The submit-time edge keeps the engagement tied to the submission itself.

**Push the blank bit from the host when it changes.** A new live list event would close the same gap from the wire side, but it is a host-side protocol addition for a fact the client already knows at submission time.

## Consequences

A command submission docks the composer and shows the transcript on a fresh session exactly like a prompt, and the durable row — success or error — is the persistent, reload-surviving outcome surface. The composer stays silent for admitted commands, as designed, and sessions whose only command settled without text keep the hero. The engagement edge remains submission-local by design; the cross-client path this left open — another client's command on a session this browser holds blank — is closed by [Cross-client activity lights the blank shell](2026-09-12-cross-client-activity-lights-blank-shell.md), which activates view targets from session activity without a mounted consumer.

## Testing

The command-runtime unit tests pin the engage-and-abandon edge for the claimed and detached paths plus the unbound-session skip ([service.client.spec.ts](../../../../packages/client/ui-commands/tests/service.client.spec.ts)); the Chat node tests pin shell activity for error-with-text, success-with-text, bare-success, and running nodes ([conversation-node-definitions.client.spec.ts](../../../../packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts)) and the error disclosure ([chat-view.client.spec.tsx](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx)); a keyless browser case whose first submission is `/feedback` asserts the acknowledgement row, the active phase, the cleared draft, and no model turn ([goal-command-presentation.e2e.ts](../../../../apps/web/tests/goal-command-presentation.e2e.ts)).

## Related

The shell phase derivation and the `blank`/`engaging`/`active` phases belong to the Conversation skeleton; node assembly into target snapshots is recorded in [Client Conversation node assembly](../architecture/2026-08-09-client-conversation-node-assembly.md).
