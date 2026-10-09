# Einzbern 2.0.0 发行说明

[发行说明](Release-Notes.md) › Einzbern 2.0.0

## 模块目录

2.0.0 的发行说明按功能模块分为 13 个子章节，每个模块一页，可以只读需要的模块，并在模块页之间前后跳转。

| # | 模块 | 范围 | 条目 |
| --- | --- | --- | --- |
| 1 | [改名与精简](Release-Notes-2.0.0-Renaming-and-Retirements.md) | 两个产品同步发行 2.0.0；引擎改名 Einzbern 与新旧名称对照表；治理层精简与退役的命令、脚本和检查 | 3 |
| 2 | [库与设备](Release-Notes-2.0.0-Libraries-and-Devices.md) | 设备目录；事件格式；库（`.ether`）的根目录；每台设备一条流与合并读取；只写库、旧布局只读；设备缓存；库注册表；云同步标记；库搬迁；宿主可写根；并发读写的修正；未注册目录的拒绝说明；工作索引 v3 | 16 |
| 3 | [工作记录、纪要与决策](Release-Notes-2.0.0-Work-Records-and-Minutes.md) | Incident 并入 Story；Story 的目标、验收与正文；纪要取代会议；决策各自有效或作废，与工作记录或有效决策重复的卡片被拒绝 | 4 |
| 4 | [召回与钩子](Release-Notes-2.0.0-Recall-and-the-Hook.md) | 按意图召回，只在强命中时回答；强命中阈值；一个钩子取代 harness；钩子启动器的日志 | 4 |
| 5 | [知识](Release-Notes-2.0.0-Knowledge.md) | 库内的知识库 `crest/`；一次写入、立即可查；多台设备共享与写入知识库；卡片正文总量不再设预算；派生索引与列表摘要不再受单一规范值限制；卡片有效或移除，移除为终态；`knowledge-bodies-migrate` | 10 |
| 6 | [受管段、Command Spell 与门](Release-Notes-2.0.0-Managed-Sections-Rules-and-Gates.md) | 引擎只写 AGENTS.md 与 CLAUDE.md 中自己的段；门按项目声明、按改动选择；Command Spell 规则；变量、规则与门的顺序；模型不再经 CLI 切换规则或声明门；受管段写入不再留下改了一半的文件；内置 Command Spell 文本的修订 | 8 |
| 7 | [设置、变量与模型档位](Release-Notes-2.0.0-Settings-Variables-and-Model-Tiers.md) | 配置分项目级与设备级两层；设置精简，每个模型档位写明执行器；目录每行带布局；模型类别与模型档位两张记录表；规则记录按档位升级；`variables-system` 段；`settings-set` 回执的 `effectiveValue` | 7 |
| 8 | [跨项目协作](Release-Notes-2.0.0-Cross-Project.md) | 工作项记录所涉项目；门按涉及的目标与仓库分别计划和运行；安装、迁移与门的交接；完整读取项目与目标；协调链自己的运行设置 | 5 |
| 9 | [Atelier](Release-Notes-2.0.0-Atelier.md) | 门页面说明 cover 的含义；工作页显示读取状态；编辑工作项所涉项目、按其筛选并显示各目标的就绪情况；显示项目自己的名称；使用设计系统 `d53f2305` | 5 |
| 10 | [安装与引擎版本](Release-Notes-2.0.0-Installation-and-Engine-Versions.md) | 打开库时检查格式与引擎版本；引擎版本放在设备目录；`status` 的 `multiDevice`；一个只需 Node.js 的发布包；安装向导 `setup` 与 `doctor`；写入 Git 跟踪的宿主文件前先说明 | 6 |
| 11 | [Mana Orchestrate](Release-Notes-2.0.0-Mana-Orchestrate.md) | 技能由引擎生成；获取脚本与安装行使用两个仓库的最终地址；`SKILL.md` 说明如何替换、撤回或并存已记录的决策；restore 与 doctor 参考说明受管段标识 | 4 |
| 12 | [迁移](Release-Notes-2.0.0-Migration.md) | `library-import-legacy` 导入旧布局工作区；`setup --mode migrate` 的计划、执行与收尾；注册表的 `migratedFrom`；迁移带来的门在 Atelier 解除；旧知识库的携带、计数与 `omitLegacyKnowledge`；协调链的语言 | 11 |
| 13 | [发行与仓库工具](Release-Notes-2.0.0-Release-and-Repository-Tooling.md) | `test` 任务等待仍在退出的进程组；platform doctor 不再检查容器 `AGENTS.md`；发行隐私扫描按内容读取正式包；移除 `pg:schema` 与 `pg:test`；两阶段发行准备；`privacy:staged`；P8 的元数据行分类；发行准备要求显式根目录 | 8 |

## 关于本版说明

各模块页的条目正文逐字取自引擎仓库 tag `v2.0.0` 中的 `docs/releases/2.0.0.md`，只按功能模块重新排列，并为每个条目加了标题，没有删减或增补。完整的版本说明以该文件为准。
