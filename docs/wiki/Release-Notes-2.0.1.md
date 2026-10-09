# Einzbern 2.0.1 发行说明

[发行说明](Release-Notes.md) › Einzbern 2.0.1

## 模块目录

2.0.1 的发行说明按功能模块分为 4 个子章节，每个模块一页，可以只读需要的模块，并在模块页之间前后跳转。

| # | 模块 | 范围 | 条目 |
| --- | --- | --- | --- |
| 1 | [跨项目协作](Release-Notes-2.0.1-Cross-Project.md) | 协调库的 Story 经库自己项目范围的门转为完成；结果列在新的 `library` 字段下；协调库项目的门根目录取自库的注册项 | 1 |
| 2 | [Atelier](Release-Notes-2.0.1-Atelier.md) | Wiki 的 Atelier 页新增启动 Atelier 一节：命令、选库次序、端口与监听地址、写入者、页面令牌与停止方法 | 1 |
| 3 | [迁移](Release-Notes-2.0.1-Migration.md) | 迁移把项目配置绑到映射行指定的旧链项目：`projectId`、候选项目、阻断与修复；Wiki 迁移页说明哪些库记录写入者 | 2 |
| 4 | [发行与仓库工具](Release-Notes-2.0.1-Release-and-Repository-Tooling.md) | GitHub Release 正文改为简短说明加 Wiki 版本页链接，缺页时以 `RELEASE_WIKI_NOTES_MISSING` 拒绝；`push-wiki` 让 Wiki 页面之间的链接打开页面 | 2 |

## 版本摘要

Einzbern and Mana Orchestrate ship in lockstep at 2.0.1. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

## 关于本版说明

版本摘要与各模块页的条目正文逐字取自引擎仓库 tag `v2.0.1` 中的 `docs/releases/2.0.1.md`，只按功能模块重新排列，并为每个条目加了标题，没有删减或增补。版本摘要的末句是发行脚本为每个版本写入的固定文字，2.0.1 的版本说明没有列出退役项。完整的版本说明以该文件为准。
