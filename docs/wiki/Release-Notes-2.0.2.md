# Einzbern 2.0.2 发行说明

[发行说明](Release-Notes.md) › Einzbern 2.0.2

## 模块目录

2.0.2 的发行说明按功能模块分为 2 个子章节，每个模块一页，可以只读需要的模块，并在模块页之间前后跳转。

| # | 模块 | 范围 | 条目 |
| --- | --- | --- | --- |
| 1 | [受管段、Command Spell 与门](Release-Notes-2.0.2-Managed-Sections-Rules-and-Gates.md) | 内置批量处理原则 v3 的正文带上 Owner 对 MIN-246 D11 的修订：第 6 条加小轮合并，新增第 9 条证据按摘录读；版本仍为 3 | 1 |
| 2 | [发行与仓库工具](Release-Notes-2.0.2-Release-and-Repository-Tooling.md) | 仓库根目录不再有 `AGENTS.md` 与 `CLAUDE.md`，源码归档随之不含；引擎不再从平台文档读验收名册与判定文件，`platform:doctor` 去掉对应两条腿，最终门计划须显式给出名册 | 2 |

## 版本摘要

Einzbern and Mana Orchestrate ship in lockstep at 2.0.2. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

## 关于本版说明

版本摘要与各模块页的条目正文逐字取自引擎仓库 tag `v2.0.2` 中的 `docs/releases/2.0.2.md`，只按功能模块重新排列，并为每个条目加了标题，没有删减或增补。版本摘要的末句是发行脚本为每个版本写入的固定文字，2.0.2 的版本说明没有另列退役项，本版移除的内容写在发行与仓库工具模块的条目里。完整的版本说明以该文件为准。
