/**
 * The verify-cordis-config metadata contract: `disabled` is the one entry
 * metadata field whose `!!js` expression the Loader interpolates; every other
 * metadata field must stay static, and a disabled expression must parse.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bundleManifestPaths,
  bundlePluginDependencyErrors,
  gitIndexSymlinks,
  metadataExpressionErrors,
  packageTestFixtureDependencyErrors,
  packageTestPluginDependencyErrors,
  readLoaderConfigText,
} from './verify-cordis-config.ts'

describe('verify-cordis-config metadata expressions', () => {
  it('accepts a disabled !!js expression', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
      '[0]',
    )
    expect(problems).toEqual([])
  })

  it('rejects an expression in a static metadata field', () => {
    const problems = metadataExpressionErrors({ id: { __jsExpr: 'process.platform' }, name: 'pkg' }, '[0]')
    expect(problems).toContain('[0].id: !!js is not interpolated here')
  })

  it('rejects an expression nested below disabled (only the field itself interpolates)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { when: { __jsExpr: 'process.platform' } } },
      '[0]',
    )
    expect(problems).toContain('[0].disabled.when: !!js is not interpolated here')
  })

  it('rejects a disabled expression that does not parse (the loader would fail the boot)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { __jsExpr: 'process.platform ===' } },
      '[0]',
    )
    expect(problems.some(problem => problem.includes('[0].disabled: disabled expression does not parse'))).toBe(true)
  })
})

describe('workspace Bundle discovery and product dependency closures', () => {
  it('discovers a Bundle outside packages/bundle from its manifest declaration', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-bundle-discovery-'))
    try {
      const bundleDir = join(fixture, 'packages/subagent/example')
      const plainDir = join(fixture, 'packages/bundle/plain')
      mkdirSync(bundleDir, { recursive: true })
      mkdirSync(plainDir, { recursive: true })
      writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-subagent-example',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      writeFileSync(join(plainDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-plain',
      }))

      expect(bundleManifestPaths(fixture)).toEqual([
        'packages/subagent/example/package.json',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('allows a Bundle to mount itself but rejects an undeclared plugin package', () => {
    const manifestPath = 'packages/subagent/example/package.json'
    const file = 'packages/subagent/example/cordis.patch.yml'
    const manifest = {
      name: '@deepseek-ai/dsh-subagent-example',
      dependencies: {},
    }
    const self = { file, name: '@deepseek-ai/dsh-subagent-example' }
    expect(bundlePluginDependencyErrors(manifestPath, manifest, [self])).toEqual([])
    expect(bundlePluginDependencyErrors(manifestPath, manifest, [
      self,
      { file, name: '@deepseek-ai/dsh-missing-plugin' },
    ])).toEqual([
      `${file}: @deepseek-ai/dsh-missing-plugin must be declared in ${manifestPath} dependencies`,
    ])
  })
})

describe('package-owned Loader test dependency closures', () => {
  it('requires package test configs to declare each named plugin they load', () => {
    const manifestPath = 'packages/example/owner/package.json'
    const file = 'packages/example/owner/tests/fixtures/cordis.yml'
    const manifest = {
      name: '@deepseek-ai/dsh-owner',
      dependencies: {},
      devDependencies: {
        '@deepseek-ai/dsh-declared': 'workspace:^',
      },
    }
    expect(packageTestPluginDependencyErrors(manifestPath, manifest, [
      { file, name: '@deepseek-ai/dsh-owner' },
      { file, name: '@deepseek-ai/dsh-declared' },
      { file, name: '@deepseek-ai/dsh-missing' },
    ])).toEqual([
      `${file}: @deepseek-ai/dsh-missing must be declared in ${manifestPath} dependencies or devDependencies`,
    ])
  })

  it('requires executable package test fixtures to declare their bare imports', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-package-test-entrypoint-'))
    try {
      const packageDir = join(fixture, 'packages/example/owner')
      const driverDir = join(packageDir, 'tests/fixtures/loader')
      mkdirSync(driverDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-owner',
        devDependencies: {
          '@deepseek-ai/dsh-declared': 'workspace:^',
        },
      }))
      writeFileSync(join(driverDir, 'driver.ts'), [
        "import '@deepseek-ai/dsh-owner'",
        "import '@deepseek-ai/dsh-declared'",
        "import '@deepseek-ai/dsh-missing'",
      ].join('\n'))
      writeFileSync(join(driverDir, 'cordis.yml'), '[]\n')
      writeFileSync(join(driverDir, 'fixture.mjs'), "import '@deepseek-ai/dsh-declared'\n")
      const unrelatedDir = join(packageDir, 'tests/fixtures/unrelated')
      mkdirSync(unrelatedDir, { recursive: true })
      writeFileSync(join(unrelatedDir, 'driver.ts'), "import '@deepseek-ai/dsh-unrelated'\n")

      expect(packageTestFixtureDependencyErrors(fixture)).toEqual([
        'packages/example/owner/tests/fixtures/loader/driver.ts: '
        + '@deepseek-ai/dsh-missing must be declared in '
        + 'packages/example/owner/package.json dependencies or devDependencies',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('fails loud when package-owned Loader fixtures disappear from the scan', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-empty-package-test-entrypoint-'))
    try {
      expect(packageTestFixtureDependencyErrors(fixture)).toEqual([
        'package test fixture dependency scan found no package-owned Loader configs',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

describe('Loader config reads on degraded symlink checkouts', () => {
  it('reads an ordinary file literally even when its content looks like a link target', () => {
    const fixture = symlinkFixture()
    try {
      const read = readLoaderConfigText(fixture, 'profiles/acp.cordis.yml', new Set())
      expect(read).toEqual({ text: '../snapshots/acp.cordis.yml' })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('follows a degraded git symlink to its recorded target', () => {
    const fixture = symlinkFixture()
    try {
      const read = readLoaderConfigText(
        fixture,
        'profiles\\acp.cordis.yml',
        new Set(['profiles/acp.cordis.yml']),
      )
      expect(read).toEqual({ text: '- name: target\n' })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('follows a chain of degraded records through intermediate links', () => {
    const fixture = symlinkFixture()
    writeFileSync(join(fixture, 'profiles/acp.cordis.yml'), './middle.cordis.yml')
    writeFileSync(join(fixture, 'profiles/middle.cordis.yml'), '../snapshots/acp.cordis.yml')
    try {
      const read = readLoaderConfigText(fixture, 'profiles/acp.cordis.yml', new Set([
        'profiles/acp.cordis.yml',
        'profiles/middle.cordis.yml',
      ]))
      expect(read).toEqual({ text: '- name: target\n' })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('fails loud when a degraded record cannot be resolved', () => {
    const fixture = symlinkFixture()
    writeFileSync(join(fixture, 'profiles/acp.cordis.yml'), '../../snapshots/missing.cordis.yml')
    try {
      const read = readLoaderConfigText(fixture, 'profiles/acp.cordis.yml', new Set(['profiles/acp.cordis.yml']))
      expect('problem' in read && read.problem.includes('core.symlinks')).toBe(true)
      expect('problem' in read && read.problem.includes('../../snapshots/missing.cordis.yml')).toBe(true)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

describe('git index symlink discovery', () => {
  it('reports the symlink fixtures this repository records in its index', () => {
    expect(gitIndexSymlinks(resolve(import.meta.dirname, '..'), [
      'apps/cli/tests/profiles/acp/cordis.yml',
      'apps/cli/tests/profiles/acp/tests/acp.e2e.ts',
    ])).toEqual(new Set(['apps/cli/tests/profiles/acp/cordis.yml']))
  })

  it('reports nothing when git cannot describe the tree', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-git-index-symlinks-'))
    try {
      expect(gitIndexSymlinks(fixture, ['cordis.yml'])).toEqual(new Set())
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

/** Working tree with a snapshots target and a plain-text degraded link record. */
function symlinkFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-cordis-config-read-'))
  const target = join(fixture, 'snapshots/acp.cordis.yml')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, '- name: target\n')
  const link = join(fixture, 'profiles/acp.cordis.yml')
  mkdirSync(dirname(link), { recursive: true })
  writeFileSync(link, '../snapshots/acp.cordis.yml')
  return fixture
}
