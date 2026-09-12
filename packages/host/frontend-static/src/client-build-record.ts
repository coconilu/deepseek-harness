/**
 * Client build record: the durable binding between the public client build
 * environment and the exact client artifacts one complete root build produced.
 * The module lives beside the SPA dist server because the server owns the
 * consistency contract of the frontend it serves; build orchestration writes
 * the record through this module, and release tooling re-verifies through it.
 */

import { createHash } from 'node:crypto'
import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Repository-relative path of the complete client build record. */
export const CLIENT_BUILD_RECORD_PATH = '.dsh-build/client-build-environment.json'

/** Record schema version; a structural change invalidates every existing record. */
const CLIENT_BUILD_RECORD_FORMAT = 2

/** Repository-relative frontend dist directory whose served contents the record's `dist` digest covers. */
export const CLIENT_DIST_PATH = 'apps/web/dist'

/** Complete set of artifacts affected by the public client environment. */
const CLIENT_ARTIFACT_PATTERNS = [
  'apps/web/dist/**/*',
  'packages/*/*/lib/client.js',
  'packages/*/*/lib/client.js.map',
] as const

/** Public values embedded in one set of client artifacts. */
export type ClientBuildEnvironment = Readonly<Record<string, string>>

/** Digest of one set of client artifacts. */
export interface ClientArtifactDigest {
  /** Number of files covered by the digest. */
  readonly fileCount: number
  /** Lowercase SHA-256 digest of sorted paths and file contents. */
  readonly sha256: string
}

/** Durable description of one complete root client build. */
export interface ClientBuildRecord {
  /** Record schema version. */
  readonly formatVersion: number
  /** Exact public environment embedded by Vite and tsdown. */
  readonly environment: ClientBuildEnvironment
  /** Digest that binds the environment to every client artifact. */
  readonly artifacts: ClientArtifactDigest
  /** Digest of the frontend dist alone, so a server can verify what it serves without repository-layout knowledge. */
  readonly dist: ClientArtifactDigest
}

/**
 * Outcome of comparing a frontend dist against the client build record that
 * applies to it. Every outcome is data, so the caller owns the presentation.
 */
export type ClientDistConsistency =
  | { readonly status: 'consistent'; readonly recordPath: string; readonly commitHash: string | undefined }
  | { readonly status: 'missing-record' }
  | { readonly status: 'unreadable-record'; readonly recordPath: string; readonly detail: string }
  | { readonly status: 'dist-unreadable'; readonly recordPath: string; readonly detail: string }
  | { readonly status: 'dist-mismatch'; readonly recordPath: string; readonly commitHash: string | undefined }

/**
 * Write the build record after a complete root build succeeds.
 * @param root - repository root containing the generated artifacts.
 * @param environment - exact public environment supplied to both bundlers.
 * @returns the record written to disk.
 */
export function writeClientBuildRecord(
  root: string,
  environment: ClientBuildEnvironment,
): ClientBuildRecord {
  const dist = clientDistDigest(resolve(root, CLIENT_DIST_PATH))
  if (dist.fileCount === 0) throw new Error('complete client build produced no frontend dist artifacts')
  const record: ClientBuildRecord = {
    formatVersion: CLIENT_BUILD_RECORD_FORMAT,
    environment: normalizeClientEnvironment(environment),
    artifacts: clientArtifactDigest(root),
    dist,
  }
  const path = resolve(root, CLIENT_BUILD_RECORD_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/**
 * Read a complete build record and prove it still describes the current artifacts.
 * @param root - repository root containing the record and generated artifacts.
 * @param expected - optional exact public environment required by a consumer.
 * @returns the parsed and artifact-verified record.
 */
export function readClientBuildRecord(
  root: string,
  expected?: Readonly<Record<`DSH_CLIENT_${string}`, string>>,
): ClientBuildRecord {
  const path = resolve(root, CLIENT_BUILD_RECORD_PATH)
  if (!existsSync(path)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} is missing; run a complete pnpm run build first`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} is invalid JSON: ${detail}`)
  }
  const record = parseClientBuildRecord(parsed)
  if (expected !== undefined) assertClientBuildEnvironment(record.environment, expected)

  const current = clientArtifactDigest(root)
  if (current.fileCount !== record.artifacts.fileCount || current.sha256 !== record.artifacts.sha256) {
    throw new Error(
      `client artifacts differ from ${CLIENT_BUILD_RECORD_PATH}; run a complete pnpm run build before consuming them`,
    )
  }
  const dist = clientDistDigest(resolve(root, CLIENT_DIST_PATH))
  if (dist.fileCount !== record.dist.fileCount || dist.sha256 !== record.dist.sha256) {
    throw new Error(
      `frontend dist differs from ${CLIENT_BUILD_RECORD_PATH}; run a complete pnpm run build before consuming it`,
    )
  }
  return record
}

/**
 * Verify the frontend dist about to be served against the client build record
 * nearest to it. The record is discovered by walking up from the dist root, so
 * a dist served outside any build tree finds no record and the check stays
 * silent instead of failing; an existing record that no longer describes the
 * dist is exactly the silent-stale-code state this check exists to expose.
 * @param distRoot - absolute frontend dist root a server is about to serve.
 * @returns the comparison outcome; never throws — a record that cannot be
 * parsed and a dist that cannot be walked (a file vanishing between listing
 * and stat, a dangling link) are data outcomes like any other.
 */
