# Agent Note: Shared fixed-record tool output declarations live in dsh-tools

Status: implemented

English | [中文](2026-09-12-shared-json-tool-output-declaration.zh.md)

## Problem

Tool consumers that return one fixed record per call each hand-wrote the same output declaration: the canonical value schema paired with a compact-JSON `render`. `experimental/tool-agent-team` and `tower/tool-tower` carried byte-identical `jsonOutput` copies, and the second copy shipped with a `jscpd:ignore` exemption plus a deferred note pointing at a future shared export. Every additional tool consumer would copy the idiom again, and the exemption pinned a duplicate into the codebase the duplication gate exists to catch.

## Decision

`@deepseek-ai/dsh-tools` exports `jsonOutput(schema)` beside `ToolOutputDefinition` and `defineTool`: it returns the `output` declaration whose `schema` is the declared value schema and whose `render` emits one lossless compact-JSON text block. `experimental/tool-agent-team` and `tower/tool-tower` import it; both local copies, the `jscpd:ignore` exemption, and its deferred comment are gone. The package pair already depended on dsh-tools, so the extraction adds no dependency edge, workspace package, or aggregate tsconfig reference.

## Alternatives considered

**A shared helper in `packages/util/`.** The util group's entries are capability-agnostic mechanical primitives; a `jsonOutput` export would import `ValueSchemaSpec`/`InferValue` and `ToolOutputDefinition` vocabulary, dragging the tool-registry domain into a group that owns none of it, and a new package would additionally need aggregate tsconfig and lockfile registration for zero semantic gain.

**Keep the two packages decoupled with the exemption.** The status quo duplicated one helper across two consumers and encoded the debt as an ignored clone; the reviewers' gate could no longer see the duplication it was written to suppress.

**Leave inline `render` per tool.** Consumers without the fixed-record shape (pretty-printed JSON, custom content) keep hand-written renders; only the fixed-record idiom is centralized.

## Consequences

The tool-schema DSL vocabulary and the output-declaration contract now share one owner, so new tool consumers adopt the fixed-record declaration through their existing dsh-tools dependency. The jscpd exemption budget shrinks by one; the remaining `jscpd:ignore` blocks in dsh-tools cover unrelated parallels. `packages/core/tools/tests/tools.spec.ts` pins the render contract, and the duplication gate runs without relying on any exemption in the two consumers. Reaching this home required widening the mission scope beyond `packages/util/`; the extraction itself changed no behavior.
