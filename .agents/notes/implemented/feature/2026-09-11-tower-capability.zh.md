# Agent Note: Tower coordination over isolated git worktrees

Status: implemented

[English](2026-09-11-tower-capability.md) | 中文

## 问题

可续聊 subagent 与 [Agent Teams](2026-08-05-agent-teams.zh.md) 让一个 lead 会话拥有并行的子代理，但每个子代理都共享父会话的 checkout：文件工具能拒绝过期版本，而 Bash、格式化工具与生成器会绕开这道栅栏，且 Teams 备注刻意把 worktree 隔离留在那个域之外。因此，把一个大改动拆给并行子代理的 lead 没有一条从「分派」到「落地」的受管路径：逐 mission 的分支、可评审的门禁、合并回 base 的受控过程、以及记录谁做了什么的审计痕迹，全都只能靠部署临时拼凑。

协作状态同样没有能活过单个会话的家。subagent 收件箱与 Team roster 状态是会话或进程级的，而 mission 工作必须活过子代理结算、lead 重启与冷 resume，并且能被后来的 lead 会话接管，而不必重新推导发生过什么。

## 决策

tower 是 `ctx.tower` 上的三包能力缝，按 profile 经 `dsh-base` 之上的 `dsh-tower-profile` bundle 显式启用；没有任何出厂 profile 启用它。`dsh-tower` 是 Service Definition：它拥有唯一一条 log-only、整值替换的 `tower/mode` 会话事件（由 `tower` 投影折叠——plan mode 机制：回合之间的选择立即提交，回合内的选择保持 pending 直到下一个被接受的 pre-step）、`/tower` 命令（其 `on <base>` 选择在任何内容落盘前先经 provider 校验）、模式激活期间渲染的 `tower:policy` 提示词段落，以及每项操作都要经过的、校验调用者权限的门面。`dsh-tower-local` 是出厂 Service Provider：工作区 git 根的 `.tower/` 协调存储、经 subprocess 接缝驱动的 git worktree，以及作为可续聊 subagent 组合、`cwd` 绑定到 mission worktree 的 mission 子代理——即[子代理 start-request 备注](2026-09-10-subagent-start-request-cwd.zh.md)的逐子代理工作目录。`dsh-tool-tower` 是面向模型的 Consumer：十个 `tower_*` 工具，其权限在执行器与门面内部各强制一次。

权限按操作拆分。工作区、评审与生命周期操作（`init`、`spawnMission`、`abortMission`、`recordReview`、`merge`、`teardown`）仅限 lead——调用会话必须处于激活的 tower 模式。通信集合（`status`、`sendMessage`、`inbox`、`recordFinding`、`listFindings`）额外放行未合并 mission 的已记录拥有者，该身份从 mission 记录读取，冷 resume 后依然有效。mission 子代理经配置的 `childProvider` 组合，部署的 `childToolFilter` 从每个子代理的工具集中拒绝列出的名字；`dsh-tool-tower` 导出 `MISSION_TOOL_FILTER`，让子代理在可见性层面被拒掉六个 lead 专属工具名，而执行时权限仍是第二道防线。

持久的 mission 状态落在文件而不是会话日志：`workspace.json`、逐 mission 记录与 append-only 的消息、发现、活动、评审 journal 都在 `.tower/` 里，每次读取都做 zod 校验；接管既有工作区——记录的 base 一致——会带上未合并的 mission，并把 owner 已不存活的 mission 标记为 `interrupted`。lead 会话日志只携带模式，「模型可见即落盘」因此保持成立，工作区同时保持多会话持久。

## 合并门禁

只有当 mission 处于 `approved`、最近一轮评审是批准且其记录的 commit 仍等于 branch tip、mission worktree 干净、且主 checkout 停在记录的 base 上时，合并才会进行；合并使用 `--no-ff`，并把合并 commit 记入活动 journal。tip 一致条件让每份评审结论只适用于确切的 commit，评审后的任何改动都会让 mission 重新打开。`tower_merge` 与 `tower_teardown` 还要求经审批接缝获得用户批准，接缝缺席时以失败告终。包不变式伴生入口会让任何没有针对确切被合并 commit 的批准评审轮次支撑的合并活动条目失败，journal 因此无法记录一条评审痕迹解释不了的合并。

## 备选方案

**给 Agent Teams 扩展 worktree 隔离。** 否决，因为 Teams 刻意保持 same-world 契约——沙箱与文件系统 compare-and-set 已经描述了那个域，从 team 成员身份推导分支、合并策略与清理会悄悄改变现有部署依赖的语义。tower 把 git 生命周期作为显式启用项持有，而不是让 team 成员身份暗示它。

**由一个包同时拥有模式、git 与工具。** 否决，因为三个角色独立演化：远程或托管 provider 不应拖上工具消费方，而消费方离开任何 provider 都没有用处。能力缝规则要求三个角色一并设计、各自持有。

**把 mission 状态放进 lead 会话日志。** 否决，因为工作区活得比任何一个 lead 会话久：mission 记录必须能被同进程或另一进程中的后续会话接管，而会话日志是单会话持久的。`.tower/` 下的文件记录承载多会话事实，日志只承载投影折叠的模式。

**在 mission 子代理之间直接投递消息。** 否决，因为相邻 Agent 消息只授权直接父与直接子两条边，而经存活 lead 路由保住了单一权威点、单一投递词汇，以及「谁告诉了谁什么」的完整活动记录。

**没有记录评审轮次就合并，或使用 fast-forward。** 否决，因为评审门禁就是产品本身：一次合并必须能从记录解释为「一份批准恰好覆盖了这个 commit」，而 `--no-ff` 让每个 mission 的出处即使在工作区移除后仍能在 base 上看到。

**在服务层对 mission 子代理隐藏 lead 专属工具。** 否决，因为可见性是组合选择而非服务属性；硬编码拒绝清单会让 tower 服务耦合到它不拥有的工具名。配置字段加上导出的 `MISSION_TOOL_FILTER` 让清单保持显式，过滤器缺席时执行时权限仍会响亮失败。

## 测试

各包测试套件覆盖投影折叠与模式生命周期、服务/provider/工具的加载组合、mission 供应与回滚、评审门禁与合并拒绝、消息 journal 与投递、不变式伴生入口，以及 `MISSION_TOOL_FILTER` 组合。tower profile bundle 测试钉住三行 patch 并经真实 Loader 启动，在组合出的树上断言 `/tower` 命令、十个工具与逐字一致的策略段落。

## 后果

lead 换来的是每个 mission 的物理隔离、仅凭记录即可解释的合并、活过子代理结算与 lead 重启的协作状态，以及 `.tower/` 下的审计痕迹。代价：组合后的 profile 在每个请求上支付策略段落与十个工具 schema 的费用、工作区要求本地 git checkout、存储串行化是进程内的因此共享工作区的并发进程在文件系统层面竞争，且回合最后一次被接受的 pre-step 之后做出的待生效模式选择在进程退出时丢失。

具名覆盖缺口：生成的工具、配置、持久化与 Cordis 目录以及网站页面清单尚未覆盖 tower 面；类型词汇在 [tower 子系统页](../../../../docs/subsystems/tower.zh.md)以清单校验的类型等价块记录，各目录待其生成器下次运行时跟进。

## 相关

[Agent Teams 备注](2026-08-05-agent-teams.zh.md)持有 tower 刻意不进入的共享 checkout 协作域；[子代理 start-request 备注](2026-09-10-subagent-start-request-cwd.zh.md)持有 mission worktree 绑定所依赖的逐子代理工作目录。
