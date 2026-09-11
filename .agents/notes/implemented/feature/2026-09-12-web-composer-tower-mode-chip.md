# Agent Note: Web composer Tower-mode chip

Status: implemented

English | [中文](2026-09-12-web-composer-tower-mode-chip.zh.md)

## Problem

Running `/tower` gave the web composer no visible sign that tower mode was in force. The mode is a log-only `tower/mode` session event folded by the host `tower` projection, so the folded state already reached the browser through the generic projection channel, but nothing rendered it; users could not tell which sessions carried tower authority. A display surface had to derive from the persisted projection without adding client-side folding, client-side state, or a model-visible input.

## Decision

`ui-conversation` renders a display-only Tower status chip in the composer's modes row, between the Access trigger and the plan seat. The chip reads the generic `useProjection('tower')` seat and follows the projection's effective target (`pending ? !active : active`), so an in-flight `/tower on` already shows the chip and a leaving selection already hides it. While active it shows the localized `Tower` label with the recorded base branch (`Tower · master`) and a tooltip; an inactive mode, and an absent tower capability (no projection value) render nothing, and a projection without a base keeps the label and the plain tooltip.

The chip is conversation-owned composer chrome like the Access trigger, not a separate feature plugin: it is pure presentation with no behavior, so it needs no command channel, store, or slot seat of its own. Copy lives in the `conversation` locale dictionary (zh and en).

The `tower` key became client-typable: the `tower` projection types and their `SessionProjectionMap`/`SessionProjectionStateMap` merges moved out of the `@deepseek-ai/dsh-tower` host entry into a `src/projection.ts` leaf. `types.ts` re-exports the leaf for host consumers and keeps the `ctx.tower` Context declaration — the `./types` face is the contract provider packages compile against — while the new pure `./client` face (`export type * from './projection.ts'`) serves client programs, keeping the host Context merge out of client compilations ("one program must not hold both sides").

## Alternatives considered

**A dedicated `ui-tower` plugin occupying a new composer seat.** The plan chip's shape, but it costs a new package plus a web-app bundle registration to deliver a chip with no behavior. Conversation already owns projection-fed composer chrome (the Access trigger), so the chip lives there instead; if the chip ever executes `/tower off` or opens a menu, it moves to its own plugin and seat.

**Declaring the projection merge in client code.** Re-stating the `tower` merge inside `ui-conversation` would type `useProjection('tower')` without touching the tower package, but it gives the fact a second home and lets the wire view drift from the host fold. Widening the tower package with the projection leaf is the fix that keeps one owner.

**Deriving the mode from raw `tower/mode` events in the conversation fold.** The Conversation Node discipline would allow it, but it re-implements the host fold client-side; the projection already ships the folded whole value, and a second fold is a second place to keep correct.

## Consequences

The chip appears on every session whose folded tower projection is active, including historical sessions replayed from a log that activated tower mode. Sessions without tower capability keep the row unchanged, so recorded web expectations that never activate tower mode are unaffected. The `./client` face adds one export to `@deepseek-ai/dsh-tower`'s published surface; it is types-only, so no runtime payload grows. Any client package can now type `useProjection('tower')`, and the tower package keeps the merge as the fact's single home.
