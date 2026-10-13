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

## 知识卡与决策的状态

知识卡与决策各有两态，都按单条计（MIN-239 D3 至 D6）。召回、`knowledge-list`、纪要读取与提示词钩子默认只返回有效条目；其他状态只在显式 `--status` 时返回，该参数只在用户要求时由模型加上。决策的编号是 `minutes:<id>#D<n>`，历史会议纪要的决策同样这样编号。

| 词 | 标识 | 含义 |
| --- | --- | --- |
| 有效 | 决策 `valid` | 默认读取、召回与钩子返回的条目。一张新卡、一条新决策写入即有效。 |
| 已移除 | 知识卡 `--status removed` | 知识卡的终态：冲突被取代、判为无效或与工单或决策重复。移除记依据、操作者与时间，正文清除，只留编号、主题、原因与取代关系；没有恢复动词。 |
| 过时 | 决策 `obsolete` | 决策的终态：被取代或撤回。只在纪要落档时、在同一次 `minutes-record` 写入里声明；显式读取（`--status obsolete` 或 `all`，或按编号读）时附上取代它的决策。判错以新决策取代。 |
| 撤回 | 决策 `supersededBy: null` | 没有取代者的过时：纪要以 `--withdraws` 声明。 |

写卡前，卡片与工单正文和有效决策比对，重复即拒写（`KNOWLEDGE_ALREADY_RECORDED`），内容应写进工单或纪要。新纪要的决策与某条有效决策主题相近而未声明取代、撤回或并存（`--coexists`）时拒写（`MINUTES_POSSIBLE_CONFLICT`），并点名候选。工单 decided-by 或卡片关联的决策已过时，`work-show` 与召回提示已被哪条取代。完整规则见 `specs/minutes-v1.md`。

## 工单租约

租约是一个行动者对一张工单的占用（TCRN-CROSS-STORY-528，MIN-256），记在库的 `lease` 配置记录里：键是工单 id，作用域是工单所属的项目，值是持有者 `holder`、申领时刻 `claimedAt` 与到期时刻 `expiresAt`。租约随库同步，不写进 `config/project.json`。

| 动作 | 命令 | 规则 |
| --- | --- | --- |
| 申领 | `work-claim --id <工单> --actor <行动者> --at <时刻>`，可加 `--ttl <n>m` 或 `--ttl <n>h` | 默认 2h，可设 1m 至 24h；持有者再次申领即续期。他人在这张工单、它的上级或下级持有未到期的租约时，申领回 `WORK_LEASED`。 |
| 受约束的写入 | `work-transition`、`work-annotate`，以及 `work-batch` 里的这两类成员 | 他人的租约未到期时，对这张工单及其下级的写入回 `WORK_LEASED`，并给出 `holder`、`expiresAt` 与租约所在的 `leasedWorkId`；不带 `--actor` 的写入按他人处理；批量写入整批不写。`work-create`、`work-delete` 不受约束。 |
| 释放 | `work-release --id <工单> --actor <行动者> --at <时刻>` | 持有者随时可以释放；已到期的租约不再约束任何人，谁都可以释放；他人的租约未到期时只能在 Atelier 强制释放（`--force true` 只在 `EINZBERN_SURFACE=atelier` 下可用，否则 `MODEL_WRITE_REFUSED`）。Atelier 自己的写入也受租约约束，要先强制释放。 |
| 显示 | `work-show` 的 `lease`、`work-list` 每条的 `lease`、Atelier 工单页 | 工单自己的租约，没有时为 `null`。`active` 按读取时的本机时钟计算，只供阅读；写入是否受约束按写入自己的 `--at` 判断，引擎不读时钟。 |

## Command Spell 四原则

Command Spell 默认全部关闭，可按项目逐条启用。完整正文与启用方式见[受管段与 Command Spell](Managed-Sections-and-Command-Spell.md)。

