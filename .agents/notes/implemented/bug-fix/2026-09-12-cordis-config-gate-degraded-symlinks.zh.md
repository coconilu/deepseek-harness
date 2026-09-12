# Agent Note: The Cordis config gate resolves degraded git symlinks

Status: implemented

[English](2026-09-12-cordis-config-gate-degraded-symlinks.md) | 中文

## Problem

`verify-cordis-config` 此前对每个发现的 Loader 配置做字面的工作区读取。在 `core.symlinks=false` 的 Windows checkout（未开 Developer Mode 时的默认值）上，git 会把已登记的 symlink 物化为普通文本文件，内容是链接目标路径，于是门禁把 `apps/cli/tests/profiles/acp/cordis.yml` 的目标路径当 YAML 解析，报出 "root must be a Loader entry array"。该夹具用 symlink 是刻意的：它复用 `snapshots/acp/escalation-approved/` 下的已录制 ACP 快照组合，而不是复制一份。结果是在本应有效的 checkout 上，Windows 本地门禁长期预存红，而支持 symlink 的 CI 保持绿，且诊断信息指向 YAML 结构，而不是真正的成因——checkout 状态。

## Decision

门禁以 git index 作为「哪些路径是 symlink」的权威信号。对发现的配置文件执行一次 `git ls-files -s --literal-pathspecs`，收集 index mode `120000` 的记录（[`gitIndexSymlinks`](../../../../scripts/verify-cordis-config.ts)）；即使 checkout 把链接物化成了普通文件，index 仍记录着链接类型。随后每个配置都经 `readLoaderConfigText` 读取：真实 symlink 走 `readFileSync`，由它跟随链接；index 记为 symlink 但工作区是普通文件的路径属于退化记录——其内容就是已登记的链接目标，按 symlink 的解析方式相对记录所在目录解析，并可穿过后续退化记录继续链接，上限 16 跳。退化记录的目标无法解析时，通过门禁常规错误列表报出并附可操作的修复指引（`git config core.symlinks true` 后重新 checkout 该文件），不再以误导性的解析失败呈现。

平台语义与 CI 保持一致是构造保证的：跟随已登记目标复现了所有支持 symlink 的平台上 `readFileSync` 的读取结果，因此发现、条目校验与依赖闭包在本地与 CI 校验同样的字节。git 不可用或执行失败时不产生 index 记录，门禁退回逐字读取——即之前的行为，对引发本项的夹具依然是 fail loud。

## Alternatives considered

**把夹具 symlink 换成副本。** 否决：这会复制一份快照组合，此后每次修改都要落两处，否则两边漂移；而且只修好一个夹具，机制对下一个被 symlink 的配置依然损坏。symlink 正是测试 profile 与已录制快照保持同步的手段。

**对所有退化记录一律 fail loud 并给出指引，不跟随。** 否决其作为主行为：Windows 开发者在本应有效的 checkout 上会持续红，且本地除了需要特权的重新 checkout 外别无他法。仅指引的失败保留给无法解析的目标——那种情况下跟随本身不可能。

**仅凭内容形态判别（单行内容恰好能解析到已存在的 YAML 文件）。** 否决：git index mode 才是权威信号；内容启发式可能误判真正取值为标量字符串的配置，也可能在意外提交链接文本后静默校验错误的文件。

## Consequences

无 symlink 支持的 Windows checkout 门禁转绿，且与 CI 校验同样的组合字节；真正损坏的 checkout 得到的诊断会指明 checkout 状态与修复办法。门禁每次运行多一个只读 git 子进程；git 缺失或失败时退回逐字读取，而不是新增硬性依赖。`loadEntries`——preset 平面分离检查的读取器——仍是逐字读取；它的输入今天都是普通文件，且同样被主扫描循环校验，只有当那里的配置将来变成 symlink 时才需要同样处理。
