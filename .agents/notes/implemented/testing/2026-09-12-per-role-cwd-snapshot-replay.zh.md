# Agent Note: Per-role cwd replay in recorded-session snapshots

Status: implemented

[English](2026-09-12-per-role-cwd-snapshot-replay.md) | 中文

## 问题

已录会话 fixture 把每条会话日志按其自身会话 header 做 token 化：header cwd 与每个以该 cwd basename 结尾的绝对路径都变成 `{{cwd}}` token。而比较时把一次运行的所有日志都用主会话的 cwd 归一化。两份契约只有在所有子会话与父会话共享 cwd 时才一致，这个巧合掩盖了结构性缺口：子会话 cwd 与父级不同时——真实的 tower mission 拓扑，mission 子会话运行在 `.tower/worktrees/` 下的 git worktree——比较结果会得到 `{{cwd}}/<worktree 后缀>`，而子 fixture 是按自身 header token 化的裸 `{{cwd}}`。每个子 cwd 下的绝对路径都以同样方式失配。这个缺口挡住了真实 tower mission 子拓扑的 keyless 覆盖，迫使 tower-merge-flow 场景让 mission 子会话运行在 lead 的 cwd 里、用 worktree 相对路径工作。tower 激活态的 Web 快照 fixture 同样缺失；录制它需要本工作没有的带 key 实录 lane。

## 决策

headless 快照 harness 按会话角色归一化。会话日志比较（`normalizeSessionSnapshotsPerRole`）、refresh 对齐、子会话 prompt sidecar 各自从日志自身 header cwd 派生易变值 context；共享的主 context 只保留在比较值不含 cwd 的地方——request-header pin。cwd 与主会话相同的日志在两种 context 下归一化结果完全一致，所有既有 fixture 不受影响。跨日志的 typed identity redaction 保持全局，`{{session:N}}` 关系在按角色拆分后依然成立。suite 级测试钉住这个定点：header cwd 位于父级之下的子日志与其已提交 fixture 字节相等，而共享 context 路径做不到。

这份契约继承了自身 header token 化的约束：在子 cwd 与父 cwd 之间交叉的绝对引用没有稳定的 token 形式，场景必须让子日志不出现它们。tower-mission-worktree 场景在构造上满足这一点——子会话的 mission prompt 不含路径、子会话用相对路径访问自己的工作区——而父日志以父级锚定记录 worktree 路径 `{{cwd}}/.tower/worktrees/m-1`。

### tower-mission-worktree 场景

该场景（`snapshots/session/tower-mission-worktree/`）端到端证明真实拓扑：场景本地的确定性 tower provider 真实执行 `git worktree add .tower/worktrees/m-1 -b tower/m-1 main` fork 出 worktree，并以 worktree 作为持久会话 cwd 启动 mission 子会话——正是 [已录会话快照语料](2026-08-24-session-log-snapshot-corpus.zh.md) 这层设计迫使早先 tower-merge-flow 场景的 fixture provider 记载要绕开的那个拓扑。它的 git workspace setup 变体提交空根提交，使种子工作区不含受配对门约束的 README 文件；固定的日期与身份仍能复现稳定哈希。

场景声明 `platform: posix`，原因与 merge-flow 场景已记录的相同：tower 工具结果内嵌 JSON 字符串化的工作区路径，Windows 反斜杠转义会在这一字符串层级击穿 cwd token 化。必选的 macOS/Linux lane 重放它；Windows 跳过运行测试，而 fixture 保护在所有平台继续覆盖已提交字节。

### tower 激活 Web fixture 的后续

Web composer 的 Tower chip 读取 `tower` projection，而该 projection 派生自会话日志记录的 `tower/mode` 激活，因此 fixture 形态是一个会话日志携带该激活的 Web lane 场景。通过 `DSH_SNAPSHOT=record` 录制需要 `DEEPSEEK_API_KEY`；做出本决策的环境没有它，所以 fixture 延期而非手写——chip 的 pending/effective-target 语义应当先对一次实录钉住，再冻结手写 fixture。

## 考虑过的替代方案

**在 `@deepseek-ai/dsh-session-snapshot` 内做 per-role cwd alias。** 按 test-support finding 的原始建议扩展 `NormalizeContext` 是系统性的归宿，还能在一处同时修正 fixture token 化与 refresh 对齐。它在这里落选仅因 scope：M16 的改动拥有 `snapshots/**`，包级改动值得独立的设计过程。若未来出现更多角色布局，它仍是正确的跟进方向。

**通过父 cwd header 重写来 token 化子 fixture。** 在 token 化之前把子日志 header cwd 改写成父级、再恢复 `{{cwd}}/<后缀>` 形式，会把 worktree 后缀写进已提交的子 header。它被拒绝：带后缀的 token 会在 refresh 时成为 tokenizer 自己的锚点，把每条已 token 化的正文路径剥掉后缀、并把锚点改挂到 worktree basename 上，破坏写回。比较侧的 per-role 契约在不触碰 fixture token 化的前提下达成了稳定。

**工具结果里的相对 worktree 路径。** 让 mission view 渲染 worktree 相对路径可以从 lead 日志中移除所有绝对路径，并让场景在 Windows 可运行。它被拒绝：已提交字节将无法区分"运行在 worktree 的子会话"与"运行在父 cwd 的子会话"——整个证明都压到 workspace oracle 上，削弱 fixture。

## 后果

已录会话覆盖现在能 keyless 地表达真实 tower mission 子拓扑，harness 契约也与它所比较的 fixture 契约一致，不再依赖"子 cwd 等于父 cwd"的巧合。代价是 fixture 作者必须同时持守两条约束：子日志不得引用父 cwd 绝对路径，把工作区路径 JSON 内嵌进工具结果的场景留在 POSIX lane。tower-merge-flow 场景现在可以在该 lane 迁移到真实 worktree 子拓扑；在迁移之前，本 note 的 per-role harness 契约与该场景各自独立成立。
