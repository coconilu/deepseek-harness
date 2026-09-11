---
description: "tower 包组：让 lead 会话把 mission 分派到隔离 git worktree、再经评审门禁合并回去的能力缝与面向模型的工具。"
kind: "package-group"
---

# tower/ — 基于 git worktree 的 mission 协作

[English](README.md) | 中文

## 概述

tower 组让一个 lead 会话以 mission 为单位协调并行工作：每个 mission 在自己从记录的 base 分出的 git worktree 中运行，通过居中传达的消息与共享发现同 lead 交流，并且只在评审轮次批准确切 tip 之后才落地。三个包把能力缝拆成 Service Definition、出厂 provider 与面向模型的 Consumer；profile 通过 tower bundle 显式启用。当 lead 应当驱动整个工作流而不仅是旁观时选择本组。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

本接缝遵循三角色拆分：服务拥有记录的模式与权限，provider 拥有工作区，consumer 拥有工具 schema。

| 包 | 职责 |
|---|---|
| [`tower`](tower/README.zh.md) | Service Definition：记录的 tower 模式、`/tower` 命令、`tower:policy` 段落，以及校验调用者权限的 `ctx.tower` 门面 |
| [`tower-local`](tower-local/README.zh.md) | Service Provider：`local` 后端——`.tower/` 协调存储、git worktree 与 mission 子代理生命周期 |
| [`tool-tower`](tool-tower/README.zh.md) | Consumer：十个 `tower_*` 工具，带执行器侧权限检查与需审批的 merge/teardown |

<a id="related-documentation"></a>
## 相关文档

- [tower 子系统参考](../../docs/subsystems/tower.zh.md)——工作区、mission、评审与消息词汇以及完整的服务与 provider 契约。
- [dsh-tower-profile](../bundle/tower/README.zh.md)——在 `dsh-base` 之上挂载这三个包的启用式 profile 层。
- [tower 协作 Agent Note](../../.agents/notes/implemented/feature/2026-09-11-tower-capability.zh.md)——设计决策与备选方案。

<a id="dev-note"></a>
## 开发备注

无。
