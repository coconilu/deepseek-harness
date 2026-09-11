# Agent Note: Web composer Tower-mode chip

Status: implemented

[English](2026-09-12-web-composer-tower-mode-chip.md) | 中文

## 问题

运行 `/tower` 后，web composer 没有任何可见标识表明 tower 模式生效。该模式是 log-only 的 `tower/mode` session 事件，由 Host 的 `tower` 投影折叠，折叠值本来就已通过通用投影通道到达浏览器，但没有任何 UI 呈现它；用户无法分辨哪些会话持有 tower 权限。展示面必须从持久化投影派生，且不得引入客户端折叠、客户端状态或新的模型可见输入。

## 决策

`ui-conversation` 在 composer 的 modes 行、Access 触发器与 plan seat 之间渲染一个只读的 Tower 状态 chip。chip 读取通用 `useProjection('tower')` seat，并跟随投影的 effective target（`pending ? !active : active`），因此进行中的 `/tower on` 已显示 chip，正在离开的选择已隐藏 chip。激活时显示本地化的 `Tower` 标签、记录的 base 分支（`Tower · master`）和 tooltip；模式关闭与 tower 能力缺席（无投影值）都不渲染，投影缺 base 时保留标签与纯文本 tooltip。

chip 与 Access 触发器一样属于 conversation 自有的 composer chrome，而不是独立特性插件：它是无行为的纯展示，不需要命令通道、store 或专属 slot seat。文案位于 `conversation` locale 字典（中英双侧）。

`tower` key 由此变为客户端可类型化读取：`tower` 投影类型及其 `SessionProjectionMap`/`SessionProjectionStateMap` merge 从 `@deepseek-ai/dsh-tower` 的 Host 入口移入 `src/projection.ts` 叶子模块。`types.ts` 为 Host 消费方再导出该叶子，并保留 `ctx.tower` 的 Context 声明——`./types` 面是 provider 包编译所依赖的契约面；新增的纯 `./client` 面（`export type * from './projection.ts'`）供给客户端程序，把 Host 的 Context merge 挡在客户端编译之外（"one program must not hold both sides"）。

## 已考虑的替代方案

**独立的 `ui-tower` 插件占据新 composer seat。** 与 plan chip 同形，但为交付一个无行为的 chip 需要新建包并注册 web-app bundle。conversation 已拥有投影驱动的 composer chrome（Access 触发器），因此 chip 落在 conversation；若 chip 未来执行 `/tower off` 或打开菜单，再迁往独立插件与 seat。

**在客户端代码里声明投影 merge。** 在 `ui-conversation` 内重述 `tower` merge 可以在不触碰 tower 包的前提下类型化 `useProjection('tower')`，但这给该事实制造了第二个家，并让 wire view 可能偏离 Host 折叠。以投影叶子模块扩展 tower 包才是保持单一 owner 的做法。

**在 conversation fold 中从原始 `tower/mode` 事件派生模式。** Conversation Node 纪律允许这样做，但这会在客户端重新实现 Host 折叠；投影已经下发折叠后的完整值，第二个折叠点是第二处需要保持正确的地方。

## 后果

凡折叠后的 tower 投影为激活态的会话都会显示 chip，包括从激活过 tower 模式的日志重放的历史会话。无 tower 能力的会话保持该行不变，因此从未激活 tower 模式的已录制 web 期望输出不受影响。`./client` face 为 `@deepseek-ai/dsh-tower` 的发布面增加一个导出；它是纯类型导出，运行时产物不增长。任何客户端包现在都可以类型化读取 `useProjection('tower')`，tower 包继续作为该事实的唯一拥有者。
