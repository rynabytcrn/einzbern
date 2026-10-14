# Einzbern 2.1.0 发行说明

[发行说明](Release-Notes.md) › Einzbern 2.1.0

## 模块目录

2.1.0 的发行说明按功能模块分为 8 个子章节，每个模块一页，可以只读需要的模块，并在模块页之间前后跳转。

| # | 模块 | 范围 | 条目 |
| --- | --- | --- | --- |
| 1 | [门与完成](Release-Notes-2.1.0-Gates-and-Done.md) | 带 `--work-id` 的运行按该 Story 自己的文件内容取树摘要（`einzbern.gate-tree.v3`），别处的提交或文件不再使运行过期；完成检查复读这些文件并比对，`WORK_DONE_GATES_NOT_RUN` 的详情带 `changedPaths` 与 `addedPaths`；`gates-run` 用 `EINZBERN_GATE_RUN_PRIOR` 把同一运行里已结束的门交给每个门进程 | 2 |
| 2 | [工作租约](Release-Notes-2.1.0-Work-Leases.md) | Story 转为完成与 `work-batch` 的转态、注解成员先核租约再判门，受他人租约约束时以 `WORK_LEASED` 拒绝；租约检查先用写入的严格时刻解析 `--at`；`work-delete` 与 `project-delete` 在同一追加里清掉租约，运行中的租约使 `project-delete` 以 `WORK_LEASED` 拒绝，CLI 入口随之打印 `projectId` | 3 |
| 3 | [门与规则提议](Release-Notes-2.1.0-Gate-and-Rule-Proposals.md) | `gates-config-propose` 与 `rule-propose` 让模型提议门或规则的改动，提议存入封闭的 `proposal` 集合，待定时不生效；`proposal-approve` 与 `proposal-reject` 只在 Atelier 运行，批准记录 `decidedIn` 的新形式 `proposal:<key>@<proposed-at>`；`gates-config-list` 与 `rule-list` 新增 `--status`（declared、pending、rejected） | 1 |
| 4 | [Atelier](Release-Notes-2.1.0-Atelier.md) | 门页与规则页在声明之外列出本页的提议，待定在前、已拒在后，各带状态标记；待定行的批准与拒绝以 `TCRN_PORTAL_ACTOR` 运行；文案覆盖五种语言 | 1 |
| 5 | [并发与设备状态](Release-Notes-2.1.0-Concurrency-and-Device-State.md) | 库写锁只包追加；`WORKSPACE_LOCKED` 写出持有者，取写锁的写入接受 `--timeout-ms`；用户 crest 的读取取自快照；注册项目里的每次提示在 `log/hook.ndjson` 留一行；`gates-run`、全量测试、门户证明链与 release finish 先取机器级重活槽，槽数由 `execution.maxConcurrentHeavyRuns` 设定 | 5 |
| 6 | [知识与纪要](Release-Notes-2.1.0-Knowledge-and-Minutes.md) | 知识卡与纪要的冲突守卫按 INIT 族区分：只与其他族冲突时照常写入并给出警告，与同族或族未知者冲突时仍拒绝；`--supersedes` 与 `--coexist` 不变 | 1 |
| 7 | [发行与仓库工具](Release-Notes-2.1.0-Release-and-Repository-Tooling.md) | `gates-run --release` 里同一运行已过全部 P1 腿时，push gate 不再跑 `verify:p1`（`P1_COVERED_BY_GATE_RUN`）；发行政策：2.0.3 之后改格式版本或事件形状升 minor；门户的 DS 对账与快照生成从 DS 的 git 对象读绑定候选的 `Navigation.tsx` | 3 |
| 8 | [从 2.0.3 升级](Release-Notes-2.1.0-Upgrading-from-2.0.3.md) | 读取同一个库的每台设备都先装 2.1.0；回退到 2.0.3 只在首次提议类写入之前安全；2.0.x 记下的门运行不再计入完成，转为完成前在 2.1.0 上再跑一次 `gates-run --work-id`；新的设备级状态；在含本版的树上跑门不再需要 `TCRN_DESIGN_SYSTEM_ROOT` | 5 |

## 版本摘要

Einzbern and Mana Orchestrate ship in lockstep at 2.1.0. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

## 关于本版说明

版本摘要与各模块页的条目正文逐字取自引擎仓库 tag `v2.1.0` 中的 `docs/releases/2.1.0.md`，只按功能模块重新排列，并为每个条目加了标题，没有删减或增补；其中「从 2.0.3 升级」一节原是一个列表，按列表项分为条目，每项原文不变。版本摘要的末句是发行脚本为每个版本写入的固定文字，2.1.0 的版本说明没有另列退役项。从 2.0.3 升级前，先读[从 2.0.3 升级](Release-Notes-2.1.0-Upgrading-from-2.0.3.md)模块。完整的版本说明以该文件为准。
