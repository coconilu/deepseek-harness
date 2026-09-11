---
description: "tower 能力 Service Definition：面向需要选择、配置或调试 tower 模式记录、/tower 命令与 mission 协调门面的部署者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tower

[English](README.md) | 中文

## 概述

`dsh-tower` 负责 tower 模式的开关与会话可执行的每一项 tower 操作：lead 会话把工作以 mission 为单位分派到隔离的 git worktree，通过协调存储观察进度，并且只在评审门禁通过后把 mission 合并回 base。用 `/tower on <base>` 选择模式；状态在 resume 与 fork 后仍然保留，模式激活期间由你配置的策略文本指引 lead。当一个会话需要协调并行工作而不是独自完成一切时选择它；git 与子代理机制由你组合的 provider 承担。

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

挂载服务、选择 provider，然后在会话中进入 tower 模式；常见路径是 `/tower on <base>`，随后使用模型侧消费方注册的 tower 工具。

### 何时选择本包

当部署需要 lead 驱动的 mission 工作、并要求显式可评审的合并门禁时选择本包。它是能力缝的 Service Definition：拥有记录的模式与门面，而 `@deepseek-ai/dsh-tower-local` 拥有 `.tower/` 存储、git worktree 与 mission 子代理，`@deepseek-ai/dsh-tool-tower` 拥有面向模型的工具。当一个会话的普通工具已经覆盖工作时跳过它。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-tower'
  config:
    section: |
      Tower mode is active: you are the lead. Fan work out with the tower_*
      tools and land missions only through the review gate.
- name: '@deepseek-ai/dsh-tower-local'
- name: '@deepseek-ai/dsh-tool-tower'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `section` | 必填 | tower 模式激活时作为 `tower:policy` 提示词段落渲染的策略 |
| `provider` | `'local'` | 门面委托的 tower provider 注册名 |
| `maxMissions` | `8` | 每个工作区未合并 mission 的上限，在分派 mission 时强制执行 |

空白 `section`、未知键或非正数边界都会让插件加载失败。这三个字段就是全部配置；provider 与工具包各有自己的表格。

### 进入与离开 tower 模式

输入 `/tower on <base>` 在会话所在仓库的一个本地分支上激活 tower 模式；base 在任何内容落盘之前先做校验，因此拼写错误只会失败、不会改变状态。输入 `/tower off` 离开，输入 `/tower status` 读取当前模式。回合进行中做出的选择从下一个被接受的步骤起生效，命令会把这一点告诉你；与当前状态相同的选择是 no-op。

<a id="model-and-human-interactions"></a>
### tower 模式改变了什么

模式激活期间，lead 读取你的 `section` 策略并能调用与本包组合在一起的 tower 工具；未激活期间这些工具在权限检查处失败。每一项操作都被校验两次：门面要求工作区与评审类操作的调用会话处于 tower 模式，同时对仪表盘、消息与发现类操作额外放行已记录的 mission 拥有者，然后才委托给选定的 provider。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包的设计决策；可观察行为见[使用本包](#use-this-package)。

### 一份记录的状态，一个门面

持久化姿态与 plan mode 一致：一条 log-only、整值替换的 `tower/mode` 会话事件，最后一次落盘的值就是状态。`tower` 投影把该事件与 `/tower` 命令运行一起折叠，因此 resume、fork 与 compaction 仅凭日志即可恢复模式，客户端载体读取裁剪后的 `{ active, pending, base? }` 视图。选择在回合之间立即落盘；回合进行中它保持 pending，直到下一个被接受的回合内 pre-step 把它写入——这是 agent 运行期间唯一的落盘点——落盘失败不会阻塞步骤，选择留待稍后重试。

### 权限与委托

服务在每项操作前先校验调用者：`init`、`spawnMission`、`abortMission`、`recordReview`、`merge` 与 `teardown` 要求调用会话的 tower 模式处于激活状态，而 `status`、`sendMessage`、`inbox`、`recordFinding` 与 `listFindings` 额外放行未合并 mission 的已记录拥有者——这是一项读取 provider mission 记录的持久检查，冷 resume 后依然有效。权限通过后，门面委托给 `provider` 指定的 provider，并在分派时复查 `maxMissions`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、`ctx.tower` 门面、`tower:policy` 段落、`/tower` 命令、投影注册 |
| [`src/types.ts`](src/types.ts) | provider 与工作区词汇、`tower` 投影类型以及 `ctx.tower` 声明 |
| — | 不发布运行时不变式伴生入口：模式只有单一权威——会话日志——投影折叠由测试钉住，不存在能与之分叉的第二观测。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [tower 子系统参考](../../../docs/subsystems/tower.zh.md)——工作区、mission、评审与消息词汇以及完整服务契约。
- [tower/ 包索引](../README.zh.md)——该组及其三个包。
- [dsh-tower-local](../tower-local/README.zh.md)——出厂 provider：`.tower/` 存储、git worktree 与 mission 子代理。
- [dsh-tool-tower](../tool-tower/README.zh.md)——十个面向模型的 tower 工具。
- [tower 协作 Agent Note](../../../.agents/notes/implemented/feature/2026-09-11-tower-capability.zh.md)——设计决策与备选方案。

-----

<a id="model-experience"></a>
## 模型体验

### Tower 策略系统提示词

#### 模型看到什么

tower 模式激活——或已有待生效的激活选择——时，模型读取逐字一致的 `section` 文本作为 `tower:policy` 提示词段落；未激活时不贡献任何文本。

##### 配置示例

```markdown
Tower mode is active: you are the lead. Fan work out with the tower_* tools and land missions only through the review gate.
```

#### Token 影响

未激活模式不添加任何 token；激活模式把配置的段落加进每个请求。

#### KV Cache 影响

模式保持激活期间段落稳定，但进入或离开会从该段落所在位置起改变系统提示词。

### 模式变化与命令

#### 模型看到什么

`/tower`、它的结果与 `tower/mode` 事件都是 log-only：它们都不进入模型历史，进入或离开 tower 模式也不改变工具目录——本包不注册任何工具。投影视图到达客户端载体，而不是模型。

#### Token 影响

模式切换不消耗模型 token；唯一模型可见的变化就是上面的策略段落。

#### KV Cache 影响

记录的模式从不改动请求前缀；只有策略段落的出现与否移动可复用前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包何时不适用或需要额外注意。它们是当前包约束，不是任务积压。

- **必需的投影键**——模式读取需要 `tower` 与 `turnBoundary` 投影键；注册表或任一键缺失时，第一次依赖性访问会响亮地失败。
- **策略无默认值**——服务逐字渲染配置的 `section` 文本，自身不带任何策略；tower profile bundle 持有出厂文本。
- **待生效选择是进程内的**——回合最后一次被接受的 pre-step 之后做出的选择，若进程在下一个被接受的回合内 pre-step 之前退出就会丢失；命令结果已经报告过排队状态。
- **命令依赖命令服务**——`/tower` 只在组合了命令注册表时注册；其他入口仍可直接驱动 `ctx.tower`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
