# Agent Note: Cordis 目录将接口继承成员展平进服务表面

Status: implemented

[English](2026-09-12-cordis-catalog-heritage-flattening.md) | 中文

## Problem

生成的 Cordis 目录只按 Service Definition 自身声明的成员列出每个 `ctx.<key>` 服务的成员。通过 `extends` 组合契约的 Service Definition 因此在目录里不完整：`ctx.tower` 的类型是 `TowerService extends TowerOperations`，而未导出的 `TowerOperations` 接口声明了调用方可调用的十四个操作中的十二个。面向模型的运行时目录（`packages/extensions/tool-cordis/src/api-catalog.ts`，经 `cordis_inspect` 提供）只显示 `registerProvider` 和 `mode`，`docs/subsystems/tower.md` 上的生成区域同样如此，而该页手工维护的类型等价块把十二个共享操作单独记录了一遍。生成器及其文档都没有声明这一省略是有意的设计，而运行时目录自身的横幅却声称它与渲染文档不会分歧。

## Decision

Cordis 目录投影（`packages/typert/generator/src/cordis-catalog.ts` 中的 `collectServices`）现在会遍历 Service Definition 的接口 `extends` 链，并把继承成员列在声明成员之前；同名时声明成员胜出，声明与继承的重载组都保持完整。继承成员与声明成员一样通过 JSDoc 完整性和类型链接门禁。遍历只解析同 face 的接口声明：harness 服务类的基类是框架管线（`Service`、`TypertRemoteService`），其成员属于继承层（[inherited.md](../../../../docs/cordis-api/inherited.md)），而跨 face 或外部继承由声明方的目录记录，两者都跳过。`ctx.tower` 的目录条目先列出十二个共享操作，再列出 `registerProvider` 和 `mode`；`TowerProvider` 实现走同一遍历。

重新生成的产物是 `packages/extensions/tool-cordis/src/api-catalog.ts` 以及 tower 子系统页语言对的生成区域。该页手工维护的"共享操作"块仍是对 seam 设计的解释；生成区域是机械的成员列表。

## Alternatives considered

**保持投影只看声明成员，共享操作靠手工记录。** 这是改动前的状态。只要某个 Service Definition 通过 `extends` 组合契约，面向模型的目录就会静默退化，而且这是生成目录与渲染文档在覆盖面上唯一不一致的地方。

**类继承也展平。** 类上可调用的继承成员确实属于类类型服务的表面，但每个被编目的服务类的基类都是框架基类，其成员要么本来就被跳过（`typertRemote`），要么已由继承层覆盖；展平只会给所有类服务加上框架管线，没有具体消费方。

**在 analyzer 而非目录投影里展平。** `ServiceModel.members` 同时供给 Remote 端点建模和目录使用，而"目录记录什么"是投影器已拥有的投影决策（JSDoc 与类型链接门禁都在那里）。把遍历移进 analyzer 会为一个消费方的需求改动共享模型。

## Consequences

Service Definition 无法再把操作藏在基接口里躲开目录，tower 的运行时目录现在无需查文档即可回答操作问题（签名、调用方权限、结果类型）。类型链接覆盖与 JSDoc 完整性同样约束继承成员，未来某个缺契约文字的继承声明成员会让 `gen-cordis-catalog` 失败，而不是渲染出裸签名。继承遍历走 analyzer 已记录的 `extends` 节点，不引入第二次类型解析。`packages/typert/generator/tests/cordis-catalog.spec.ts` 在逐字节产物复现之外固定了展平后的 `ctx.tower` 成员顺序。

## Related

生成的运行时目录的单一 AST 来源由[自引用 cordis 工具集笔记](../feature/2026-07-08-self-referential-cordis-toolset.zh.md)决定；本变更关闭了它唯一的覆盖分歧。