export function verifyClientDistAgainstBuildRecord(distRoot: string): ClientDistConsistency {
  const recordPath = findClientBuildRecordPath(distRoot)
  if (recordPath === undefined) return { status: 'missing-record' }

  let record: ClientBuildRecord
  try {
    record = parseClientBuildRecord(JSON.parse(readFileSync(recordPath, 'utf8')))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { status: 'unreadable-record', recordPath, detail }
  }
  const commitHash = record.environment.DSH_CLIENT_COMMIT_HASH
  let served: ClientArtifactDigest
  try {
    served = clientDistDigest(distRoot)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { status: 'dist-unreadable', recordPath, detail }
  }
  if (served.fileCount !== record.dist.fileCount || served.sha256 !== record.dist.sha256) {
    return { status: 'dist-mismatch', recordPath, commitHash }
  }
  return { status: 'consistent', recordPath, commitHash }
}

/**
 * Digest the frontend dist on disk: dist-root-relative paths and contents, so
 * a server can recompute the record's `dist` digest from the directory it
 * serves without knowing the repository layout.
 * @param distRoot - absolute frontend dist directory to digest.
 * @returns the digest of every file under the dist root.
 */
export function clientDistDigest(distRoot: string): ClientArtifactDigest {
  return digestFiles(distRoot, listFiles(distRoot, ['**/*']))
}

/** Return the nearest ancestor record path, or undefined when no ancestor carries one. */
function findClientBuildRecordPath(distRoot: string): string | undefined {
  let dir = resolve(distRoot)
  for (;;) {
    const candidate = resolve(dir, CLIENT_BUILD_RECORD_PATH)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Return the deterministic digest of every artifact affected by the public client environment. */
function clientArtifactDigest(root: string): ClientArtifactDigest {
  const paths = listFiles(root, CLIENT_ARTIFACT_PATTERNS)
  if (paths.length === 0) throw new Error('complete client build produced no Vite or dynamic client artifacts')
  return digestFiles(root, paths)
}

/** Return every file matching the patterns, as sorted `/`-separated paths relative to the base. */
function listFiles(baseDir: string, patterns: readonly string[]): string[] {
  return globSync([...patterns], { cwd: baseDir })
    .map(path => path.replaceAll('\\', '/'))
    .filter(path => statSync(resolve(baseDir, path)).isFile())
    .sort()
}

/** Hash sorted paths and their contents into one artifact digest. */
function digestFiles(baseDir: string, paths: readonly string[]): ClientArtifactDigest {
  const digest = createHash('sha256')
  for (const path of paths) {
    const content = readFileSync(resolve(baseDir, path))
    digest.update(`${Buffer.byteLength(path)}:`)
    digest.update(path)
    digest.update(`${content.byteLength}:`)
    digest.update(content)
  }
  return { fileCount: paths.length, sha256: digest.digest('hex') }
}

/**
 * Require the record environment to match an artifact profile exactly.
 *
 * An exact key set matters because every prefixed value is eligible for
 * inlining: an unexpected variable can change published bytes just as surely
 * as a missing or incorrect required value.
 *
 * @param environment - public environment from a build process or build record.
 * @param expected - complete public client environment for the artifact profile.
 */
export function assertClientBuildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  expected: Readonly<Record<`DSH_CLIENT_${string}`, string>>,
): void {
  const actual = Object.fromEntries(Object.entries(environment)
    .filter(([name, value]) => name.startsWith('DSH_CLIENT_') && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)))
  const normalizedExpected = Object.fromEntries(Object.entries(expected)
    .sort(([left], [right]) => left.localeCompare(right)))
  if (JSON.stringify(actual) === JSON.stringify(normalizedExpected)) return

  const names = [...new Set([...Object.keys(actual), ...Object.keys(normalizedExpected)])].sort()
  const differences = names.filter(name => actual[name] !== normalizedExpected[name])
  throw new Error(`client build environment differs from the required artifact profile: ${differences.join(', ')}`)
}

/** Return the public client environment in deterministic key order. */
function normalizeClientEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => name.startsWith('DSH_CLIENT_'))
    .sort(([left], [right]) => left.localeCompare(right)))
}

/** Parse and validate the persisted record before any consumer trusts it. */
function parseClientBuildRecord(value: unknown): ClientBuildRecord {
  if (!isObject(value)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid top-level schema`)
  }
  // The format check precedes the key check: a real legacy record lacks the
  // keys this format added, and its remedy must name the format, not the schema.
  if (value.formatVersion !== CLIENT_BUILD_RECORD_FORMAT) {
    throw new Error(
      `client build record ${CLIENT_BUILD_RECORD_PATH} uses format ${String(value.formatVersion)}; expected ${String(CLIENT_BUILD_RECORD_FORMAT)}`
        + '; run a complete pnpm run build to regenerate it',
    )
  }
  if (!hasExactKeys(value, ['artifacts', 'dist', 'environment', 'formatVersion'])) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid top-level schema`)
  }
  if (!isObject(value.environment)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid environment`)
  }
  const environment: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value.environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (!name.startsWith('DSH_CLIENT_') || typeof entry !== 'string') {
      throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid environment entry ${name}`)
    }
    environment[name] = entry
  }
  return {
    formatVersion: CLIENT_BUILD_RECORD_FORMAT,
    environment,
    artifacts: parseArtifactDigest(value.artifacts, 'artifact'),
    dist: parseArtifactDigest(value.dist, 'dist'),
  }
}

/** Parse and validate one recorded digest. */
function parseArtifactDigest(value: unknown, label: string): ClientArtifactDigest {
  if (!isObject(value) || !hasExactKeys(value, ['fileCount', 'sha256'])) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid ${label} digest`)
  }
  if (!Number.isSafeInteger(value.fileCount) || Number(value.fileCount) < 1) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid ${label} count`)
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid ${label} SHA-256 digest`)
  }
  return {
    fileCount: Number(value.fileCount),
    sha256: value.sha256,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
