---
description: "dsh 的 tower profile 层：把 mission 分派到隔离的 git worktree，经评审门禁合并回 base，按 profile 在 dsh-base 之上显式启用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tower-profile

[English](README.md) | 中文

## 概述

`dsh-tower-profile` 让 tower 模式在一个已初始化的 profile 里可用：lead 会话把工作以 mission 为单位分派到隔离的 git worktree，通过协调存储观察它们，再经评审门禁把每个 mission 合并回 base。该层在 [`@deepseek-ai/dsh-base`](../base/README.zh.md) 之上挂载 tower 能力、本地 provider 与十个 tower_* 工具；在用户于会话中用 `/tower on <base>` 打开 tower 模式之前，一切保持不变。需要显式把本包加入 profile；没有任何出厂 profile 默认启用它。

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

### 安装进 profile

把本包加入一个已初始化的 profile，然后在会话里打开 tower 模式：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-tower-profile
dsh --profile <name> "Split this refactor into missions and land them one by one."
```

profile 必须已包含 `@deepseek-ai/dsh-base`：本层叠加在其后，消费它的 Subagent 与 subprocess 服务、工具注册表和命令注册表。在会话中，`/tower on <base>` 激活 tower 模式；`<base>` 必须是会话所在仓库的一个本地分支。用 `dsh plugin --profile <name> remove @deepseek-ai/dsh-tower-profile` 移除本包，即从 profile 的有序 bundle 列表中拿掉该层。

### 你会得到什么

本层在 `dsh-base` 之后添加三行组合：tower Service Definition（携带本包的面向模型策略文本，tower 模式激活时作为 `tower:policy` 提示词段落渲染）、拥有 `.tower/` 协调存储、git worktree 与 mission 子代理的 `local` provider，以及注册十个 tower_* 工具的 tower 工具消费方。

tower 模式下，lead 先用 `tower_init` 创建或接管工作区，用 `tower_spawn` 分派 mission（每个 mission 在自己从 base 分出的 worktree 中由子代理执行），用 `tower_status` 观察进度，用 `tower_send` 与 `tower_inbox` 交换消息，用 `tower_finding` 记录共享发现，用 `tower_review` 记录评审轮次，并用 `tower_merge` 合并通过评审的 mission。`tower_mission` 中止一个 mission；`tower_teardown` 结束工作区的当前工作。`tower_merge` 与 `tower_teardown` 在行动前先征求用户批准。

出厂边界：每个工作区最多八个未合并 mission（`maxMissions: 8`），mission 子代理经由 `spawn` provider 组合，策略文本由本包作为 Service Definition 的 `section` 提供。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)：一段在 `dsh-base` 之后应用的、含三行的 insert patch。Service Definition 行逐字设定策略 `section`、`provider: local` 与 `maxMissions: 8`；provider 行设定 `childProvider: spawn`；工具消费方行不带 config，保持工具默认的收件箱上限。包测试钉住 patch 各行并通过真实 Loader 启动，在组合出的树上断言 /tower 命令、十个 tower_* 工具与逐字一致的策略段落。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上的三行 insert patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 即运行时内容 |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | patch 钉住与三个插件的真实 Loader 组合 |
| — | 不发布运行时不变式伴生入口；patch 本身无可变关系，其激活的不变式由三个 tower 包持有。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [组合包索引](../README.zh.md)——`dsh --profile` 叠加的安装层。
- [dsh-base](../base/README.zh.md)——本 patch 叠加的共享核心。
- [Profile plugin bundles 备注](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)——profile 与 bundle 组合设计。
- [dsh 应用](../../../apps/cli/README.zh.md)——启动 profile 并管理其包的 `dsh` 命令。

-----

<a id="model-experience"></a>
## 模型体验

### Tower 策略与工具

#### 模型看到什么

策略文本属于本包（Service Definition 的 `section` 配置）；工具 schema 与描述属于 tower 工具消费方。本包只改变组合：三行让 `/tower` 命令、十个 tower_* 工具与 `tower:policy` 提示词段落可用。

#### Token 影响

tower 模式关闭时本层不添加任何内容。打开时，模型读取策略段落文本与十个工具 schema。

#### KV Cache 影响

patch 与配置边界不变时组合是前缀稳定的；策略段落随 tower 模式进出请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本层何时不适用。它们是当前包约束，不是任务积压。

- **仅显式启用**——包是公开的，但没有任何出厂 CLI、Web、SDK、ACP 或 Python profile 启用它。
- **需要 base profile**——patch 依赖 `dsh-base` 提供的行 id、Subagent 与 subprocess 服务及命令注册表；它不是独立 profile。
- **merge 与 teardown 需要审批接缝**——未组合审批服务时，`tower_merge` 与 `tower_teardown` 以失败告终，不会擅自行动。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
