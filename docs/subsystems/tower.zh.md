# Tower

[English](tower.md) | 中文

tower 模式是记录到日志的协作状态：一个 lead 会话把工作以 **mission** 为单位分派出去——每个 mission 在自己从记录 base 分出的隔离 git worktree 中运行，通过居中传达的消息与共享发现同 lead 交流，并且只在评审门禁通过后合并回来。它是由三个包组成的能力缝：Service Definition [dsh-tower](../../packages/tower/tower) 拥有 `ctx.tower` 与记录的模式，Service Provider [dsh-tower-local](../../packages/tower/tower-local) 拥有 `.tower/` 存储、git 与 mission 子代理，Consumer [dsh-tool-tower](../../packages/tower/tool-tower) 拥有十个面向模型的 `tower_*` 工具。[设计说明](../../.agents/notes/implemented/feature/2026-09-11-tower-capability.zh.md)负责决策依据；包 README 负责模型体验与配置细节。它与 [Agent Teams](agent-team.zh.md) 不同，后者在单一共享 checkout 中协作子代理、不带 git 语义。

源文件：[`packages/tower/tower/src/types.ts`](../../packages/tower/tower/src/types.ts)、[`packages/tower/tower/src/index.ts`](../../packages/tower/tower/src/index.ts) 与 [`packages/tower/tower-local/src/provider.ts`](../../packages/tower/tower-local/src/provider.ts)

## 记录的模式与 `/tower` 命令

`tower/mode`（`{ active: boolean; base?: string }`）是 log-only、整值替换的[会话事件](session.zh.md)：持久且可重放，从不进入模型转录，最后一次落盘的值获胜。注册的 `tower` [投影](session-projection.zh.md)单元把该事件与 `/tower` 命令运行一起折叠，因此 resume、fork 与 compaction 仅凭日志即可恢复模式，客户端载体读取裁剪后的 `{ active, pending, base? }` wire 视图。`/tower on <base>` 在任何事件落盘前先经选定的 provider 校验 base，因此拼写错误不会落盘任何内容；`/tower off`、`/tower status` 与幂等重选是命令层 no-op。由于每条会话事件都被回合封闭，回合进行中做出的选择保持 pending，直到下一个被接受的回合内 pre-step 把它写入——这是 agent 运行期间唯一的落盘点——落盘失败不会阻塞步骤，选择留待稍后尝试。`wanted`/`running` 两个折叠字段追踪的正是落盘失败与进行中的待生效选择这两种状态。模式激活——或已有待生效的激活选择——时，服务把部署的 `section` 文本渲染为 `tower:policy` [提示词段落](system-prompt.zh.md)；只有组合了 [ctx.commands](commands.zh.md) 时命令子代理才会激活。

## 工作区与 mission

tower 工作区是一个带有 `.tower/` 协调存储与记录 base 分支的 git work tree。mission 是委派工作的单位；provider 按工作区以 `m-<n>` 单调分配 id，并把分支命名为 `tower/<id>`。

```ts type-equiv
/** The durable workspace record at `.tower/workspace.json`. */
interface TowerWorkspace {
  /** Physical format version of the workspace record. */
  readonly version: 1
  /** The local branch missions fork from and merge back into. */
  readonly base: string
  /** Absolute path of the git worktree root that owns `.tower/`. */
  readonly root: string
  /** ISO-8601 creation time of the first initialization. */
  readonly createdAt: string
}
```

```ts type-equiv
/**
 * One mission's lifecycle. `spawning` becomes `active` at initial inbox
 * acceptance or `failed` when provisioning rolls back; a review `reject`
 * returns the mission to `active` for rework while `approve` marks it
 * `approved`; only `approved` can merge. `interrupted` marks a spawning or
 * active mission whose owner session is no longer live at workspace
 * adoption; its branch and worktree survive for review and merge.
 */
type TowerMissionStatus =
  | 'spawning'
  | 'active'
  | 'interrupted'
  | 'approved'
  | 'merged'
  | 'failed'
  | 'aborted'
```

