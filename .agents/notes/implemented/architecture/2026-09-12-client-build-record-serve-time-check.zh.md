# Agent Note: 服务时的客户端构建记录校验

Status: implemented

[English](2026-09-12-client-build-record-serve-time-check.md) | 中文

## Problem

客户端构建记录 `.dsh-build/client-build-environment.json` 把公共客户端构建环境绑定到一次完整根构建产出的确切产物。它的校验器只在发布工具与端到端测试中运行，因此部分重建——`pnpm --filter @deepseek-ai/dsh-web-frontend build`，或任何 tsdown client bundle 重建——改写了被服务的产物，而记录仍描述上一次构建。SPA 服务器按请求读取文件、不查阅记录：浏览器继续运行未知构建的代码且无任何报错，偏差只能靠人工比对 commit 戳才发现。

## Decision

构建记录模块位于 `@deepseek-ai/dsh-host-frontend-static`（`src/client-build-record.ts`）：SPA dist 服务器拥有它所服务前端的一致性契约，构建编排与发布工具通过该模块写入和校验。包的 `src` 在其 `rootDir` 下无法导入仓库的 `scripts/`，而 `scripts/` 可以导入包的 `src`——`scripts/client-build-environment.ts` 再导出记录 API，让它的构建期消费者保持单一导入路径；`tsconfig.client.json` 因把 scripts 模块纳入其程序而同时列出记录模块。

记录格式为版本 2，在完整产物 digest 之外新增一个 `dist` digest，它以 dist 根目录的相对路径对前端 dist 目录计算。服务器因此可以从它所服务的目录重算该 digest，无需了解仓库布局。

激活时 `frontend-static` 用从 dist 根目录向上找到的记录校验 dist。dist 不匹配或记录不可读时，输出可操作的 `console.error`，指明记录、记录的 commit 以及两条补救路径——刷新记录的完整构建 `pnpm run build`，监视循环 `pnpm run dev:web`。没有任何祖先记录的 dist 保持静默，因此自定义与 preview 部署照常启动，校验也绝不阻塞服务。`dev-web` 会提示记录只在完整构建时刷新，从而在源头说明监视循环的预期偏差。

## Alternatives considered

**包导入 `scripts/client-build-environment.ts`。** 包 tsconfig 的 `rootDir: src` 拒绝 `src` 之外的文件（TS6059），把仓库脚本打包进包的运行时会破坏已发布安装的产物平面。

**由组合应用把记录路径作为插件配置传入。** `dsh-web-app` 是唯一挂载者并自行解析 `distIndex`；可选配置字段会在恰好发生静默旧码失败的随附组合中默认关闭校验，而 dist 相对的记录发现不需要新的配置面。

**改为对 Git 做 commit 戳漂移检测而不摘要 dist。** commit 戳描述构建了哪些源码，而不是磁盘上有什么；重建过的 dist 配旧记录——本检查针对的失败——对戳比对不可见，脏工作区也让 HEAD 比对不可靠。

**在每个 index 请求时校验。** 按请求摘要 dist 把整目录遍历乘以页面加载次数，去捕捉激活时已经报告的偏差；服务器运行期间被改写的产物是 dev 循环的契约，不是不一致。

## Consequences

该校验只覆盖被服务的 dist：只重建 loader 交付的 `lib/client.js` 而不改写 dist 时，记录的 `dist` digest 仍然匹配，这种陈旧只能通过完整产物 digest 在发布工具与完整 `pnpm run build` 中暴露。`dev:web` 期间的服务器启动会打印不匹配警告，即使偏差是有意的；`dev-web` 中的 dev 循环提示解释了记录为何保持陈旧。格式 1 的记录会以重建补救信息校验失败，因此此更改之前写入的记录由下一次完整构建重新生成，而不是被继续信任。
