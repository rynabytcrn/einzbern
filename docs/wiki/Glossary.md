# 词汇表

本页解释 Einzbern 的每个名字，并列出旧名到新名的别名表。世界观名只用于品牌与目录；命令、旗标、原因码与字段名保持直白。

## README 词汇

| 名字 | 标识或所在位置 | 含义与名字来源 |
| --- | --- | --- |
| Einzbern | `einzbern` | 工作流引擎：把工单、纪要与知识记成带哈希链的事件，读取时校验并重放。名字取自圣杯的本体。 |
| Mana Orchestrate | `mana-orchestrate` | 给宿主 Agent 用的 Skill 载荷：告诉 Agent 何时、怎样调用 Einzbern。Mana 是大源魔力，在这里指流转的记忆。 |
| Ether | `.ether/` | 项目的生成物目录。以太是魔力在现实中固定下来的介质。 |
| Akasha | `.ether/akasha/` | 只追加的事件记录，全部派生态都能从记录重建。名字指根源、一切记录所在之处。 |
| Crest | `.ether/crest/` | 知识库。名字取自世代继承的魔术刻印。 |
| Command Spell | `command-spell` | 内置原则集：随引擎提供、可按项目启用的执行规则。令咒是对从者绝对有效的命令。 |
| Atelier | `atelier` | 本机网页门户：在浏览器里查看库里的工单、纪要与知识。名字取自魔术师的工房。 |

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

## Command Spell 四原则

Command Spell 默认全部关闭，可按项目逐条启用。完整正文与启用方式见[受管段与 Command Spell](Managed-Sections-and-Command-Spell.md)。

| id | 版本 | 名称 | 大意 |
| --- | --- | --- | --- |
| `autonomy` | 1 | 自主运行原则 | 可逆且在请求范围内的工作直接完成；只有破坏性动作或范围变化才停下来确认。 |
| `batch` | 2 | 批量处理原则 | 一批工作按依赖分包；见红先记录，集中在批末处置，并在全部完成后汇报。 |
| `unattended-commands` | 1 | 无人值守指令原则 | 用不会弹权限确认的命令；删除改为移到暂存目录，命令从不切换目录。 |
| `silent-reporting` | 1 | 静默汇报原则 | 工作期间不发进度汇报；全部完成或剩余工作都阻塞时再汇报。 |
