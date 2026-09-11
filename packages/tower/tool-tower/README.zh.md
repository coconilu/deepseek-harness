---
description: "面向模型的 tower 工具：面向需要选择、配置或调试十个 tower_* 工具、其权限规则与需审批的 merge/teardown 的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-tower

[English](README.md) | 中文

## 概述

`dsh-tool-tower` 注册模型操作 tower 所需的十个 `tower_*` 工具：创建或接管工作区、在各自 worktree 中分派与观察 mission、交换消息与发现、记录评审轮次，以及经显式用户批准完成合并或清理。lead 专属操作要求调用会话处于 tower 模式；消息与发现工具同时放行已记录的 mission 拥有者。当希望由模型——而不仅是人类命令——驱动 mission 工作流时，把它组合在 `dsh-tower` 与一个 provider 旁边。

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

添加一行组合；工具注册到 `ctx.tools`，并经由 `ctx.tower` 访问 tower 能力。

### 何时选择本包

当 tower 能力的组合应当可以由模型驱动时选择本包。没有它，tower 服务只是程序化接缝，没有面向模型的入口。工具假定已组合某个 tower provider；tower profile bundle 会把三个包一起带来。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-tower'
  config:
    section: ...
- name: '@deepseek-ai/dsh-tower-local'
- name: '@deepseek-ai/dsh-tool-tower'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxInbox` | `20` | 模型省略 `limit` 时 `tower_inbox` 的上限，也是每个显式 limit 被钳制的天花板 |

越界配置会让插件加载失败。这就是全部配置。

### 工具集

| 工具 | 权限 | 用途 |
|---|---|---|
| `tower_init` | 仅 lead | 在调用会话的 git 根创建或接管工作区 |
| `tower_status` | lead 或 mission 拥有者 | 读取仪表盘：mission、发现计数、活动尾部 |
| `tower_spawn` | 仅 lead | 分叉一个 mission worktree 并启动其子代理 |
| `tower_mission` | 仅 lead | mission 控制（`abort`） |
| `tower_send` | lead 或 mission 拥有者 | 向 `lead`、单个 mission id 或 `all` 发送一条消息 |
| `tower_inbox` | lead 或 mission 拥有者 | 读取发给本会话的消息，最新的在最后 |
| `tower_finding` | lead 或 mission 拥有者 | 记录一条共享发现或列出现有发现 |
| `tower_review` | 仅 lead | 记录一轮评审，钉住当时的 branch tip |
| `tower_merge` | 仅 lead，需审批 | 把一个已批准的 mission branch 合并回 base |
| `tower_teardown` | 仅 lead，需审批 | 结束工作区的当前工作 |

`tower_merge` 与 `tower_teardown` 在委托之前先向组合的审批接缝征求用户决定；其余工具不询问、直接执行。权限被刻意强制两次：一次在这层执行器——调用者可以直接调它——一次在门面内部。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包的设计决策；可观察行为见[使用本包](#use-this-package)。

### 声明式结果，紧凑渲染

每个工具都声明完整的结果 schema，并把该值渲染为紧凑 JSON，因此编译器会把每个 `execute` 与向模型承诺的值互相校验，结果也不会把 token 花在缩进上。mission 行去掉原始 `prompt`（撰写会话本就持有它写下的任务文本）与不透明的 `owner` 会话 id。

### 需审批的操作

合并或清理之前，工具先读取仪表盘、向用户描述真实目标，并要求 `allowed-once` 这个结果；缺少审批接缝时以失败告终，其他任何结果都会让调用失败并说明什么都没有发生。未知的 mission id 会跳过询问、直接落到下方门面的响亮失败——这个竞态窗口只会把一次已批准的合并变成被拒绝的合并，绝不会相反。

### mission 子代理与工具过滤

本包导出 `MISSION_TOOL_FILTER`——六个 lead 专属工具名的拒绝清单——用于通过子代理启动 `toolFilter` 组合 mission 子代理；缺少过滤器时，工具自身的权限门禁仍是第二道防线，被过滤的子代理看不到那些名字，未过滤的子代理则在执行时响亮失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、十个工具注册、`MISSION_TOOL_FILTER`、权限与审批辅助 |
| — | 不发布运行时不变式伴生入口：工具只是门面的适配层，不变式检查的每个持久关系都由 provider 持有。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [tower 子系统参考](../../../docs/subsystems/tower.zh.md)——工具所投影的工作区、mission、评审与消息词汇。
- [dsh-tower](../tower/README.zh.md)——工具适配的门面。
- [dsh-tower-local](../tower-local/README.zh.md)——执行操作的出厂 provider。
- [审批子系统](../../../docs/subsystems/approval.zh.md)——`tower_merge` 与 `tower_teardown` 征询的一次性用户审批接缝。
- [tower/ 包索引](../README.zh.md)——该组及其三个包。

-----

<a id="model-experience"></a>
## 模型体验

### Tower 工具与结果

#### 模型看到什么

本包组合期间，无论 tower 模式是否激活，模型都会在每个请求中读到十个 `tower_*` 工具 schema；结果以与声明 schema 一致的紧凑 JSON 到达。被拒绝的 `tower_merge` 或 `tower_teardown` 返回"什么都没有发生——未经用户明确批准不要重试"的失败文本，审批问题本身呈现给用户，而不是模型。

#### Token 影响

组合 profile 的每个请求都要支付十个 schema 的费用；每个结果只增加其紧凑 JSON，`tower_inbox` 按 `maxInbox` 限制分页。

#### KV Cache 影响

工具 schema 在组合时注册且从不变化，因此请求前缀保持稳定；工具结果作为普通会话增长追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包何时不适用或需要额外注意。它们是当前包约束，不是任务积压。

- **merge 与 teardown 需要审批接缝**——未组合审批服务时，`tower_merge` 与 `tower_teardown` 以失败告终，不会擅自行动；其他工具不询问。
- **过滤器只隐藏、不授权**——`MISSION_TOOL_FILTER` 要求本包已组合，且只塑造可见性；未使用它的子代理仍能看到 lead 专属工具名，并在执行时失败。
- **要求模型发起的派发**——每个工具都需要注册表在模型发起派发时附上的调用 `Agent`；缺少它的直接执行器调用会失败。
- **收件箱上限双重生效**——`maxInbox` 同时限制省略 `limit` 的默认值与每个显式 limit，模型因此无法把 journal 翻到配置上限之外。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
