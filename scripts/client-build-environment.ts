import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export {
  CLIENT_BUILD_RECORD_PATH,
  CLIENT_DIST_PATH,
  assertClientBuildEnvironment,
  clientDistDigest,
  readClientBuildRecord,
  verifyClientDistAgainstBuildRecord,
  writeClientBuildRecord,
} from '../packages/host/frontend-static/src/client-build-record.ts'
export type {
  ClientArtifactDigest,
  ClientBuildRecord,
  ClientDistConsistency,
} from '../packages/host/frontend-static/src/client-build-record.ts'

/** Prefix reserved for build-time values that may be embedded in browser artifacts. */
const CLIENT_BUILD_ENV_PREFIX = 'DSH_CLIENT_'

/** Non-public selector used by build orchestration to request a named client profile. */
export const CLIENT_BUILD_PROFILE_SELECTOR = 'DSH_BUILD_CLIENT_PROFILE'

/** Public client environment required by official DSH artifacts. */
const OFFICIAL_CLIENT_BUILD_ENVIRONMENT = {
  DSH_CLIENT_BUILD_PROFILE: 'official',
  DSH_CLIENT_TITLE: 'DeepSeek Harness',
} as const

/** Public variable carrying the source commit embedded in client artifacts. */
const CLIENT_COMMIT_HASH_VARIABLE = 'DSH_CLIENT_COMMIT_HASH'

/** Public variable carrying the repository package version embedded in client artifacts. */
const CLIENT_VERSION_VARIABLE = 'DSH_CLIENT_VERSION'

/**
 * Resolve the short source commit used by browser build metadata.
 * @param root - repository root used when no explicit value is supplied.
 * @param environment - environment that may already carry a commit value.
 * @returns lowercase 7-character Git commit prefix.
 */
export function repositoryCommitHash(root: string, environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment[CLIENT_COMMIT_HASH_VARIABLE]
  const value = explicit ?? execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!/^[0-9a-f]{7,40}$/iu.test(value)) {
    throw new Error(`${CLIENT_COMMIT_HASH_VARIABLE} must be a Git commit hash; got ${JSON.stringify(value)}`)
  }
  return value.slice(0, 7).toLowerCase()
}

/**
 * Resolve the repository package version used by browser build metadata.
 * @param root - repository root containing the authoritative package.json.
 * @returns the repository's semver-compatible package version.
 */