```ts type-equiv
/** The durable mission record, one JSON document per mission. */
interface TowerMission {
  /** Stable mission identity, allocated monotonically as `m-<n>` per workspace. */
  readonly id: TowerMissionId
  /** Short model-authored mission title. */
  readonly title: string
  /** The complete task text the mission child receives. */
  readonly prompt: string
  /** The base branch the mission forked and merges back into. */
  readonly base: string
  /** The mission branch, `tower/<id>`. */
  readonly branch: string
  /** Absolute path of the mission's git worktree. */
  readonly worktree: string
  readonly status: TowerMissionStatus
  /** The mission child's durable session id; absent until the initial prompt is accepted. */
  readonly owner?: SessionId
  /** ISO-8601 creation and last-mutation timestamps. */
  readonly createdAt: string
  readonly updatedAt: string
}
```

mission 记录存在于任何会话日志之外：它们跨越会话与进程，工作区接管——对 base 一致的既有存储再执行一次 `init`——会带上未合并的 mission，并把 owner 已不存活的 `spawning`/`active` mission 对账为 `interrupted`。仪表盘行在读取时用 owner 存活性与评审门禁状态（`TowerMissionView`）丰富记录，`status`/`init`/`spawnMission` 返回这些丰富后的视图而不是原始记录。

## 评审、发现与消息

```ts type-equiv
/** One review round on a mission branch, appended per verdict. */
interface TowerReviewRound {
  /** One-based round number, monotonic per mission. */
  readonly round: number
  readonly verdict: 'approve' | 'reject'
  /** The mission branch tip the reviewer examined. */
  readonly commit: string
  /** Model-authored review summary. */
  readonly summary: string
  /** Who reviewed: `lead` or a mission id. */
  readonly reviewer: string
  /** ISO-8601 recording time. */
  readonly time: string
}
```

```ts type-equiv
/** A shared finding any tower participant records for the others. */
interface TowerFinding {
  readonly id: TowerFindingId
  readonly title: string
  readonly body: string
  /** Who recorded it: `lead` or a mission id. */
  readonly author: string
  /** ISO-8601 recording time. */
  readonly time: string
}
```

```ts type-equiv
/** One lead-mediated message, retained in the workspace activity record. */
interface TowerMessage {
  /** Globally random message identity. */
  readonly id: string
  /** Sender: `lead` or a mission id. */
  readonly from: string
  /** Address: `lead`, one mission id, or `all` for every live mission. */
  readonly to: string
  readonly content: string
  /** ISO-8601 recording time. */
  readonly time: string
}
```

```ts type-equiv
/** One entry of the workspace's append-only activity record. */
interface TowerActivityEntry {
  /** ISO-8601 recording time. */
  readonly time: string
  readonly kind:
    | 'init'
    | 'adopt'
    | 'spawn'
    | 'review'
    | 'merge'
    | 'abort'
    | 'message'
    | 'finding'
    | 'teardown'
  /** Who acted: `lead` or a mission id. */
  readonly actor: string
  /** The mission concerned, when any. */
  readonly mission?: TowerMissionId
  /** Short single-line detail. */
  readonly detail: string
}
```

