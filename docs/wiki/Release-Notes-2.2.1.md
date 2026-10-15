# Einzbern 2.2.1 发行说明

[发行说明](Release-Notes.md) › Einzbern 2.2.1

## 模块目录

2.2.1 的发行说明按功能模块分为 2 个子章节，每个模块一页，可以只读需要的模块，并在模块页之间前后跳转。

| # | 模块 | 范围 | 条目 |
| --- | --- | --- | --- |
| 1 | [知识与纪要](Release-Notes-2.2.1-Knowledge-and-Minutes.md) | 协调库的 `knowledge-capture`、`knowledge-create`、`knowledge-batch` 与文章索引不再受写入语言策略约束，按交来的原文写入、不生成问法；`artifact.language` 只决定其受管段与变量段的语言；项目库与没有链身份的库照旧 | 1 |
| 2 | [从 2.2.0 升级](Release-Notes-2.2.1-Upgrading-from-2.2.0.md) | 已有库的读者仍为 2.2.0，2.2.1 新建的库要 2.2.1，读同一库的设备一起换装；回退到 2.2.0 不损坏库与 2.2.1 写的卡，但协调库写卡又被拒；2.2.0 记下的门运行仍计入完成；装上 2.2.1 后重写此前被拒的卡 | 4 |

## 版本摘要

Einzbern and Mana Orchestrate ship in lockstep at 2.2.1. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

## 关于本版说明

版本摘要与各模块页的条目正文逐字取自引擎仓库 tag `v2.2.1` 中的 `docs/releases/2.2.1.md`，只按功能模块重新排列，并为每个条目加了标题，没有删减或增补；其中「从 2.2.0 升级」一节原是一个列表，按列表项分为条目，每项原文不变。版本摘要的末句是发行脚本为每个版本写入的固定文字，2.2.1 的版本说明没有另列退役项。从 2.2.0 升级前，先读[从 2.2.0 升级](Release-Notes-2.2.1-Upgrading-from-2.2.0.md)模块。完整的版本说明以该文件为准。
