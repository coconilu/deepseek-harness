# Agent Note: 命令结果点亮 blank 空态外壳

Status: implemented

[English](2026-09-11-command-result-blank-shell-visibility.md) | 中文

## Problem

一条被受理的斜杠命令唯一可见的结果是其持久生命周期：宿主执行器记录 `command/run` 与 `command/done`，而 Composer 有意不回显结果。Web 客户端会把这两个事件折叠成一个命令 Chat 节点，但在全新会话上该节点从未到达屏幕。命令提交不翻转 Session 的 blank→engaged 边缘（`promptAttempted` 只由模型 prompt 路径设置），会话列表的 blank 中继也没有针对纯命令活动的实时推送，而外壳停留在 `blank` 阶段时 `ConversationSession` 渲染 null——折叠好的节点连同错误结果里的 `Usage:` 文本一起从未绘制。`/goal` 之所以不受影响，是因为 ui-goal 额外贡献了一个非命令的 `command-input` 节点来激活 Chat 视图；像 `/tower on` 这样的普通命令返回错误后界面毫无变化，用户只能认为命令没有生效。

## Decision

三处修改恢复渲染路径。命令执行事务像 prompt 一样点亮会话：[命令 UI 运行时](../../../../packages/client/ui-commands/src/client/service.ts) 中的 `engageSubmission` 注册一条提交回显并在同一 tick 内将其退役——边缘完成锁定，且由于不会有任何持久 user message 观察到命令的提交身份，回显在绘制之前就已移除。Chat 目标的外壳活动判断（[`chatViewDefinition`](../../../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts)）把携带可见结果的已稳定命令计入活动——错误结果，或带文本的成功结果——因此纯命令的对话在历史加载时也会离开 blank 阶段；没有文本的生命周期稳定仍保留 hero。结果为带文本错误的命令行是一个可展开的披露行（[GenericCommandCard](../../../../packages/client/ui-chat/src/client/chat/GenericCommandCard.tsx)），即使单行红色摘要被截断，完整的结算文本仍然可达。

## Alternatives considered

**把处理器错误上抛为 Composer 通知。** 通知通道已经承载受理失败，复用它报告处理器错误改动很小。但它给出的是瞬时反馈，而产品的决策是持久的流式行，对成功结果只字不提，并且在行本可渲染的会话上造成双重报告。

**会话绑定时就激活 Chat 目标。** 急切激活会让每个已绑定会话——包括读者从未打开过对话的会话——都推进视图构建器，并使外壳活动脱离用户手势。提交时刻的边缘让点亮始终与提交这一手势绑定。

**宿主在 blank 位变化时主动推送。** 新增一条实时列表事件能从传输侧闭合同一缺口，但这是宿主侧的协议扩展，服务的是一个客户端在提交时刻已经掌握的事实。

## Consequences

命令提交在全新会话上和 prompt 一样停靠 Composer 并显示对话，持久行——成功或错误——成为可持久、可在刷新后保留的结果呈现面。Composer 对被受理的命令保持静默，符合既有设计；唯一命令无文本稳定的会话仍保留 hero。点亮是提交本地的：另一个客户端（CLI、ACP）在本浏览器持有的空白会话上执行的命令仍不会召出对话，因为本地没有任何东西翻转边缘。闭合该缺口需要 Conversation 组装器在没有挂载消费者的情况下激活视图目标，值得单独决策。

## Testing

命令运行时单元测试钉住认领与分离两条路径的"点亮并退役"边缘以及未绑定会话的跳过（[service.client.spec.ts](../../../../packages/client/ui-commands/tests/service.client.spec.ts)）；Chat 节点测试钉住带文本错误、带文本成功、无文本成功与执行中四种节点的 Shell 活动（[conversation-node-definitions.client.spec.ts](../../../../packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts)）以及错误披露行（[chat-view.client.spec.tsx](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx)）；一条免密浏览器用例以 `/feedback` 作为全新会话的首次提交，断言确认行、active 阶段、已清空的草稿且没有模型回合（[goal-command-presentation.e2e.ts](../../../../apps/web/tests/goal-command-presentation.e2e.ts)）。

## Related

外壳阶段推导与 `blank`/`engaging`/`active` 阶段属于 Conversation 骨架；事件折叠进目标快照的记录见 [Client Conversation node assembly](../architecture/2026-08-09-client-conversation-node-assembly.zh.md)。
