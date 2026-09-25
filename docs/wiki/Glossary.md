# 词汇表

本页解释 Einzbern 的每个名字，并列出旧名到新名的别名表。世界观名只用于品牌与目录；命令、旗标、原因码与字段名保持直白。

## 品牌名

| 名字 | 标识 | 直白解释 |
| --- | --- | --- |
| Einzbern | `einzbern` | 工作流引擎：把工单、纪要与知识记成带哈希链的事件，读取时校验并重放。 |
| Mana Orchestrate | `mana-orchestrate` | 给宿主 Agent 用的 Skill 载荷：告诉 Agent 何时、怎样调用 Einzbern。 |
| Atelier | `atelier` | 本机网页门户：在浏览器里查看库里的工单、纪要与知识。 |
| Command Spell | `command-spell` | 内置原则集：随引擎提供、可按项目启用的执行规则。 |

## 目录名

| 目录 | 直白解释 |
| --- | --- |
| `.ether/` | 库：一个项目的全部记录所在的目录，可以放在项目里，也可以放在云盘里。 |
| `.ether/manifest.json` | 库清单：库 id、格式版本、最低引擎版本与项目提示；只在建库、格式变更与迁移时写。 |
| `.ether/akasha/` | 事件真值：每台设备只追加自己子目录里的事件流，读取时合并全部设备的流。 |
| `.ether/crest/` | 知识库：知识卡与文章。 |
| `.ether/config/` | 项目级配置的投影：随库同步；真值是事件，这里只是便于阅读的副本。 |
| `.ether/artifacts/` | 产物库：按内容哈希存放的大文件。 |
| `~/.einzbern/` | 设备目录：本机的设备身份、库注册表、缓存、备份与已装引擎版本；不随库同步。 |
| `<云盘>/Ether/<项目名>/` | 库放进云盘时的默认位置。 |

## 旧名别名表

旧名只在本表、`CHANGELOG.md` 的同名表与每个新库的 `README.md` 中出现。表的唯一来源是 `packages/core/src/names.ts`，三处由测试逐行核对。

<!-- einzbern:alias-table:start -->
| 旧名 | 新名 | 说明 |
| --- | --- | --- |
| `TCRN Workflow` | `Einzbern` | 产品名 |
| `tcrn-workflow` | `einzbern` | 引擎：仓名、npm 包名与 CLI 命令名 |
| `tcrn-workflow-helper` | `mana-orchestrate` | 助手：仓名与 Skill id |
| `.tcrn-workspace` | `.ether` | 项目生成物目录（库） |
| `.tcrn-workflow/` | `.ether/` | 旧布局的工作区控制目录；新引擎只读打开，不再写入 |
| `events/` | `akasha/` | 事件目录；新布局每台设备一个子目录 |
| `knowledge/` | `crest/` | 知识目录 |
| `~/.tcrn-workflow` | `~/.einzbern` | 设备目录（本机） |
| `TCRN Workflow Portal` | `Atelier` | 门户 |
| `tcrn.*` | `einzbern.*` | schema 命名空间；已写入的 tcrn.* 原样保留为只读旧命名空间，新写入用 einzbern.* |
| `.tcrn-artifacts` | （不改名、不迁移） | 平台档案，归平台层，不随改名迁移 |
<!-- einzbern:alias-table:end -->

工单前缀 `TCRN-CROSS-*` 与全部历史 `externalKey` 不改。
