/**
 * The `.tower/` coordination store: zod-validated durable records under the
 * workspace git root. `workspace.json` and `missions/m-<n>.json` are whole
 * JSON documents replaced atomically (temporary file plus rename);
 * `findings.jsonl`, `messages.jsonl`, `activity.jsonl`, and
 * `reviews/m-<n>.jsonl` are append-only journals. Every read validates
 * against the record schema and fails loud with the file path on corruption —
 * the workspace files are the single cross-session authority, so a torn or
 * hand-edited record must never parse silently.
 *
 * @module @deepseek-ai/dsh-tower-local/store
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TowerFindingId, TowerMissionId } from '@deepseek-ai/dsh-tower/types'
import type {
  TowerActivityEntry,
  TowerFinding,
  TowerMessage,
  TowerMission,
  TowerMissionStatus,
  TowerReviewRound,
  TowerWorkspace,
} from '@deepseek-ai/dsh-tower/types'
import { TowerLocalError } from './error.ts'

const missionIdSchema = z.string().min(1).transform(value => TowerMissionId(value))
const findingIdSchema = z.string().min(1).transform(value => TowerFindingId(value))
const sessionIdSchema = z.string().min(1).transform(value => SessionId(value))

const missionStatusSchema: z.ZodType<TowerMissionStatus> = z.enum([
  'spawning', 'active', 'interrupted', 'approved', 'merged', 'failed', 'aborted',
])

const missionSchema = z.strictObject({
  id: missionIdSchema,
  title: z.string(),
  prompt: z.string(),
  base: z.string(),
  branch: z.string(),
  worktree: z.string(),
  status: missionStatusSchema,
  owner: sessionIdSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) as z.ZodType<TowerMission>

const workspaceSchema = z.strictObject({
  version: z.literal(1),
  base: z.string(),
  root: z.string(),
  createdAt: z.string(),
}) as z.ZodType<TowerWorkspace>

const findingSchema = z.strictObject({
  id: findingIdSchema,
  title: z.string(),
  body: z.string(),
  author: z.string(),
  time: z.string(),
}) as z.ZodType<TowerFinding>

const messageSchema = z.strictObject({
  id: z.string().min(1),
  from: z.string(),
  to: z.string(),
  content: z.string(),
  time: z.string(),
}) as z.ZodType<TowerMessage>

const activityKindSchema = z.enum([
  'init', 'adopt', 'spawn', 'review', 'merge', 'abort', 'message', 'finding', 'teardown',
])

const activitySchema = z.strictObject({
  time: z.string(),
  kind: activityKindSchema,
  actor: z.string(),
  mission: missionIdSchema.optional(),
  detail: z.string(),
}) as z.ZodType<TowerActivityEntry>

const reviewSchema = z.strictObject({
  round: z.number().int().positive(),
  verdict: z.enum(['approve', 'reject']),
  commit: z.string().min(1),
  summary: z.string(),
  reviewer: z.string(),
  time: z.string(),
}) as z.ZodType<TowerReviewRound>

const MISSION_FILE_PATTERN = /^m-(\d+)\.json$/
const FINDING_ID_PATTERN = /^f-(\d+)$/

/** Numeric suffix of one filtered mission filename. */
function missionFileNumber(file: string): number {
  const match = MISSION_FILE_PATTERN.exec(file)
  /* v8 ignore next 2 -- the filename filter admits only matching names */
  if (match === null) return 0
  return Number(match[1])
}

/** Numeric suffix of one finding id; non-`f-<n>` ids count as zero. */
function findingIdNumber(id: string): number {
  const match = FINDING_ID_PATTERN.exec(id)
  return match === null ? 0 : Number(match[1])
}

/** Parse one journal line or whole document, attributing corruption to its path. */
function parseJson(path: string, text: string, position: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error: unknown) {
    throw new TowerLocalError(`corrupt store record at ${path}${position}: invalid JSON`, 'TOWER_LOCAL', { cause: error })
  }
}

/** Validate one parsed record, attributing schema drift to its path. */
function parseRecord<S>(path: string, position: string, schema: z.ZodType<S>, value: unknown): S {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    /* v8 ignore next 2 -- a failed safeParse always carries at least one issue */
    if (issue === undefined) throw new TowerLocalError(`corrupt store record at ${path}${position}`)
    const detail = `${issue.path.join('.')} ${issue.message}`.trim()
    throw new TowerLocalError(`corrupt store record at ${path}${position}: ${detail}`)
  }
  return result.data
}

/** Read one whole JSON document; `undefined` when the file does not exist. */
async function readJsonDocument<S>(path: string, schema: z.ZodType<S>): Promise<S | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseRecord(path, '', schema, parseJson(path, text, ''))
}

/** Read one append-only journal; empty when the file does not exist. */
async function readJsonl<S>(path: string, schema: z.ZodType<S>): Promise<S[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return parseJournal(path, text, schema)
}

/** Synchronous journal read for the invariant companion's commit-time check. */
function readJsonlSync<S>(path: string, schema: z.ZodType<S>): S[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return parseJournal(path, text, schema)
}

/** Validate every non-blank line of one journal text. */
function parseJournal<S>(path: string, text: string, schema: z.ZodType<S>): S[] {
  const records: S[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue
    const position = ` line ${index + 1}`
    records.push(parseRecord(path, position, schema, parseJson(path, line, position)))
  }
  return records
}

/** Replace one whole JSON document through a temporary file plus rename. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/** Append one journal line, creating the parent directory on first use. */
async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * File access for one workspace's `.tower/` directory. Instances are cheap
 * path calculators; all durability rules live in the module functions above.
 */
