# Agent Note: 共享的固定记录工具 output 声明位于 dsh-tools

Status: implemented

[English](2026-09-12-shared-json-tool-output-declaration.md) | 中文

## Problem

每次调用只返回一个固定记录的工具消费方，都在各自手写同一种 output 声明：规范值 schema 配一个紧凑 JSON 的 `render`。`experimental/tool-agent-team` 与 `tower/tool-tower` 各自持有逐字节相同的 `jsonOutput` 副本，后一份还带着 `jscpd:ignore` 豁免和一条指向未来共享导出的遗留注释。每多一个工具消费方就会再复制一次这套写法，而豁免把一份重复固化在了重复检测门禁本要捕捉的代码里。

## Decision

`@deepseek-ai/dsh-tools` 在 `ToolOutputDefinition` 与 `defineTool` 旁导出 `jsonOutput(schema)`：它返回的 `output` 声明中，`schema` 就是声明的值 schema，`render` 输出一个无损的紧凑 JSON 文本块。`experimental/tool-agent-team` 与 `tower/tool-tower` 已改为导入它；两份本地副本、`jscpd:ignore` 豁免及其遗留注释均已删除。这两个包本就依赖 dsh-tools，因此本次提取没有新增依赖边、workspace 包或 aggregate tsconfig 引用。

## Alternatives considered

**共享 helper 放在 `packages/util/`。** util 组的条目是能力无关的机械原语；`jsonOutput` 导出要引用 `ValueSchemaSpec`/`InferValue` 与 `ToolOutputDefinition` 词汇，会把工具注册表领域的类型拖进一个不拥有这些语义的组；新建包还要额外注册 aggregate tsconfig 和 lockfile，语义上毫无收益。

**维持两包解耦并保留豁免。** 现状是在两个消费方之间复制同一 helper，并把这笔债编码为一条被忽略的克隆；评审门禁将再也看不到它本要压制的重复。

**每个工具继续内联 `render`。** 不属于固定记录形态的消费方（pretty-print JSON、自定义 content）继续手写 render；只有固定记录这套惯用法被集中起来。

## Consequences

工具 schema DSL 词汇与 output 声明契约现在同属一个所有者，新的工具消费方通过已有的 dsh-tools 依赖即可采用固定记录声明。jscpd 豁免预算减少一处；dsh-tools 内剩余的 `jscpd:ignore` 块对应无关的平行实现。`packages/core/tools/tests/tools.spec.ts` 固定了 render 契约，重复检测门禁不再依赖这两个消费方中的任何豁免。落到这个归属需要把任务 scope 从 `packages/util/` 扩大；提取本身没有改变任何行为。
