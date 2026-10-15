# Einzbern 2.2.0 发行说明

[发行说明](Release-Notes.md) › Einzbern 2.2.0

## 模块目录

2.2.0 的发行说明按功能模块分为 9 个子章节，每个模块一页，可以只读需要的模块，并在模块页之间前后跳转。

| # | 模块 | 范围 | 条目 |
| --- | --- | --- | --- |
| 1 | [并发与设备状态](Release-Notes-2.2.0-Concurrency-and-Device-State.md) | 提议及其批准与拒绝、`work-delete` 与 `project-delete`、受管段写入、`artifact-put` 与几种知识写入只在追加时持库写锁，锁外读与判、追加处再判；批准与删除在追加处按同样的原因码再判；`snapshot-manifest` 不取锁，`workspace-relocate` 遇并发写入以 `RELOCATE_COPY_MISMATCH` 安全失败；`knowledge-batch` 不再从第一个成员持锁到最后一个 | 4 |
| 2 | [知识与纪要](Release-Notes-2.2.0-Knowledge-and-Minutes.md) | 记录的 INIT 族也从本库所持工作记录的完整外部键与卡的关联工作读取；两族都已知且不同的未决卡对在读取时搁置，知识提示省去其他族的卡并给出条数（回执的 `filteredByFamily`） | 2 |
| 3 | [受管段、Command Spell 与变量](Release-Notes-2.2.0-Managed-Sections-Rules-and-Variables.md) | 协调库向设备注册表为它登记的容器写受管段，库内的根以 `MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY`、未登记的根以 `MANAGED_SECTION_OUTPUT_UNREGISTERED` 拒绝，没有登记时回执给出 `outputBindingStatus: "unconfigured"`；协调库的系统变量段；变量段随 `artifact.language`；setup 的 repair 与 doctor；新规则 `residue-cleanup` 与 `goal-writing`；`unattended-commands` 升到第 2 版 | 5 |
| 4 | [配置写入与 Owner 决定](Release-Notes-2.2.0-Configuration-Writes-and-Owner-Decisions.md) | `work-gate-release`、`project-bindings-set`、`project-bindings-remove` 与 `work-release --force` 接受 `--decided-in`，`gate.updated` 可带授权字段；`chain-declare` 仍归 Atelier；引用的决定在写入取锁之前对照所读的状态核对 | 1 |
| 5 | [设备维护](Release-Notes-2.2.0-Device-Maintenance.md) | `library-unregister` 删掉一条注册表登记项；`device-clean` 按 `engine/current` 与备份所含内容判定可清的暂存与备份；两者默认只出计划，`--yes true` 才执行 | 2 |
| 6 | [Atelier](Release-Notes-2.2.0-Atelier.md) | 经登记的容器管理协调库的规则、变量与 AGENTS.md；状态页的库标签声明链身份、移除登记项，门页的迁移门一节放行门；文案覆盖五种语言，规则页为两条新规则加标题 | 2 |
| 7 | [Mana Orchestrate 技能](Release-Notes-2.2.0-Mana-Orchestrate-Skill.md) | 技能新增 `scripts/trash-empty.mjs`：清空会话 scratch 下点名的 trash 目录，先出计划，`--yes` 才删除；update 与 doctor 参考补充授权后才执行的说明 | 1 |
| 8 | [发行与仓库工具](Release-Notes-2.2.0-Release-and-Repository-Tooling.md) | 门户证明对 TCRN-CROSS-INC-155 的回放只比对决定 TypeScript 的锁文件条目；`fast-uri` 覆盖改为 `^3.1.7`，解析为 3.1.8；两个门户测试经 `globalThis.fetch` 的别名访问回环 Atelier，离线边界扫描通过 | 3 |
| 9 | [从 2.1.0 升级](Release-Notes-2.2.0-Upgrading-from-2.1.0.md) | 读取同一个库的每台设备一起换装 2.2.0；回退到 2.1.0 只在第一次这类写入之前安全；2.1.0 记下的门运行仍计入完成；协调库受管段的第一次渲染；`library-unregister` 与 `device-clean` 默认只出计划；两条新规则默认不启用，`unattended-commands` 第 2 版 | 6 |

## 版本摘要

Einzbern and Mana Orchestrate ship in lockstep at 2.2.0. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

## 关于本版说明

版本摘要与各模块页的条目正文逐字取自引擎仓库 tag `v2.2.0` 中的 `docs/releases/2.2.0.md`，只按功能模块重新排列，并为每个条目加了标题，没有删减或增补；其中「从 2.1.0 升级」一节原是一个列表，按列表项分为条目，每项原文不变。版本摘要的末句是发行脚本为每个版本写入的固定文字，2.2.0 的版本说明没有另列退役项。从 2.1.0 升级前，先读[从 2.1.0 升级](Release-Notes-2.2.0-Upgrading-from-2.1.0.md)模块。完整的版本说明以该文件为准。
