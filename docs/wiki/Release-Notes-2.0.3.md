# Einzbern 2.0.3 发行说明

[发行说明](Release-Notes.md) › Einzbern 2.0.3

## 模块目录

2.0.3 的发行说明按功能模块分为 7 个子章节，每个模块一页，可以只读需要的模块，并在模块页之间前后跳转。

| # | 模块 | 范围 | 条目 |
| --- | --- | --- | --- |
| 1 | [门与完成](Release-Notes-2.0.3-Gates-and-Done.md) | Story 按适用于它的门判定完成：必需门默认适用于库里的每个 Story，Initiative、Epic 与 Story 新增可向下继承的 `gates` 字段，`covers` 也可写 Initiative 或 Epic；门运行的树摘要改为 `einzbern.gate-tree.v2`，带 `--work-id` 的运行只计该 Story 的提交触及的路径 | 2 |
| 2 | [配置写入与 Owner 决定](Release-Notes-2.0.3-Configuration-Writes-and-Owner-Decisions.md) | 拒绝模型的八种配置写入可用 `--decided-in minutes:<id>#D<n>` 引用 Owner 决定，引擎在写锁内核对后放行，事件记录 `decidedIn`、`decidedInLibraryId` 与 `surface`，核对不过以 `MODEL_WRITE_AUTHORIZATION_INVALID` 拒绝；CLI 入口拒绝时的 stderr 带 `decidedIn` 与 `reason` | 2 |
| 3 | [工作租约](Release-Notes-2.0.3-Work-Leases.md) | `work-claim` 为工作项加租约（默认 2 小时，1 分钟到 24 小时），租约期间其他行动者对该项及其下层的写入以 `WORK_LEASED` 拒绝；`work-release` 释放租约，强制释放只在 Atelier；`work-show` 与 `work-list` 带 `lease` | 1 |
| 4 | [Atelier](Release-Notes-2.0.3-Atelier.md) | 启动须设 `TCRN_PORTAL_ACTOR`，未设时以 `PORTAL_ACTOR_REQUIRED` 拒绝；Atelier 的写入记录 `surface: atelier`；工作页显示租约并可强制释放；测试使用 `agent:test-portal` | 3 |
| 5 | [Mana Orchestrate 技能](Release-Notes-2.0.3-Mana-Orchestrate-Skill.md) | 技能导航说明多个会话可以同时在一个库里工作，引擎为写入排队；除迁移外，不要求用户停下其他会话 | 1 |
| 6 | [发行与仓库工具](Release-Notes-2.0.3-Release-and-Repository-Tooling.md) | CI `verify` 作业的时限由 15 分钟改为 45 分钟，步骤、命令与名称不变，`lessons` 作业仍为 5 分钟 | 1 |
| 7 | [从 2.0.2 升级](Release-Notes-2.0.3-Upgrading-from-2.0.2.md) | 读取同一个库的每台设备都先装 2.0.3；回退到 2.0.2 只在首次新格式写入之前安全；每个 Story 转为完成前再跑一次 `gates-run --work-id`；每个 Atelier 启动器都要设 `TCRN_PORTAL_ACTOR` | 4 |

## 版本摘要

Einzbern and Mana Orchestrate ship in lockstep at 2.0.3. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

## 关于本版说明

版本摘要与各模块页的条目正文逐字取自引擎仓库 tag `v2.0.3` 中的 `docs/releases/2.0.3.md`，只按功能模块重新排列，并为每个条目加了标题，没有删减或增补；其中「从 2.0.2 升级」一节原是一个列表，按列表项分为条目，每项原文不变。版本摘要的末句是发行脚本为每个版本写入的固定文字，2.0.3 的版本说明没有另列退役项。从 2.0.2 升级前，先读[从 2.0.2 升级](Release-Notes-2.0.3-Upgrading-from-2.0.2.md)模块。完整的版本说明以该文件为准。
