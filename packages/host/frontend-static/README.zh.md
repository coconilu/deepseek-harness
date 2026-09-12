---
description: "Web 壳的 SPA dist 服务器：占据 webserver 回退席位，以遍历拒绝与 SPA index 回退服务已构建的前端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-frontend-static

[English](README.md) | 中文

## 概述

从配置的发布目录向浏览器提供已构建的 Web 壳。根路径与配置的 index 路径渲染包含启动信息的 index；已有资产直接提供，而缺失或非文件路径返回 404、路径遍历返回 403、不支持的方法返回 405。访问 index 需要有效的进程 token 或浏览器 cookie，但静态资产仍可公开访问。同一时间只能有一个实例处理未匹配的路由；第二个实例启动失败，卸载活动实例后，未匹配的请求返回 404。

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

在服务已构建 Web 壳的浏览器宿主中组合本插件：它占据 webserver 的回退席位，并应答所有未被具名路由命中的请求。它只需要一个配置值——已构建前端的 `index.html` 位于何处。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-host-frontend-static'
  config:
    distIndex: /absolute/path/to/dist/index.html
```

`distIndex` 是组合应用的组装事实：[`dsh-web-app`](../../bundle/web-app/README.zh.md) 通过前端包的 exports 解析它并挂载本插件；部署绝不硬编码它。

### 服务器实施的约束

请求从 dist 根目录（包含 `distIndex` 的目录）提供。dist 根目录与配置的 index 路径以 HTTP 200 渲染 `index.html`；任何其他已有文件按自身 MIME 类型直接提供，未知扩展名按 `application/octet-stream` 提供。解析到根目录之外的路径以 403 拒绝，因此精心构造的路径无法读取 dist 之上的文件。dist 根目录内不存在或不是文件的目标——文件缺失、目录或配置的 index 缺失——返回空 404。没有匹配具名路由的非 GET／HEAD 请求返回 405。每个成功的 index 响应都经 webserver 的 `renderIndex` 渲染，因此启动 manifest（元数据清单）会通过 `/` 与配置的 index 路径送达页面。

根路径与配置的 index 响应会在读取 HTML 前调用 `ctx.connection.authorizeIndex`。有效进程 token 会得到 303 重定向与持久浏览器 cookie；已有有效 cookie 时直接提供 index；其他 index 请求得到 Connection 所有的 401 响应。非 index 文件仍是公开静态资源。Token、cookie、过期时间与签名记录语义都归 Connection 所有。

### 可观察的失败

遍历返回 403 而不是错误页。dist 根目录内不存在或不是文件的目标返回空 404，因此失效链接或拼错的 pathname 是显式失败，而不是静默的 SPA 回退。第二次占据席位会抛错，而席位无人占据时 webserver 返回 404——本插件的 fiber 被 dispose（资源释放）后，浏览器看到的就是该响应。

### 客户端构建记录检查

激活时，本插件用最近的客户端构建记录（`.dsh-build/client-build-environment.json`，从 dist 根目录向上查找）校验 dist，当记录不再描述所服务的文件时输出可操作的 `console.error`。像 `pnpm --filter @deepseek-ai/dsh-web-frontend build` 这样的部分重建会改写 dist 却不刷新记录，没有该检查时浏览器会继续运行未知构建的代码且无任何报错。任何构建树之外的 dist 找不到记录并保持静默，检查也绝不阻塞服务；它给出的补救是刷新记录的完整构建 `pnpm run build`，或监视循环 `pnpm run dev:web`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

本包是围绕 `serveStatic` 的一个函数插件：`apply` 从 `distIndex` 解析出 dist 根目录，用最近的客户端构建记录校验 dist，构建一个对原始 `index.html` 运行 `ctx.webServer.renderIndex` 的 `renderIndex` 闭包，并在 effect 作用域下注册回退 handler。按 webserver 的约定，席位只有单一所有者——第二次注册会抛错——且受 effect 作用域约束，因此 dispose fiber 即释放席位。

### 遍历栅栏

`serveStatic` 规范化请求的 pathname 并拼接到 dist 根目录，然后要求目标就是根目录本身或保持在它之下。检查使用 `sep` 而非 `/`，因为 `resolve()` 在 Windows 上输出反斜杠路径，此时 `/` 后缀会把每个合法子路径都当作遍历拒绝。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `serveStatic` 与 `apply`：回退占据、遍历拒绝、index 渲染、MIME 表 |
| [`src/client-build-record.ts`](src/client-build-record.ts) | 客户端构建记录 schema、产物 digest 与所服务 dist 的校验 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当服务约定不够用时阅读以下内容：先看席位所有者的约定，再看解析 dist 的组合与子系统参考。

- [Webserver](../webserver/README.zh.md)——本插件占据的回退席位与它运行的 index 转换器。
- [dsh-web-app 组合包](../../bundle/web-app/README.zh.md)——解析 `distIndex` 并挂载本插件的应用。
- [HTTP 服务器子系统](../../../docs/subsystems/web-server.zh.md)——回退席位如何融入路由表。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-frontend-static)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。该 SPA dist 服务器只应答浏览器资产请求，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明某个资产类别何时尚未被覆盖。它们是当前包约束，不是任务积压。

- **初始 MIME 表很精简**：它覆盖 Vite 输出的资产集合及实际交付的 PWA manifest；其他扩展名在相应资产类别发布前都会回退到 `application/octet-stream`。
- **Pathname 路由是显式声明**——当前客户端从根目录或配置的 index 路径进入，没有 History API pathname 路由。新增一条需要显式服务器规则与真实组合覆盖，而不是对每次未命中做宽泛回退。
- **构建记录检查只覆盖所服务的 dist**——只重建 loader 交付的 `lib/client.js` 而不改写 dist 时，记录的 `dist` digest 仍然匹配；发布工具与完整 `pnpm run build` 会校验完整产物记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。唯一受本包所有的关系是单个回退席位，但无法从 teardown 流中探测它：`internal/plugin` 在正在释放的 fiber 执行 effect disposer 前触发，因此通知发出时合法所有者仍占据席位，任何占位探测都会把每次正确释放误报为失败；这不同于 webserver companion 对保留路径的探测，后者不会与存活注册冲突。席位的注册／释放对称性由本包真实组合的 HMR（热模块替换）安全测试覆盖。
