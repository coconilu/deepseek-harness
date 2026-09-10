/**
 * The provider's git engine: every repository operation runs through
 * `ctx.subprocess` as an explicit argv vector (never a shell string), with
 * complete in-memory stdout/stderr collection — the `runRipgrep` pattern.
 * Nonzero exits throw a {@link TowerLocalError} carrying the command and an
 * output excerpt; spawn and provider failures propagate from the subprocess
 * seam unchanged.
 *
 * @module @deepseek-ai/dsh-tower-local/git
 */

import { normalize } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { TowerLocalError } from './error.ts'

/** Stdout cap for one git invocation; git output here is refs, tips, and short diagnostics. */
const GIT_STDOUT_MAX_BYTES = 1024 * 1024
/** Stderr tail cap retained for the failure excerpt. */
const GIT_STDERR_MAX_BYTES = 64 * 1024
/** Terminate-escalation grace for one git process. */
const GIT_GRACE_MS = 5_000
/** Failure excerpt length cap inside error messages. */
const EXCERPT_MAX = 500

/** Failure excerpt: stderr when present, else stdout (merge conflicts report on stdout). */
function excerpt(result: GitRun): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(0, EXCERPT_MAX)
}

/** Raw outcome of one finished git invocation. */
export interface GitRun {
  /** Complete collected stdout. */
  readonly stdout: string
  /** Complete collected stderr tail. */
  readonly stderr: string
  /** Exit code; null when a signal killed the process. */
  readonly exitCode: number | null
  /** Terminating signal; null on a normal exit. */
  readonly signal: NodeJS.Signals | null
}

/**
 * Explicit-argv git access for one subprocess provider. Instances are cheap;
 * the executable resolution memoizes on first use so a missing git fails at
 * the first operation instead of at plugin load.
 */
export class GitEngine {
  private gitPath: Promise<string> | undefined

  /**
   * Bind the engine to one subprocess runtime.
   * @param subprocess - the execution world git runs in.
   */
  constructor(private readonly subprocess: SubprocessRuntime) {}

  /** The resolved git executable, memoized across operations. */
  private git(): Promise<string> {
    this.gitPath ??= this.subprocess.resolveExecutable('git')
    return this.gitPath
  }

  /**
   * Run git with explicit argv and return the raw outcome without
   * classifying it. Spawn and provider failures reject from the seam.
   * @param argv - git arguments, each model/record value one unquoted element.
   * @param cwd - working directory of the invocation.
   * @param signal - optional caller cancellation forwarded to the process range.
   * @returns exit facts plus collected stdout and stderr.
   */
  async run(argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitRun> {
    const handle = this.subprocess.spawn({
      argv: [await this.git(), ...argv],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: GIT_STDOUT_MAX_BYTES },
        stderr: { maxBytes: GIT_STDERR_MAX_BYTES },
      },
      graceMs: GIT_GRACE_MS,
      signal,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    /* v8 ignore next 3 -- the collect dispositions above guarantee both readers */
    if (stdout === undefined || stderr === undefined) {
      throw new TowerLocalError('git subprocess produced no collected output streams')
    }
    return { stdout: stdout.text, stderr: stderr.text, exitCode: outcome.exitCode, signal: outcome.signal }
  }

  /**
   * Run git to a required zero exit and return trimmed stdout.
   * @param argv - git arguments.
   * @param cwd - working directory of the invocation.
   * @param signal - optional caller cancellation.
   * @returns trimmed stdout.
   * @throws {@link TowerLocalError} with an output excerpt on signal or nonzero exit.
   */
  async runOk(argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
    const result = await this.run(argv, cwd, signal)
    /* v8 ignore next 3 -- a signal-killed git cannot be scheduled deterministically in tests */
    if (result.signal !== null) {
      throw new TowerLocalError(`git ${argv.join(' ')} killed by ${result.signal} in ${cwd}: ${excerpt(result)}`)
    }
    if (result.exitCode !== 0) {
      throw new TowerLocalError(`git ${argv.join(' ')} failed (exit ${result.exitCode}) in ${cwd}: ${excerpt(result)}`)
    }
    return result.stdout.trim()
  }

  /**
   * Absolute git work-tree root containing `cwd` (`rev-parse --show-toplevel`).
   * Spawn failures propagate from the subprocess seam; a nonzero exit means
   * `cwd` is outside any work tree.
   * @param cwd - any directory to probe.
   * @param signal - optional caller cancellation.
   * @returns the normalized toplevel path.
   * @throws {@link TowerLocalError} `NO_GIT` when `cwd` is outside a work tree.
   */
  async showToplevel(cwd: string, signal?: AbortSignal): Promise<string> {
    const result = await this.run(['rev-parse', '--show-toplevel'], cwd, signal)
    if (result.exitCode !== 0) {
      throw new TowerLocalError(`"${cwd}" is not inside a git work tree: ${result.stderr.trim().slice(0, EXCERPT_MAX)}`, 'NO_GIT')
    }
    return normalize(result.stdout.trim())
  }

  /**
   * Absolute shared git directory of the repository containing `cwd`
   * (`rev-parse --path-format=absolute --git-common-dir`): the main
   * checkout's `.git` from any linked worktree.
   * @param cwd - any directory inside the repository.
   * @returns the normalized absolute common dir.
   */
  async commonDir(cwd: string): Promise<string> {
    return normalize(await this.runOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd))
  }

