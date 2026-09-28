# 安装向导

Mana Orchestrate 带有 Einzbern 安装向导。它在项目目录中运行 `setup`，用六种模式处理安装、恢复、更新、修复、迁移和卸载；另用 `doctor` 做体检。向导先列出问题、已经确定的答案和将写入的文件；检查这份计划后再执行。

## 先让引擎就位

向导使用本机当前的引擎。本机还没有引擎时（设备目录下没有 `engine/einzbern.mjs`，或计划报阻塞项 `SETUP_ENGINE_NOT_INSTALLED`），先用 Mana Orchestrate 自带的取件步骤放上一个引擎：`node <技能目录>/scripts/install.mjs --archive <本地发布包>` 安装本机已有的发布包，不联网；`--version <版本>` 则下载该版本的发布包。下载是整个安装过程中唯一的联网动作，下载前先征得用户同意。取件成功返回 `INSTALL_ENGINE_READY`，之后再按下文运行 `setup`。

## 一屏计划与确认

```text
einzbern setup --mode <模式> --project <项目目录> --at <UTC 时刻> [选项]
```

不加 `--yes true` 时，命令返回 `SETUP_PLAN_READY`，列出待回答的问题、选中的答案和写入计划。Mana Orchestrate 把所需问题集中在一屏呈现。补齐必要答案并检查写入项后，使用 `--yes true` 应用计划；成功返回 `SETUP_APPLIED`，列出写入文件、备份位置与 `selfCheck` 结果。恢复模式还会分别列出随库恢复的项目级配置和需要在本机重设的设备级配置。

```text
einzbern setup --mode fresh|restore|update|repair|migrate|uninstall --project <项目目录> --at <UTC 时刻> \
  [--artifacts <库路径>] [--cloud true|false] [--restore <库路径>] \
  [--language <语言标签>] [--navigation true|false] [--archive <本地发布包>] \
  [--rollback true] [--managed-sections keep|remove] [--mapping <迁移映射 JSON>] [--yes true]
```

每个选项只适用于特定模式。向导会拒绝不属于该模式的选项；缺少必要答案时，不会应用计划。

## 六种模式

| 模式 | 用途 | 模式专属选项 |
| --- | --- | --- |
| `fresh` | 在新项目安装。默认在项目下创建 `.ether`，也可用 `--artifacts` 指定位置；登记项目、安装技能与宿主钩子，并设置语言、云同步与导航选择。 | `--artifacts`、`--cloud`、`--language`、`--navigation` |
| `restore` | 把本机接回已有库。先检查库与设备状态；任一检查失败就停止且不写入。 | `--restore`、`--cloud`、`--navigation` |
| `update` | 从本地 Einzbern 发布包更新引擎；也可把引擎切回上一个版本。 | `--archive`、`--rollback true` |
| `repair` | 依据本机注册信息重新检查安装和宿主接线。完整的项目不会被重复改写。 | `--cloud`、`--navigation` |
| `migrate` | 按映射把旧版 TCRN Workflow 项目迁入新库；计划逐库列出迁移信息与文件动作。 | `--mapping` |
| `uninstall` | 移除本机的 Einzbern 钩子、技能副本和项目登记；库内容保留。 | `--managed-sections keep|remove` |

迁移功能由第二批实施落地。若当前引擎返回 `SETUP_MIGRATE_PENDING`，表示该版本尚未提供迁移执行；这次计划不会迁移或改写旧数据。

## 更新与离线发布包

`update` 使用本机已经取得的发布文件，不需要向导联网下载。`--archive` 可以指向 `einzbern-<版本>.tar.gz` 及其旁边的 `.sha256` 文件，也可以指向该发布包解开的目录。计划会校验包摘要与其中的安装树摘要，再列出将写入的内容。`--rollback true` 则切回本机上一版，不下载或解包文件。

## 备份与文件保护

向导在覆盖本机文件前先备份到设备目录 `~/.einzbern/backups/<UTC 时间>/`。卸载会把本机安装内容移入该备份目录，而不是删除；`--managed-sections keep`（默认）保留项目文件里的受管段，`remove` 只移走标记，把正文留给项目。

向导不提交、不推送、不改 `.gitignore`，也不删除文件。更新引擎不会自动重写项目的 `AGENTS.md` 或 `CLAUDE.md`。完整健康检查使用 `doctor --project <项目目录>`。
