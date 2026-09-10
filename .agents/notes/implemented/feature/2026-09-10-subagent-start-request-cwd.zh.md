# Agent Note: 子 agent 启动请求的按子工作目录

Status: implemented

[English](2026-09-10-subagent-start-request-cwd.md) | 中文

## Problem

此前每个进程内子 agent 都继承父会话的 `cwd`：`childSessionMeta` 固定盖上 `parentHeader.cwd`，没有覆盖入口；进程外后端也只能解析部署级 `cwd` 配置或同一个父值。若协调方为每个子 agent 准备了隔离工作区——每个并行任务一个 git worktree、每次实验一棵 scratch 树——就无法通过该能力缝把子 agent 绑定进去。剩下的选择只有 fork provider 代码，或整体搬迁父会话，而后者会破坏其他仍应共享同一工作区的兄弟 agent 的假设。

## Decision

`SubagentStartRequest` 新增可选 `cwd`：指向已存在、可进入目录的绝对路径，作为子会话持久化的 `cwd`（其子 agent 工具解析的工作区），取代继承自父会话的值。校验发生在启动时、任何子资源存在之前，复用进程外缝既有的 `assertUsableCwd`，因此相对路径与不可访问目录在一次性与可继续两条路径上以同一套诊断词汇失败。该值经由会话头传递，持久化与冷恢复本就识别会话头，因此 descriptor 与恢复路径都不变。

一次性路径用新的 `SubagentCapabilities.cwd` flag 门控该选项，保持了能力缝「一个 flag 对应一个请求选项」的对称性；两个进程内提供方都声明支持，因为它们自己写入子会话。continuation manager 无论提供方是谁都亲自组装可继续子 agent，因此它对任何可继续提供方都落实 `cwd`，无需查询 flag——这与其他启动时功能已有的分工一致，因为 flag 只描述 `SubagentProvider.start`。

进程外提供方（ACP、Codex、Claude Code、DSH SDK）声明 `cwd: false`：它们的子工作目录仍只来自部署覆盖或父会话，携带 `cwd` 的请求会在传输启动前被拒绝。

## Alternatives considered

**为进程外提供方打通按请求的 `cwd`。** 拒绝：当前没有 Consumer 需要，且每个后端都要为一条无人使用的路径增加线路层管线与测试。flag 让拒绝保持响亮，日后扩展提供方是增量改动。

**在面向模型的委派工具上暴露 `cwd`。** 拒绝：选择工作区是协调方的决策，不是模型输入；当前没有 Consumer 需要，且工具 schema 保持稳定有利于请求缓存复用。

**把 `cwd` 记入 subagent descriptor。** 拒绝：会话头已经持久化该值，恢复时读取的也是会话头；再存一份会让一个事实有两个权威来源。

## Consequences

仓库内每个 `SubagentCapabilities` 字面量在同一改动中补齐该 flag（pre-stable API，消费方同步更新）。提供方现在必须对按请求工作目录明确表态，而不是静默继承默认值。被拒绝的 `cwd` 不配给任何资源：可继续路径上校验先于 id 预留，一次性路径上先于提供方分发。

## Testing

单元测试覆盖能力拒绝、两条启动路径上的相对路径与不可访问路径拒绝、原样透传，以及有无覆盖时子会话头的落值。录制会话快照不受影响，因为 `cwd` 只在显式提供时改变行为。