export class TowerStore {
  /**
   * Bind a store to one git root.
   * @param root - absolute path of the git work tree owning `.tower/`.
   */
  constructor(readonly root: string) {}

  /** The `.tower/` directory itself. */
  get dir(): string {
    return join(this.root, '.tower')
  }

  /** Absolute path of the workspace record. */
  get workspacePath(): string {
    return join(this.dir, 'workspace.json')
  }

  /** Absolute path of the findings journal. */
  get findingsPath(): string {
    return join(this.dir, 'findings.jsonl')
  }

  /** Absolute path of the messages journal. */
  get messagesPath(): string {
    return join(this.dir, 'messages.jsonl')
  }

  /** Absolute path of the activity journal. */
  get activityPath(): string {
    return join(this.dir, 'activity.jsonl')
  }

  /** Directory holding one JSON document per mission. */
  get missionsDir(): string {
    return join(this.dir, 'missions')
  }

  /** Directory holding one review journal per mission. */
  get reviewsDir(): string {
    return join(this.dir, 'reviews')
  }

  /** Directory under which mission worktrees are created. */
  get worktreesDir(): string {
    return join(this.dir, 'worktrees')
  }

  /** Absolute path of one mission record. */
  missionPath(id: TowerMissionId): string {
    return join(this.missionsDir, `${id}.json`)
  }

  /** Absolute path of one mission's review journal. */
  reviewsPath(id: TowerMissionId): string {
    return join(this.reviewsDir, `${id}.jsonl`)
  }

  /** Whether the `.tower/` directory exists at all. */
  exists(): boolean {
    return existsSync(this.dir)
  }

  /** Create the directory layout of a fresh workspace. */
  async ensureLayout(): Promise<void> {
    await mkdir(this.missionsDir, { recursive: true })
    await mkdir(this.reviewsDir, { recursive: true })
    await mkdir(this.worktreesDir, { recursive: true })
  }

  /** Read the workspace record, or `undefined` when never written. */
  async readWorkspace(): Promise<TowerWorkspace | undefined> {
    return readJsonDocument(this.workspacePath, workspaceSchema)
  }

  /** Atomically replace the workspace record. */
  async writeWorkspace(workspace: TowerWorkspace): Promise<void> {
    await writeJsonAtomic(this.workspacePath, workspace)
  }

  /**
   * Read every mission record in creation order. Allocation scans filenames,
   * so a stray non-mission file is ignored and a corrupt mission file fails
   * loud instead of being skipped.
   */
  async listMissions(): Promise<TowerMission[]> {
    const files = await this.missionFiles()
    const missions: TowerMission[] = []
    for (const file of files) {
      const mission = await readJsonDocument(join(this.missionsDir, file), missionSchema)
      /* v8 ignore else -- the filename scan only lists existing files */
      if (mission !== undefined) missions.push(mission)
    }
    return missions
  }

  /** Read one mission record, or `undefined` when absent. */
  async readMission(id: TowerMissionId): Promise<TowerMission | undefined> {
    return readJsonDocument(this.missionPath(id), missionSchema)
  }

  /** Atomically replace one mission record. */
  async writeMission(mission: TowerMission): Promise<void> {
    await writeJsonAtomic(this.missionPath(mission.id), mission)
  }

  /** Allocate the next monotonic mission id from the filename scan. */
  async nextMissionId(): Promise<TowerMissionId> {
    const last = (await this.missionFiles()).at(-1)
    return TowerMissionId(`m-${last === undefined ? 1 : missionFileNumber(last) + 1}`)
  }

  /** Append one finding and return nothing; ids allocate from the parsed journal. */
  async appendFinding(finding: TowerFinding): Promise<void> {
    await appendJsonl(this.findingsPath, finding)
  }

  /** Read every finding in recording order. */
  async readFindings(): Promise<TowerFinding[]> {
    return readJsonl(this.findingsPath, findingSchema)
  }

  /** Allocate the next monotonic finding id from the parsed journal. */
  async nextFindingId(): Promise<TowerFindingId> {
    let max = 0
    for (const finding of await this.readFindings()) {
      const n = findingIdNumber(finding.id)
      if (n > max) max = n
    }
    return TowerFindingId(`f-${max + 1}`)
  }

  /** Append one message to the journal. */
  async appendMessage(message: TowerMessage): Promise<void> {
    await appendJsonl(this.messagesPath, message)
  }

  /** Read every recorded message in recording order. */
  async readMessages(): Promise<TowerMessage[]> {
    return readJsonl(this.messagesPath, messageSchema)
  }

  /** Append one activity entry. */
  async appendActivity(entry: TowerActivityEntry): Promise<void> {
    await appendJsonl(this.activityPath, entry)
  }

  /** Read the whole activity journal in recording order. */
  async readActivity(): Promise<TowerActivityEntry[]> {
    return readJsonl(this.activityPath, activitySchema)
  }

  /** Append one review round to a mission's journal. */
  async appendReview(id: TowerMissionId, round: TowerReviewRound): Promise<void> {
    await appendJsonl(this.reviewsPath(id), round)
  }

  /** Read every review round of one mission in recording order. */
  async readReviews(id: TowerMissionId): Promise<TowerReviewRound[]> {
    return readJsonl(this.reviewsPath(id), reviewSchema)
  }

  /** Synchronous review read for the invariant companion's commit-time check. */
  readReviewsSync(id: TowerMissionId): TowerReviewRound[] {
    return readJsonlSync(this.reviewsPath(id), reviewSchema)
  }

  /** Mission filenames matching `m-<n>.json`, sorted by their numeric suffix. */
  private async missionFiles(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.missionsDir)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter(entry => MISSION_FILE_PATTERN.test(entry))
      .sort((a, b) => missionFileNumber(a) - missionFileNumber(b))
  }
}
