# Agent Note: The Cordis config gate resolves degraded git symlinks

Status: implemented

English | [中文](2026-09-12-cordis-config-gate-degraded-symlinks.zh.md)

## Problem

`verify-cordis-config` read every discovered Loader configuration with a literal working-tree read. On a Windows checkout with `core.symlinks=false` — the default without Developer Mode — git materializes a recorded symlink as a plain text file whose content is the link target, so the gate parsed the target path of `apps/cli/tests/profiles/acp/cordis.yml` as YAML and failed with "root must be a Loader entry array". That fixture is a symlink by design: it shares the recorded ACP snapshot composition under `snapshots/acp/escalation-approved/` instead of duplicating it. Every Windows local gate run was therefore red on an otherwise-valid checkout while symlink-capable CI stayed green, and the diagnostic named YAML structure rather than the checkout state that caused it.

## Decision

The gate treats the git index as the authority on which paths are symlinks. One `git ls-files -s --literal-pathspecs` call over the discovered config files collects the index mode `120000` records ([`gitIndexSymlinks`](../../../../scripts/verify-cordis-config.ts)); the index records the link kind even where the checkout degraded it. Every config is then read through `readLoaderConfigText`: a real symlink is read through `readFileSync`, which follows it; an index-symlink path whose working tree holds a regular file is a degraded record — its content is the recorded target, resolved against the record's directory exactly as a symlink would resolve, chained through further degraded records up to 16 hops. A degraded record whose target cannot be resolved is reported through the gate's normal error list with re-checkout guidance (`git config core.symlinks true`, then re-checkout the file) instead of surfacing as a misleading parse failure.

The platform semantics stay identical to CI by construction: following the recorded target reproduces the read `readFileSync` performs on every symlink-capable platform, so discovery, entry validation, and the dependency closures validate the same bytes locally as on CI. A git that is unavailable or fails yields no index records and the gate reads every file literally — the previous behavior, still loud on the fixture that started this.

## Alternatives considered

**Replace the fixture symlink with a copy.** Rejected: it duplicates the snapshot composition, every future edit must land twice or the two drift, and it repairs one fixture while leaving the mechanism broken for the next symlinked config. The symlink is what keeps the test profile and the recorded snapshot in sync.

**Fail loud with guidance on every degraded record, never follow.** Rejected as the primary behavior: Windows developers would stay red on an otherwise-valid checkout with no local remedy short of privileged re-checkout. Guidance-only failure is kept for the unresolvable case, where following is impossible.

**Classify by content shape alone (a single line that resolves to an existing YAML file).** Rejected: git index mode is authoritative, while a content heuristic can misclassify a genuinely scalar-valued configuration and can silently validate the wrong file after an accidental link-text commit.

## Consequences

Windows checkouts without symlink support run the gate green and validate the same composition bytes as CI; the diagnostic for a genuinely broken checkout names the checkout state and the remedy. The gate spawns one read-only git subprocess per run, and a missing or failing git degrades to the literal read rather than a new hard requirement. `loadEntries` — the preset-plane-separation reader — still reads literally; all of its inputs are regular files today and are also validated by the main scan loop, so a config there would need the same treatment only if it ever becomes a symlink.