export function repositoryVersion(root: string): string {
  const path = resolve(root, 'package.json')
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read repository version from ${path}: ${detail}`)
  }
  if (!isObject(manifest) || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`repository package.json has an invalid version ${JSON.stringify(isObject(manifest) ? manifest.version : undefined)}`)
  }
  return manifest.version
}

/**
 * Read whether Git reports any staged, unstaged, untracked, or submodule change.
 * @param root - repository root whose worktree is inspected.
 * @returns true or false inside a Git worktree; undefined without Git metadata.
 */
export function repositoryGitDirty(root: string): boolean | undefined {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (probe.error !== undefined || probe.status !== 0 || probe.stdout.trim() !== 'true') return undefined

  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (status.error !== undefined) throw status.error
  if (status.status !== 0) {
    throw new Error(`git status failed in ${root}: ${status.stderr.trim() || String(status.status)}`)
  }
  return status.stdout !== ''
}

/**
 * Resolve the public environment for a complete default build from one checkout.
 * Repository-owned metadata replaces inherited values; other public values pass through.
 * @param root - repository root supplying version and Git metadata.
 * @param environment - caller environment supplying optional commit and public extensions.
 * @returns complete public client environment for the default build.
 */
export function repositoryClientBuildEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): ClientBuildEnvironment {
  const inherited = { ...clientBuildEnvironment(environment) }
  delete inherited.DSH_CLIENT_COMMIT_HASH
  delete inherited.DSH_CLIENT_GIT_DIRTY
  delete inherited.DSH_CLIENT_VERSION
  const dirty = repositoryGitDirty(root)
  return {
    ...inherited,
    DSH_CLIENT_COMMIT_HASH: repositoryCommitHash(root, environment),
    ...(dirty === true ? { DSH_CLIENT_GIT_DIRTY: 'true' } : {}),
    DSH_CLIENT_VERSION: repositoryVersion(root),
  }
}

/**
 * Resolve the exact public values required by an official build at one commit.
 * @param root - repository root whose HEAD must match the built source.
 * @param environment - optional explicit commit source for non-Git build environments.
 * @returns complete official client environment.
 */
export function officialClientBuildEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<`DSH_CLIENT_${string}`, string>> {
  return {
    DSH_CLIENT_COMMIT_HASH: repositoryCommitHash(root, environment),
    DSH_CLIENT_VERSION: repositoryVersion(root),
    ...OFFICIAL_CLIENT_BUILD_ENVIRONMENT,
  }
}

/** Public values embedded in one set of client artifacts. */
export type ClientBuildEnvironment = Readonly<Record<string, string>>

/**
 * Collect the public client environment in deterministic key order.
 * @param environment - environment inherited by the build process.
 * @returns defined `DSH_CLIENT_*` values only.
 */
function clientBuildEnvironment(environment: NodeJS.ProcessEnv): ClientBuildEnvironment {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name, value]) => name.startsWith(CLIENT_BUILD_ENV_PREFIX) && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>
}

/**
 * Resolve the exact public environment selected for a complete client build.
 * @param environment - parent process environment.
 * @param profile - explicit profile, or the non-public selector when omitted.
 * @returns the inherited public values when no profile is selected, otherwise the named profile.
 */
export function resolveClientBuildEnvironment(
  environment: NodeJS.ProcessEnv,
  profile: string | undefined = environment[CLIENT_BUILD_PROFILE_SELECTOR],
): ClientBuildEnvironment {
  if (profile === undefined) return clientBuildEnvironment(environment)
  if (profile === 'official') {
    const commitHash = environment[CLIENT_COMMIT_HASH_VARIABLE]
    const version = environment[CLIENT_VERSION_VARIABLE]
    if (commitHash === undefined) {
      throw new Error(`${CLIENT_COMMIT_HASH_VARIABLE} is required for the official client build profile`)
    }
    if (version === undefined) {
      throw new Error(`${CLIENT_VERSION_VARIABLE} is required for the official client build profile`)
    }
    return {
      DSH_CLIENT_COMMIT_HASH: commitHash,
      DSH_CLIENT_VERSION: version,
      ...OFFICIAL_CLIENT_BUILD_ENVIRONMENT,
    }
  }
  throw new Error(`unknown client build profile ${JSON.stringify(profile)}; expected "official"`)
}

/**
 * Construct a subprocess environment containing exactly the selected public values.
 * @param environment - parent process environment.
 * @param clientEnvironment - complete public environment selected for the build.
 * @returns the parent environment with selectors and inherited public values replaced.
 */
export function clientBuildProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  clientEnvironment: ClientBuildEnvironment,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (name === CLIENT_BUILD_PROFILE_SELECTOR || name.startsWith(CLIENT_BUILD_ENV_PREFIX)) continue
    child[name] = value
  }
  return { ...child, ...clientEnvironment }
}

/**
 * Create bundler substitutions for public client build environment variables.
 *
 * The empty `process.env` fallback makes an unset static property read
 * evaluate to `undefined` without providing a browser `process` global.
 * Exact substitutions remain longer matches than that fallback. Dynamic
 * property reads and enumeration deliberately observe the empty object.
 *
 * @param environment - environment inherited by the build process.
 * @returns deterministic Vite/tsdown `define` expressions.
 */
export function clientBuildEnvironmentDefines(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const defines: Record<string, string> = { 'process.env': '{}' }
  for (const [name, value] of Object.entries(clientBuildEnvironment(environment))) {
    defines[`process.env.${name}`] = JSON.stringify(value)
  }
  return defines
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
