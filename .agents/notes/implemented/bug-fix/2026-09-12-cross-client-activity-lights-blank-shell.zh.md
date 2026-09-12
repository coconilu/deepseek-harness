# Agent Note: 跨客户端活动点亮 blank 空态外壳

Status: implemented

[English](2026-09-12-cross-client-activity-lights-blank-shell.md) | 中文

## Problem

[命令结果点亮 blank 空态外壳](2026-09-11-command-result-blank-shell-visibility.zh.md)恢复了本地提交命令的渲染路径，并记录了剩余限制：另一个客户端（CLI、ACP）在本浏览器持有的空白会话上执行的命令始终无法把对话带上屏幕。该限制背后的机制是 target 激活。Conversation 组装只为单调 active set 中的 target 物化快照，而这个集合此前只有两个来源——shell 的 View 选择和 target source 的首个 subscriber。从未挂载消费者的会话因此没有任何 active target：外部事件照常到达、Definition 照常匹配，但 `activityTargets()` 保持为空，外壳阶段停留在 `blank`，`ConversationSession` 继续渲染 null。激活同时也是活动分类的前提——只有物化后的快照才能被询问 `isActive`。

## Decision

Assembler 现在从会话活动本身激活 target。[ConversationNodeAssembler.activateWithoutConsumers()](../../../../packages/client/ui-conversation/src/client/conversation/assembler.ts) 在活动已经到达（事件窗口非空）且尚无 active target 时，把每个已定义的视图 target 加入 active set；逐会话的 binding 在每次 replace、prepend、append 与 Assistant settlement 之后调用它——[Conversation binding feed](../../../../packages/client/ui-conversation/src/client/conversation/assembly.ts) 中的 `engageConsumerless`——让同一次 flush 物化首批快照。激活保持单调且由活动触发：没有收到事件的会话永不激活并保留 hero；收到首个事件的会话只支付一次激活成本，与 shell 选择的效果完全一致。什么算可见活动仍由各 target 的 `isActive` 决定；命令结果修复确立的 Chat 规则原样适用，因此即使 target 已激活，无文本的生命周期稳定仍保留 hero。

## Alternatives considered

**会话绑定时激活 target。** 命令结果修复已经否决过这一方案：它让每个已绑定会话都急切地推进视图构建器，并使外壳活动脱离用户手势；而且绑定时的空窗口什么也证明不了。由活动触发的激活只向真正收到事件的会话收费。

**命令稳定时翻转宿主列表的 blank 位。** 这是宿主侧的协议扩展，会改变与 connectWorkspace 复用资格共享的 blank 语义，而且活动分类反正仍在客户端。本浏览器未持有 current 的会话的列表可见性缺口另行跟踪。

**客户端 Session 在收到持久事件时降低自身 blank 位。** 客户端镜像跟随宿主 summary 的权威（blank = 没有记录 turn/start），本地降低会偏离镜像且修不好外壳——外壳离开 blank 靠的是 target 活动，而不是 Session 的 blank 位。

## Consequences

另一个客户端在本浏览器持有的会话上产生的活动——携带可见结果的已稳定命令，或任何模型回合节点——现在无需挂载消费者即可到达外壳：对话在首个被分类的活动上离开 blank 阶段，渲染持久行（错误在内），与本地提交的表现完全一致。没有收到活动的会话行为与从前完全相同，提交本地的点亮边缘仍是本地发送的首帧路径。残余缺口是转移而非消失：本浏览器持有但非当前选中的空白会话仍没有知晓纯命令活动的通道（宿主列表没有对它的实时推送，工作区树也隐藏 blank 摘要），其对话要在会话被选中后才能到达。

## Testing

Conversation registry 测试钉住全部四条边缘：无消费者 binding 在外部 `command/run` 加 `command/done`（带文本错误）上点亮外壳；无文本的成功稳定保持 blank 阶段；仅绑定或仅空窗口永不激活 target；shell 已选中的 target 在外部活动下仍然点亮（[conversation-registry.client.spec.ts](../../../../packages/client/ui-conversation/tests/conversation-registry.client.spec.ts)）。命令结果修复的测试套件——命令运行时的点亮边缘、Chat 活动分类、goal-command 浏览器用例——继续覆盖提交本地路径。

## Related

[命令结果点亮 blank 空态外壳](2026-09-11-command-result-blank-shell-visibility.zh.md)拥有本笔记依赖的提交本地点亮边缘与 Chat 活动规则；[Client Conversation node assembly](../architecture/2026-08-09-client-conversation-node-assembly.zh.md)拥有本笔记扩展的 active-target set 与 View Builder 机制。
