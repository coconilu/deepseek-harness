/**
 * Acceptance-path coverage for the config-catalog schema walker's object
 * forms: `z.strictObject({…})` must contribute key paths exactly like
 * `z.object({…})` (top level and nested), while any other builder hanging
 * off no walkable base call still fails the gate instead of thinning the
 * catalog silently.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConfigCatalog } from './gen-config-catalog.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Write one minimal workspace package manifest plus its source files. */
function writePackage(root: string, dir: string, name: string, files: Record<string, string>): void {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name }))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dir, rel, '..'), { recursive: true })
    writeFileSync(join(root, dir, rel), content)
  }
}

describe('config-catalog schema walker object forms', () => {
  it('admits z.strictObject key paths at the top level and nested, validated against the declared type', () => {
    const root = mkdtempSync(join(tmpdir(), 'gen-config-catalog-'))
    roots.push(root)
    writePackage(root, 'packages/fixture/strict', '@deepseek-ai/dsh-fixture-strict', {
      'src/index.ts': [
        "import { z } from 'zod'",
        '',
        '/** One nested strict group. */',
        'export interface Nested {',
        '  /** Nested depth. */',
        '  depth: number',
        '}',
        '',
        '/** Plugin config. */',
        'export interface Config {',
        '  /** The child provider name. */',
        '  childProvider: string',
        '  /** Maximum entries. */',
        '  activityTail: number',
        '  /** Nested strict group. */',
        '  nested: Nested',
        '}',
        '',
        'export const Config = z.strictObject({',
        "  childProvider: z.string().min(1).default('spawn'),",
        '  activityTail: z.number().int().positive().default(50),',
        '  nested: z.strictObject({ depth: z.number() }),',
        '})',
        '',
        'export function apply(_ctx: unknown, _config: Config): void {}',
        '',
      ].join('\n'),
    })
    const entries = collectConfigCatalog(root)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('config')
    expect(entries[0]?.schemaKeys).toEqual(['childProvider', 'activityTail', 'nested', 'nested.depth'])
  })

  it('still hard-errors on a builder that is neither object/intersect/union nor chained to one', () => {
    const root = mkdtempSync(join(tmpdir(), 'gen-config-catalog-'))
    roots.push(root)
    writePackage(root, 'packages/fixture/record', '@deepseek-ai/dsh-fixture-record', {
      'src/index.ts': [
        "import { z } from 'zod'",
        '',
        '/** Plugin config. */',
        'export type Config = Record<string, string>',
        '',
        'export const Config = z.record(z.string())',
        '',
        'export function apply(_ctx: unknown, _config: Config): void {}',
        '',
      ].join('\n'),
    })
    expect(() => collectConfigCatalog(root)).toThrow(
      /schema call 'record' is not object\/intersect and hangs off no walkable base call/,
    )
  })
})