| id | 版本 | 名称 | 大意 |
| --- | --- | --- | --- |
| `autonomy` | 1 | 自主运行原则 | 可逆且在请求范围内的工作直接完成；只有破坏性动作或范围变化才停下来确认。 |
| `batch` | 3 | 批量处理原则 | 一批工作按依赖分包；见红先记录，集中在批末处置，并在全部完成后汇报；「一次」按轮计，轮间不等答复、不换会话、不汇报；知识按轮采集，判断产出 lessons.json，主线程逐条落卡并读回；小轮的验收与判断由一个主力档代理合并完成；证据按摘录读。 |
| `unattended-commands` | 1 | 无人值守指令原则 | 用不会弹权限确认的命令；删除改为移到暂存目录，命令从不切换目录。 |
| `silent-reporting` | 1 | 静默汇报原则 | 工作期间不发进度汇报；全部完成或剩余工作都阻塞时再汇报；一轮做完、下一轮开始之间同样不汇报。 |

批量处理原则 v3 保留 v2 六条原则，并追加代理通信与等待：普通进度与可延后问题按完整包交付；宿主已通知完成时不重复发送。安全、硬阻塞及会阻塞其他代理的依赖或冲突可立即协调。主代理直接处理需要决策或行动的信息，不纯确认或催问普通进度；等待使用宿主通知及阻塞等待，无新状态时延长间隔，遵守等待上限、用户中断并继续独立工作。Owner 在同一版本内追加第 7 条：「一次」按轮计，一轮内拆分、每包实施、集成、名册、验收、判断各做一遍，不逐红重复；一轮做完，判断列出的问题清单与排队项就是下一轮的输入，直到 goal 写明的终态达成，或剩余工作全部阻塞于只有 Owner 能做的决定；轮与轮之间不等 Owner 答复、不换会话、不汇报。Owner 第五轮在同一版本内再追加第 8 条：知识采集按轮，每轮的单名判断代理在判断报告旁产出 lessons.json（每条含 subject、summary、snippet、body、tags 与来源证据路径，只写本轮新确立的事实与教训，不超过 5 条），主线程在同一轮的链写里用 knowledge-capture 逐条落卡并读回，卡被预算拒绝就记阻塞、迁移后补写，不依赖 Stop 钩子的标记行采集。Owner 在同一版本内又于第 6 条末尾补入小轮合并，并追加第 9 条：本轮实施包不超过 2 个或验收只有一片时，验收与判断由一个主力档代理一次完成，仍按原格式写验收、判断与 lessons 三份文件，并顺带写出下一轮的拆分文件，不另派拆分代理；验收两片以上的轮维持验收分片并行、判断单独、拆分单独；没有实施包、只有链写或文档动作的轮，不派拆分与验收代理，主线程完成动作后派一个主力档代理读回并判断。第 9 条证据按摘录读：治理代理与主线程只读派工指明的摘录文件、节号或行号范围，不整读拆分、计划、判断、台账与 routing 文件；工具输出先写进文件再按需读入，每次不超过 200 行；超过 32 KB 的文件不整读，宿主的读取守卫会拒绝并给出改法。

已有 batch v2 仍适用且保持原字节；rule-list、Atelier 读取及普通 agents-render 只显示 update-available，显式 rule-enable 升级才写 v3。用户修改仍按 user-modified/pending 与 keep/overwrite/unmanage 保护。正文验证不是运行期遵守证明，未经可比会话测量的 token 节省为 unknown。

同一版本内的正文修订不改版本号（INIT-053 R40：batch v3 追加第 7 条，silent-reporting v1 追加「一轮做完、下一轮开始之间同样不汇报」一句，Owner 在自己的 AGENTS.md 里把这两段记为修订号 2；INIT-053 R48：batch v3 追加第 8 条「知识采集按轮」，Owner 把该段记为修订号 3；INIT-053 R52：batch v3 在第 6 条末尾补入小轮合并，并追加第 9 条「证据按摘录读」，Owner 把该段记为修订号 4）。已在该版本启用的原则，rule-list 与 Atelier 仍读作 enabled，没有单独的「正文过期」状态；下一次 agents-render 把未改动的段换成修订后的正文，段的修订号加 1；你改过的段照旧不被覆盖，按 user-modified/pending 等待处置。

- **Coordination chain**: explicitly marked library for cross-project work and decisions.
- **Concrete project target**: stable library/project pair with its own development configuration.
- **Involved projects**: formal work scope; undecided, coordination-only, or selected targets.
- **Common default**: explicitly opted-in configuration source, distinct from device preferences.