  /**
   * Whether `name` resolves to a local branch (`show-ref --verify refs/heads/<name>`);
   * remote-tracking refs and tags live under other namespaces and read false.
   * @param root - repository root to probe.
   * @param name - the candidate branch name.
   * @returns true exactly for an existing local branch.
   */
  async verifyLocalBranch(root: string, name: string): Promise<boolean> {
    const result = await this.run(['show-ref', '--verify', `refs/heads/${name}`], root)
    return result.exitCode === 0
  }

  /**
   * Create `<worktree>` on a new branch `branch` forking `base` (`worktree add -b`).
   * @param root - main checkout root.
   * @param worktree - absolute target path.
   * @param branch - new branch name (`tower/<id>`).
   * @param base - existing local branch to fork.
   */
  async addWorktree(root: string, worktree: string, branch: string, base: string): Promise<void> {
    await this.runOk(['worktree', 'add', worktree, '-b', branch, base], root)
  }

  /**
   * Tip commit of a local branch (`rev-parse refs/heads/<branch>`).
   * @param root - repository root.
   * @param branch - local branch name.
   * @returns the full commit hash.
   */
  async branchTip(root: string, branch: string): Promise<string> {
    return this.runOk(['rev-parse', `refs/heads/${branch}`], root)
  }

  /**
   * Tip commit of the checkout at `root` (`rev-parse HEAD`).
   * @param root - checkout to probe.
   * @returns the full commit hash.
   */
  async headTip(root: string): Promise<string> {
    return this.runOk(['rev-parse', 'HEAD'], root)
  }

  /**
   * Branch the checkout at `root` sits on (`rev-parse --abbrev-ref HEAD`);
   * `HEAD` while detached.
   * @param root - checkout to probe.
   * @returns the abbreviated branch name.
   */
  async currentBranch(root: string): Promise<string> {
    return this.runOk(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  }

  /**
   * Merge `branch` into the current checkout with a merge commit
   * (`merge --no-ff --no-edit`, so the default message never opens an editor).
   * @param root - main checkout root.
   * @param branch - mission branch to merge.
   */
  async mergeNoFf(root: string, branch: string): Promise<void> {
    await this.runOk(['merge', '--no-ff', '--no-edit', branch], root)
  }

  /**
   * Remove one worktree (`worktree remove`, optionally `--force`). A locked
   * worktree still refuses, which teardown reports instead of overriding.
   * @param root - main checkout root.
   * @param worktree - absolute worktree path.
   * @param force - override uncommitted content.
   */
  async removeWorktree(root: string, worktree: string, force: boolean): Promise<void> {
    await this.runOk(['worktree', 'remove', ...(force ? ['--force'] : []), worktree], root)
  }

  /**
   * Delete a local branch unconditionally (`branch -D`); spawn rollback only.
   * @param root - repository root.
   * @param branch - branch to delete.
   */
  async deleteBranch(root: string, branch: string): Promise<void> {
    await this.runOk(['branch', '-D', branch], root)
  }

  /**
   * Whether the worktree at `worktree` has uncommitted changes
   * (`status --porcelain`).
   * @param worktree - worktree to probe.
   * @returns true when any tracked or untracked change is present.
   */
  async isDirty(worktree: string): Promise<boolean> {
    return (await this.runOk(['status', '--porcelain'], worktree)).length > 0
  }
}
