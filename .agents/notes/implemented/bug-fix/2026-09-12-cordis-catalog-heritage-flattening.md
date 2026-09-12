# Agent Note: The Cordis catalog flattens interface heritage onto the service surface

Status: implemented

English | [中文](2026-09-12-cordis-catalog-heritage-flattening.zh.md)

## Problem

The generated Cordis catalogs list each `ctx.<key>` service's methods from the Service Definition's declared members only. A Service Definition that composes its contract through `extends` therefore catalogs incomplete: `ctx.tower` is typed by `TowerService extends TowerOperations`, where the non-exported `TowerOperations` interface declares twelve of the fourteen operations a caller can invoke. The model-facing runtime catalog (`packages/extensions/tool-cordis/src/api-catalog.ts`, served through `cordis_inspect`) showed only `registerProvider` and `mode`, and the generated region on `docs/subsystems/tower.md` did the same, while the page's hand-maintained type-equivalence block documented the twelve shared operations separately. Nothing in the generator or its docs declares the omission intentional, and the runtime catalog's own banner claims it cannot diverge from the rendered docs.

## Decision

The Cordis catalog projection (`collectServices` in `packages/typert/generator/src/cordis-catalog.ts`) now walks the Service Definition's interface `extends` chain and lists inherited members before the declared ones; a declared member suppresses inherited members of the same name, and overload sets — declared and inherited alike — stay intact. Inherited members pass the same JSDoc-completeness and type-link gates as declared ones. The walk resolves only same-face interface declarations: a harness service class's base is framework plumbing (`Service`, `TypertRemoteService`) whose members belong to the inherited tier ([inherited.md](../../../../docs/cordis-api/inherited.md)), and cross-face or external heritage is documented by its declaring catalog, so both skip. `ctx.tower`'s catalog entry lists the twelve shared operations, then `registerProvider` and `mode`; `TowerProvider` implementations inherit the same walk.

The regenerated artifacts are `packages/extensions/tool-cordis/src/api-catalog.ts` plus the generated regions on the tower subsystems page pair. The hand-maintained "shared operations" block on that page remains the explanation of the seam's design; the generated region is the mechanical member listing.

## Alternatives considered

**Keep the projection declared-members-only and document the shared operations by hand.** This was the shipped state. It makes the model-facing catalog degrade silently whenever a Service Definition composes through `extends`, and it is the one place where the generated catalog and the rendered docs disagreed in coverage.

**Flatten class heritage too.** Callable inherited members are part of a class-typed service's surface, but every catalogued service class extends framework bases whose members are either already skipped (`typertRemote`) or covered by the inherited tier; flattening would add framework plumbing to every class service without a concrete consumer.

**Flatten in the analyzer instead of the catalog projection.** `ServiceModel.members` feeds remote-endpoint modeling as well as the catalog, and "what the catalog documents" is a projection decision the projector already owns (JSDoc and type-link gates live there). Moving the walk into the analyzer would change a shared model for one consumer's need.

## Consequences

A Service Definition can no longer hide operations from the catalogs by declaring them on a base interface, and the tower runtime catalog now answers operation questions (signatures, caller authority, result types) without the docs. Type-link coverage and JSDoc completeness now apply to inherited members, so a future heritage-declared member without contract prose fails `gen-cordis-catalog` instead of rendering bare. The heritage walk follows the analyzer's recorded `extends` nodes, so it adds no second type resolution. `packages/typert/generator/tests/cordis-catalog.spec.ts` pins the flattened `ctx.tower` member order alongside the byte-for-byte artifact reproduction.

## Related

The generated runtime catalog's single-AST provenance is owned by [the self-referential cordis toolset note](../feature/2026-07-08-self-referential-cordis-toolset.md); this change closes its one coverage divergence.
