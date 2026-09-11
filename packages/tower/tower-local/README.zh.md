---
description: "本地 tower provider：面向需要选择、配置或调试 .tower/ 协调存储、git worktree mission 与 mission 子代理生命周期的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tower-local

[English](README.md) | 中文

## 概述

`dsh-tower-local` 是出厂的 tower provider：它在 `ctx.tower` 上注册 `local` 后端，把协调存储放在工作区的 `.tower/` 目录里，经 subprocess 接缝驱动 git worktree，并把每个 mission 子代理作为绑定到自己 worktree 的可续聊 subagent 运行。mission 从记录的 base 分出，经 lead 居中传达消息，并且只在评审轮次批准确切的 tip commit 之后才合并回去。只要 tower 能力需要操作本地 git 仓库就组合它；想要其他后端的部署应改为实现 provider 契约。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 tower 服务之后添加一行组合；provider 以 `local` 名字自注册，服务默认选择这个名字。

### 何时选择本包

当 tower 工作区是本地 git checkout、且 mission 子代理能以可续聊 subagent 形式进程内运行时，选择本 provider。它是唯一出厂的 provider；替代后端在它旁边注册自己的 `TowerProvider` 实现。只有当 tower 服务仅用于契约或测试目的、不挂后端时才跳过它。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-tower'
  config:
    section: ...
- name: '@deepseek-ai/dsh-tower-local'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `childProvider` | `'spawn'` | 组合 mission 子代理的 `ctx.subagents` provider 名字 |
| `childToolFilter` | `[]` | 从每个 mission 子代理工具集中拒绝的工具名 |
| `activityTail` | `50` | 一次仪表盘 status 返回的活动条目上限 |

空白名字、未知键或非正数边界都会让插件加载失败。`childToolFilter` 里未知或保留的名字会让 mission 子代理的启动响亮地失败。

### 磁盘上的工作区

`tower init` 在会话的 git toplevel 创建存储，或在已记录 base 与会话 tower base 一致时接管现有存储。布局是每个工作区一个目录：

```text
.tower/
  workspace.json        # version 1: base, root, createdAt
  missions/m-<n>.json   # one durable record per mission, whole-value replaced
  reviews/m-<n>.jsonl   # append-only review rounds per mission
  messages.jsonl        # append-only lead-mediated messages
  findings.jsonl        # append-only shared findings
  activity.jsonl        # append-only activity record
  worktrees/<id>/       # one git worktree per mission
```

每次读取都会按 schema 校验记录；存储损坏时响亮失败，而不是猜测。provider 会把 `/.tower/` 写进仓库的 `info/exclude`，协调存储因此永远不会进入 status 或提交。接管时把 owner 会话已不存活的 `spawning` 与 `active` mission 对账为 `interrupted`，保留 branch 与 worktree 供评审和合并。

### mission 生命周期