每项操作都会追加一条活动条目，本地 provider 在提交时刻通过 `tower-local/activity` [Cordis 事件](../cordis-primer.zh.md#dispatch-modes)同步发出每一条，观察者因此看到 journal 顺序。`recordReview` 把 mission 当时的 branch tip 钉进评审轮次；`approve` 把 mission 移到 `approved`，`reject` 把它退回 `active` 重做。

## 评审门禁与合并

任一条件不满足时合并都会响亮拒绝：mission 必须处于 `approved`、最近一轮评审必须是批准且其记录的 commit 仍等于 branch tip、mission worktree 必须干净、主 checkout 必须停在记录的 base 上。门禁随后以 `--no-ff` 合并、记录合并 commit、移除 mission worktree、把 mission 记为 `merged`；迟来的失败之后重试是安全的，因为 git 会报告 up-to-date 状态、门禁重新通过。tip 一致条件让评审结论只适用于确切的 commit：评审后的任何改动都会让 mission 重新进入评审。合并侧契约还受 provider 不变式伴生入口监视，它会让没有针对确切 commit 的批准评审轮次支撑的合并活动条目失败。

## 服务契约

`ctx.tower` 拥有记录的模式、provider 注册表与调用者权限校验；权限通过后，每项操作都委托给配置指定的 provider。`init`、`spawnMission`、`abortMission`、`recordReview`、`merge` 与 `teardown` 仅限 lead——调用会话必须处于激活的 tower 模式。`status`、`sendMessage`、`inbox`、`recordFinding` 与 `listFindings` 额外放行已记录的 mission 拥有者——这是一项读取 mission 记录的持久检查，冷 resume 后依然有效。`spawnMission` 超出配置的 mission 上限时响亮拒绝，`/tower` 的选择状态也走上文描述的同一套 pending 落盘机制。

```ts type-equiv
/**
 * The tower capability published as `ctx.tower`. The service owns the logged
 * mode, provider registry, and caller-authority validation; every operation
 * delegates to the provider selected by Config once authority passes. The
 * contract lives on the `./types` face so provider packages compile against
 * contracts alone.
 *
 * Authority: `init`, `spawnMission`, `abortMission`, `recordReview`, `merge`,
 * and `teardown` are lead-only — the caller's session must carry active tower
 * mode. `status`, `sendMessage`, `inbox`, `recordFinding`, and
 * `listFindings` additionally admit recorded mission owners.
 */
interface TowerService {
  /**
   * Register one backend under its {@link TowerProvider.name}. The
   * registration is an owned effect: disposing the caller's fiber removes it.
   * @param provider - the backend to publish.
   */
  registerProvider(provider: TowerProvider): void
  /**
   * Read the logged tower mode of `agent`'s session.
   * @param agent - the session-owning Agent.
   * @returns the committed mode and base.
   */
  mode(agent: Agent): TowerModeState
  /**
   * Create or adopt the caller's workspace (lead-only).
   * @param caller - exact live lead Agent.
   * @returns the workspace and adoption facts.
   */
  init(caller: Agent): Promise<TowerWorkspaceInfo>
  /**
   * Read the tower dashboard (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @returns the current dashboard.
   */
  status(caller: Agent): Promise<TowerDashboard>
  /**
   * Spawn one mission in an isolated worktree (lead-only); refuses loudly
   * beyond the configured mission bound.
   * @param caller - exact live lead Agent.
   * @param request - title, complete task prompt, and caller cancellation.
   * @returns the active mission row.
   */
  spawnMission(caller: Agent, request: TowerSpawnRequest): Promise<TowerMissionView>
  /**
   * Interrupt a mission's live child and mark it `aborted` (lead-only).
   * @param caller - exact live lead Agent.
   * @param id - the mission to abort.
   * @returns the updated mission row.
   */
  abortMission(caller: Agent, id: TowerMissionId): Promise<TowerMissionView>
  /**
   * Record and deliver one lead-mediated message (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @param request - address, content, and pre-delivery cancellation.
   * @returns the recorded message.
   */
  sendMessage(caller: Agent, request: TowerMessageRequest): Promise<TowerMessage>
  /**
   * Read the caller's inbox slice (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @param limit - maximum messages returned.
   * @returns messages addressed to the caller, newest last.
   */
  inbox(caller: Agent, limit?: number): Promise<TowerMessage[]>
  /**
   * Persist one shared finding (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @param request - finding title and body.
   * @returns the recorded finding.
   */
  recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding>
  /**
   * List every recorded finding (lead or mission owner).
   * @param caller - exact live lead or mission Agent.
   * @returns all findings in creation order.
   */
  listFindings(caller: Agent): Promise<TowerFinding[]>
  /**
   * Append one review round, stamping the mission's current branch tip
   * (lead-only).
   * @param caller - exact live lead Agent.
   * @param request - mission, verdict, and review summary.
   * @returns the recorded round.
   */
  recordReview(caller: Agent, request: TowerReviewRequest): Promise<TowerReviewRound>
  /**
   * Merge one approved mission branch into the base through the review gate
   * (lead-only).
   * @param caller - exact live lead Agent.
   * @param id - the mission to merge.
   * @returns the merged mission and its merge commit.
   */
  merge(caller: Agent, id: TowerMissionId): Promise<TowerMergeResult>
  /**
   * End the workspace's active work, keeping `.tower/` as the audit trail
   * (lead-only).
   * @param caller - exact live lead Agent.
   * @param request - whether to remove dirty worktrees, and cancellation.
   * @returns removal and interruption facts.
   */
  teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult>
  /**
   * Whether `session` owns an unmerged mission.
   * @param session - the candidate session.
   * @returns true when the session is a recorded mission owner.
   */
  isMissionOwner(session: Session): Promise<boolean>
}
```

## provider 契约

provider 拥有工作区存储、git 与 mission 子代理生命周期；服务在委托之前校验模式与调用者权限。`validateBase` 在命令时刻运行，让 base 拼写错误在任何内容落盘前失败；`isMissionOwner` 是 mission 侧操作背后的持久权威。

```ts type-equiv
/**
 * The provider role of the tower capability seam: owns the `.tower/`
 * coordination store, git worktrees, and mission children, registered under
 * {@link TowerProvider.name}. The Service Definition routes every facade
 * operation to the configured provider; lead-only authority is re-validated
 * above it, so providers may assume the caller is authorized.
 */
interface TowerProvider {
  /** Unique registry name (e.g. `local`). */
  readonly name: string
  /**
   * Assert `base` names a local branch of the git work tree containing `cwd`.
   * Called by the `/tower on` command before the mode is logged, so a typo
   * fails at the earliest resolvable point.
   */
  validateBase(cwd: string, base: string): Promise<void>
  /**
   * Create the workspace under the lead session's git root, or adopt an
   * existing one: the recorded base must match the session's logged tower
   * base, missions carry over, and owners no longer live are reconciled to
   * `interrupted`.
   * @param caller - exact live lead Agent whose session owns the workspace.
   * @returns the workspace and adoption facts.
   */
  init(caller: Agent): Promise<TowerWorkspaceInfo>
  /**
   * Read the dashboard: unmerged missions with owner liveness and review-gate
   * state, the findings count, and the activity tail.
   * @param caller - exact live lead or mission Agent.
   * @returns the current dashboard.
   */
  status(caller: Agent): Promise<TowerDashboard>
  /**
   * Create one mission: allocate its id, fork the base into a new worktree,
   * start the mission child there, and record the provisioning outcome.
   * @param caller - exact live lead Agent.
   * @param request - title, complete task prompt, and caller cancellation
   * owning the operation until initial inbox acceptance.
   * @returns the active mission row.
   */
  spawnMission(
    caller: Agent,
    request: TowerSpawnRequest,
  ): Promise<TowerMissionView>
  /**
   * Interrupt the mission's live child (preserving its inbox) and mark the
   * mission `aborted`; its branch and worktree stay for inspection.
   * @param caller - exact live lead Agent.
   * @param id - the mission to abort.
   * @returns the updated mission row.
   */
  abortMission(caller: Agent, id: TowerMissionId): Promise<TowerMissionView>
  /**
   * Record one message and deliver it: `lead` receives it as a parent-inbox
   * notice, one mission id through adjacent-Agent messaging, and `all` fans
   * out to every live mission child.
   * @param caller - exact live lead or mission Agent.
   * @param request - address, content, and pre-delivery cancellation.
   * @returns the recorded message.
   */
  sendMessage(
    caller: Agent,
    request: TowerMessageRequest,
  ): Promise<TowerMessage>
  /**
   * Read messages addressed to the caller (`all` included), newest last.
   * @param caller - exact live lead or mission Agent.
   * @param limit - maximum messages returned, newest first before re-ordering.
   * @returns the caller's inbox slice.
   */
  inbox(caller: Agent, limit?: number): Promise<TowerMessage[]>
  /**
   * Persist one finding visible to every tower participant.
   * @param caller - exact live lead or mission Agent.
   * @param request - finding title and body.
   * @returns the recorded finding.
   */
  recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding>
  /**
   * List every recorded finding in creation order.
   * @param caller - exact live lead or mission Agent.
   * @returns all findings.
   */
  listFindings(caller: Agent): Promise<TowerFinding[]>
  /**
   * Append one review round for a mission, stamping the current branch tip.
   * `approve` moves the mission to `approved`; `reject` returns it to
   * `active` for rework.
   * @param caller - exact live lead Agent.
   * @param request - mission, verdict, and review summary.
   * @returns the recorded round.
   */
  recordReview(
    caller: Agent,
    request: TowerReviewRequest,
  ): Promise<TowerReviewRound>
  /**
   * Merge one mission branch back into the base. The merge gate refuses
   * loudly unless the mission is `approved`, the latest review round's
   * commit still equals the branch tip, and the main checkout sits on the
   * recorded base. On success the worktree is removed and the mission is
   * `merged`.
   * @param caller - exact live lead Agent.
   * @param id - the mission to merge.
   * @returns the merged mission and its merge commit.
   */
  merge(caller: Agent, id: TowerMissionId): Promise<TowerMergeResult>
  /**
   * End the workspace's active work: interrupt live mission children, remove
   * mission worktrees (dirty ones are kept and reported unless `force`), and
   * leave the `.tower/` coordination record in place as the audit trail.
   * Tower mode in the session stays on.
   * @param caller - exact live lead Agent.
   * @param request - whether to remove dirty worktrees, and caller cancellation.
   * @returns removal and interruption facts.
   */
  teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult>
  /**
   * Whether `session` is the recorded owner of an unmerged mission — the
   * durable authority behind mission-side comms tools, valid across cold
   * resume because it reads the mission record.
   * @param session - the candidate session.
   * @returns true when the session owns an unmerged mission.
   */
  isMissionOwner(session: Session): Promise<boolean>
}
```

各操作的请求类型（`TowerSpawnRequest`、`TowerMessageRequest`、`TowerFindingRequest`、`TowerReviewRequest`、`TowerTeardownRequest`）携带每次调用的输入以及调用者取消信号或上限，结果类型（`TowerWorkspaceInfo`、`TowerDashboard`、`TowerMissionView`、`TowerMergeResult`、`TowerTeardownResult`）是纯的持久记录读模型。

## 出厂 provider

[dsh-tower-local](../../packages/tower/tower-local/README.zh.md) 注册 `local` 后端：每个工作区 git 根一个 `.tower/` 存储（`workspace.json`、逐 mission 的 `missions/m-<n>.json`、append-only 的 `messages.jsonl`/`findings.jsonl`/`activity.jsonl`/`reviews/m-<n>.jsonl` journal，全部在读取时经 zod 校验）、经 [subprocess 接缝](subprocess.zh.md)驱动的 git worktree，以及作为 [可续聊 subagent](subagent.zh.md) 运行、`cwd` 绑定到 mission worktree 的 mission 子代理——即启动请求携带的逐子代理工作目录。单一 FIFO promise 队列串行化存储事务，而 subagent 接缝调用留在队列之外；消息投递经 lead 走（`lead` 通过父收件箱通知，mission 走[相邻 Agent 消息](subagent.zh.md)），mission 子代理的模型侧权威是它被记录的 mission 拥有身份。十个面向模型的工具在 [dsh-tool-tower](../../packages/tower/tool-tower/README.zh.md)；`tower_merge` 与 `tower_teardown` 在委托前征询[审批接缝](approval.zh.md)。配置表格与模型体验契约在各包 README。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtower--towerservice"></a>

### `ctx.tower` — `TowerService`

The tower capability published as `ctx.tower`. The service owns the logged mode, provider registry, and caller-authority validation; every operation delegates to the provider selected by Config once authority passes. The contract lives on the `./types` face so provider packages compile against contracts alone.

Authority: `init`, `spawnMission`, `abortMission`, `recordReview`, `merge`, and `teardown` are lead-only — the caller's session must carry active tower mode. `status`, `sendMessage`, `inbox`, `recordFinding`, and `listFindings` additionally admit recorded mission owners.

```ts cordis-catalog
/**
 * Register one backend under its {@link TowerProvider.name}. The
 * registration is an owned effect: disposing the caller's fiber removes it.
 * @param provider - the backend to publish.
 */
registerProvider(provider: TowerProvider): void

/**
 * Read the logged tower mode of `agent`'s session.
 * @param agent - the session-owning Agent.
 * @returns the committed mode and base.
 */
mode(agent: Agent): TowerModeState

/**
 * Create or adopt the caller's workspace (lead-only).
 * @param caller - exact live lead Agent.
 * @returns the workspace and adoption facts.
 */
init(caller: Agent): Promise<TowerWorkspaceInfo>

/**
 * Read the tower dashboard (lead or mission owner).
 * @param caller - exact live lead or mission Agent.
 * @returns the current dashboard.
 */
status(caller: Agent): Promise<TowerDashboard>

/**
 * Spawn one mission in an isolated worktree (lead-only); refuses loudly
 * beyond the configured mission bound.
 * @param caller - exact live lead Agent.
 * @param request - title, complete task prompt, and caller cancellation.
 * @returns the active mission row.
 */
spawnMission(caller: Agent, request: TowerSpawnRequest): Promise<TowerMissionView>

/**
 * Interrupt a mission's live child and mark it `aborted` (lead-only).
 * @param caller - exact live lead Agent.
 * @param id - the mission to abort.
 * @returns the updated mission row.
 */
abortMission(caller: Agent, id: TowerMissionId): Promise<TowerMissionView>

/**
 * Record and deliver one lead-mediated message (lead or mission owner).
 * @param caller - exact live lead or mission Agent.
 * @param request - address, content, and pre-delivery cancellation.
 * @returns the recorded message.
 */
sendMessage(caller: Agent, request: TowerMessageRequest): Promise<TowerMessage>

/**
 * Read the caller's inbox slice (lead or mission owner).
 * @param caller - exact live lead or mission Agent.
 * @param limit - maximum messages returned.
 * @returns messages addressed to the caller, newest last.
 */
inbox(caller: Agent, limit?: number): Promise<TowerMessage[]>

/**
 * Persist one shared finding (lead or mission owner).
 * @param caller - exact live lead or mission Agent.
 * @param request - finding title and body.
 * @returns the recorded finding.
 */
recordFinding(caller: Agent, request: TowerFindingRequest): Promise<TowerFinding>

/**
 * List every recorded finding (lead or mission owner).
 * @param caller - exact live lead or mission Agent.
 * @returns all findings in creation order.
 */
listFindings(caller: Agent): Promise<TowerFinding[]>

/**
 * Append one review round, stamping the mission's current branch tip
 * (lead-only).
 * @param caller - exact live lead Agent.
 * @param request - mission, verdict, and review summary.
 * @returns the recorded round.
 */
recordReview(caller: Agent, request: TowerReviewRequest): Promise<TowerReviewRound>

/**
 * Merge one approved mission branch into the base through the review gate
 * (lead-only).
 * @param caller - exact live lead Agent.
 * @param id - the mission to merge.
 * @returns the merged mission and its merge commit.
 */
merge(caller: Agent, id: TowerMissionId): Promise<TowerMergeResult>

/**
 * End the workspace's active work, keeping `.tower/` as the audit trail
 * (lead-only).
 * @param caller - exact live lead Agent.
 * @param request - whether to remove dirty worktrees, and cancellation.
 * @returns removal and interruption facts.
 */
teardown(caller: Agent, request: TowerTeardownRequest): Promise<TowerTeardownResult>

/**
 * Whether `session` owns an unmerged mission.
 * @param session - the candidate session.
 * @returns true when the session is a recorded mission owner.
 */
isMissionOwner(session: Session): Promise<boolean>
```

Types: [Agent](core.zh.md) · [Session](session.zh.md)

Source: [`packages/tower/tower/src/types.ts`](../../packages/tower/tower/src/types.ts)

<a id="tower-local-events"></a>

### `tower-local/*` events

<a id="tower-localactivity--emit"></a>

#### `tower-local/activity` — emit

One tower-local activity entry committed to the workspace journal. The dispatch is synchronous and runs before the recording operation returns, so a synchronous listener's throw reaches that operation; listeners must be synchronous, must tolerate stores they do not own, and must not call back into the emitting provider (its storage transaction is still open).

```ts cordis-catalog
/**
 * One tower-local activity entry committed to the workspace journal. The
 * dispatch is synchronous and runs before the recording operation
 * returns, so a synchronous listener's throw reaches that operation;
 * listeners must be synchronous, must tolerate stores they do not own,
 * and must not call back into the emitting provider (its storage
 * transaction is still open).
 * @param notice - the store root, the committed entry, and the merged branch tip when any.
 * @mode emit
 */
'tower-local/activity'(notice: TowerLocalActivityNotice): void
```

Source: [`packages/tower/tower-local/src/events.ts`](../../packages/tower/tower-local/src/events.ts)
<!-- END GENERATED cordis-surface -->