`tower_spawn` 分配下一个 `m-<n>` id，把 base 分叉为 `tower/<id>` 上的 worktree，并通过 `childProvider` 启动子代理、把 `cwd` 设为该 worktree；worktree 创建失败会把 mission 记为 `failed`，子代理启动失败还会回滚 worktree 与 branch。`tower_mission` 的 `abort` 中断存活的子代理（其收件箱保留）并把 mission 记为 `aborted`；branch 与 worktree 留待检查。`tower_merge` 拒绝执行，除非 mission 处于 `approved`、最近一次批准评审轮次的 commit 仍等于 branch tip、mission worktree 干净、且主 checkout 停在记录的 base 上——随后它以 `--no-ff` 合并、移除 worktree、把 mission 记为 `merged`。`tower_teardown` 排空调用者存活的 mission 子代理并移除 worktree，脏的保留并报告，除非设置 `force`；`.tower/` 记录作为审计痕迹保留。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包的设计决策；可观察行为见[使用本包](#use-this-package)。

### 单一串行存储，决策时读 git

持久状态放在存储里，存活状态放在 agents 注册表里，每个 git 事实都在决策时重新读取。单一 FIFO promise 队列串行化存储事务——id 分配、记录写入、journal 追加——且队尾永不 reject，因此一个失败的事务不会卡住后续事务。subagent 接缝调用（子代理创建、消息投递、中断、排空）绝不在队列内运行，因为子代理生命周期回调可能在 provider 工作期间重入 tower 服务。`isMissionOwner` 按契约留在队列外，因此它能在 spawn 事务进行中作答。

### 消息、发现与活动

消息先入 journal 再投递：`lead` 通过父收件箱通知收到，单个 mission id 经由存活的 lead 作为中介送达，`all` 扇出到除发送者外每个存活的 mission 子代理；投递失败时记录仍可从收件箱取回。发现是任何参与者都可读的 append-only 记录。每项操作追加一条活动条目，并在提交时刻、存储事务之内同步发出 `tower-local/activity` 事件，观察者因此按 journal 顺序看到条目。

### 不变式伴生入口

`./invariant` 入口安装合并-评审契约：每条 `merge` 活动条目都必须有同一工作区内、针对确切被合并 commit 的批准评审轮次支撑。活动 journal 与评审 journal 是相互独立的记录，因此一条没有评审支撑的合并记录意味着门禁被绕过。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：name、injections、`Config` schema、provider 注册 |
| [`src/provider.ts`](src/provider.ts) | `LocalTowerProvider`：工作区、mission、消息、评审、合并门禁、teardown |
| [`src/store.ts`](src/store.ts) | `.tower/` 存储：zod 校验的记录、id 分配、append-only journal |
| [`src/git.ts`](src/git.ts) | 经 subprocess 接缝驱动的 git worktree 与 branch 操作 |
| [`src/events.ts`](src/events.ts) | 提交时刻的 `tower-local/activity` 事件及其载荷 |
| [`src/error.ts`](src/error.ts) | 带可路由错误码的 `TowerLocalError`（`NO_GIT`、`NO_WORKSPACE`、`TOWER_LOCAL`） |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生入口：基于活动事件的合并-评审契约 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [tower 子系统参考](../../../docs/subsystems/tower.zh.md)——工作区、mission、评审与消息词汇以及完整 provider 契约。
- [dsh-tower](../tower/README.zh.md)——本 provider 注册到其下的 Service Definition。
- [subagent 子系统](../../../docs/subsystems/subagent.zh.md)——provider 组合 mission 子代理所经的可续聊子代理接缝。
- [运行时不变式](../../../docs/subsystems/invariants.zh.md)——不变式伴生入口安装进注册表。
- [tower/ 包索引](../README.zh.md)——该组及其三个包。

-----

<a id="model-experience"></a>
## 模型体验

### mission 子代理组合

#### 模型看到什么

provider 自身不注册任何提示词段落或工具 schema。mission 子代理的模型读取 lead 写下的 spawn `prompt` 任务文本以及发给它的 tower 消息，而 `childToolFilter` 中的每个名字都会在子代理第一个请求之前从其工具目录中消失。

#### Token 影响

provider 不直接给任何请求增加内容。被分派的 mission 子代理为其自包含的 prompt 付一次费用，被拒绝的工具 schema 会缩小子代理的目录。

#### KV Cache 影响

provider 从不改动请求前缀；mission 子代理的目录在其启动时固定，因此其前缀在会话增长期间保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本 provider 何时不适用或需要额外注意。它们是当前包约束，不是任务积压。

- **仅支持本地 git**——存储假设单一本地 git work tree；没有远程或网络后端，远程跟踪引用与标签也不能作为 tower base。
- **存储串行化是进程内的**——FIFO 队列只串行化单个 provider 实例的事务；共享同一工作区的两个并发进程在文件系统层面竞争，而不是相互协调。
- **投递是先记录再尽力而为**——消息投递失败时记录仍可从收件箱取回，但不会自动重试。
- **合并要求主 checkout 停在 base 上**——即使 mission 侧条件全部满足，主 checkout 停在其他分支时门禁仍会拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
