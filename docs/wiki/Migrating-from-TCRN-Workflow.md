# 从 TCRN Workflow 迁移

迁移把改名之前的旧安装接入 Einzbern。

- 每个旧工作区的记录成为其项目 `.ether/` 库的第一条流。
- 旧安装留在本机的钩子、deny 规则、模板与旧技能副本，移进设备目录的备份。

它与恢复不同：恢复沿用已有的 `.ether/`；迁移要先按映射把每个旧工作区对到一个项目，再导入。

## 迁移前准备

- 本机要有当前引擎。计划报阻塞项 `SETUP_ENGINE_NOT_INSTALLED` 时，先按[安装向导](Install-Wizard.md)放上引擎。
- 准备迁移映射：一个只在本机使用、不提交的 JSON 文件，路径都是本机的绝对路径。

```json
{
  "schemaVersion": "einzbern.migration-mapping.v1",
  "partitions": [
    { "partition": "<分区名>", "legacyWorkspace": "<旧工作区目录>", "projectRoot": "<项目根目录>" }
  ]
}
```

- 映射的规则：
  - 每项可另带 `projectName` 与 `gitRemote`，作为库的项目提示。
  - 分区名、旧工作区、项目各只能出现一次。
  - 不给 `--mapping` 时，若项目自身含旧工作区，计划会推定一项。
- 一个容器里有多个项目时，`--project` 给容器根；容器根本身对应的分区（如 cross-project）的库就在容器根下。

## 先看计划

```text
einzbern setup --mode migrate --project <项目目录> --mapping <迁移映射 JSON> --at <UTC 时刻> \
  [--cloud true|false] [--language <语言标签>] [--navigation true|false]
```

不加 `--yes true` 时命令只读，返回 `SETUP_PLAN_READY`。`migration` 字段列出：

- `partitions`：逐分区给出目标库 `target` 与目标现状 `targetState`，以及动作 `action`：导入 `import`、已迁移跳过 `skip` 或被阻断 `blocked`。另有旧链的事件数与头哈希、在途工作数，以及全部未满足的 gate。gate 逐项列出，不计为零。
- `registry`：每个库将得到的注册表条目，`migratedFrom` 记旧工作区。
- `deviceSettings`：随迁的门户设置。
- `hostCleanup`：每一项清理，含类别 `kind`、路径、动作（改写 `update` 或移走 `move`）与去向 `into`。

`writes`、`backups`、`blockers` 与其他模式相同。有阻塞项时不会执行。旧知识库读不通的分区，另有一条知识类阻塞项，见下文「知识随迁」。

## 执行

核对计划后，用同一条命令加 `--yes true`，依次：

1. 逐分区导入，并把事件数与头哈希同计划比对。不等即停，返回 `LEGACY_IMPORT_MISMATCH` 并点名分区；此时注册表尚未写入。
2. 写入各库的注册表条目（带 `migratedFrom`），以及本机还没有的门户设置。
3. 在项目自己的库里写入语言。
4. 清理旧安装：
   - 用户级与每个映射项目（含容器根）的 `.claude/settings.json`、`.codex/hooks.json`，去掉旧平台钩子（不论挂在哪个事件上）、旧 deny 规则与旧惰性键；
   - Codex 的 `config.toml` 保持 hooks 开关开启，去掉已移除钩子的信任状态；
   - 其他工具的钩子与键不动；
   - 旧模板目录、旧技能副本与安装标记、旧注入状态、旧门户启动器，移进备份。
5. 按全新安装的步骤接线：
   - 两份技能副本、两个启动器；
   - 用户级设置里每个宿主一条 Einzbern 钩子；
   - `CLAUDE.md` 的导入段，以及按 `--navigation` 写入的 `AGENTS.md` 导航段；
   - 注册表已在第 2 步写好，不再重复。
6. 以 `doctor` 的八项检查作自检。

成功返回 `SETUP_APPLIED`：

- `migration` 含逐分区结果（`imported` 或 `skipped`）、注册表条目与实际完成的 `hostCleanup`；
- 另列出写入的文件、备份目录与 `selfCheck`。

用同一映射再运行一次，什么也不写。

## 知识随迁

导入把旧工作区的知识库原样带进库的 `crest/`：

- 带走的是旧控制目录里 `knowledge/` 的标记 `store.json`、`metadata/` 与 `bodies/`（含分段），逐字节复制并按 SHA-256 核对。旧的 `views/` 不带走，库的索引视图是本机缓存。
- 库按这种布局读取旧卡，新卡作为事件写在旁边；带过来的文件不被改写。
- 旧引擎在元数据里标了 `extensions.supersededBy` 的卡读作已移除：`knowledge-list` 只在 `--status removed` 或 `--status all` 时列出它。它照样随迁。

`library-import-legacy` 的回执里，dry-run 与正式导入同一口径。旧工作区没有知识库时 `knowledge` 为 `null`，否则各字段含义如下：

| 字段 | 含义 |
| --- | --- |
| `cards` | 旧库的全部卡数，任何状态都计（`knowledge-list --selection all --status all`） |
| `removedCards` | 其中读作已移除的卡数（`--status removed`） |
| `defaultCards` | 默认列出的卡数（只含有效卡） |
| `files`、`bytes` | 带进 `crest/` 的文件数与字节数 |

复制之后，库须答出同样的三个数，否则导入停在 `LEGACY_IMPORT_MISMATCH`。执行前想看某个分区的卡数，运行 `library-import-legacy --legacy <旧工作区> --dry-run true --at <UTC 时刻>`，它不写任何文件。

旧知识库读不通时，该分区被阻断：

- 计划里这次拒绝单列为一条阻塞项，`path` 是出问题的文件；针对整个知识库时是知识库本身。
- 分区条目照样列出旧链的事件数、头哈希、未满足的 gate 与在途工作。
- `library-import-legacy` 的拒绝在 `file` 里点名同一文件，相对旧知识库根；针对整个知识库时为 `.`。

| 拒绝码 | 含义 |
| --- | --- |
| `KNOWLEDGE_RECORD_INVALID` | 点名的文件（标记或某张卡的元数据）已不是引擎写下的字节，常见于被其他工具重新保存：加了缩进，或缺了末尾换行。 |
| `KNOWLEDGE_PATH_INVALID` | 知识库绑定的位置不是旧工作区现在所在的位置（引擎写入后被复制或移动过），或其中某个路径读不到。 |
| `KNOWLEDGE_PARTIAL_STATE` | 知识库不完整：有引擎不会留下的条目（如没写完的 `mutation.claim`、多出的文件），卡与正文对不上，或索引视图过期。 |

处置：

- 展示阻塞项及其文件后停下；有阻塞项时什么也不迁移。
- 不要自己改写、重排格式、移动或删除旧知识库里的文件。
- 由用户把知识库恢复成引擎留下的样子（从备份或更早的副本），或把旧工作区放回知识库绑定的位置，然后重新计划。

## 备份：只移不删

改写前的原件与移走的条目，都进设备目录 `~/.einzbern/backups/<UTC 时间>/`：

- 宿主文件的原件，以及移走的模板与注入状态，在 `host-hooks/` 下；
- 旧门户启动器在 `launchers/` 下；
- 旧技能副本与安装标记在 `skill-copies/` 下；
- 改写前的注册表在 `registry/` 下。

两种情况会让计划阻断：

- 备份位置已有同名条目（`MIGRATE_CLEANUP_BACKUP_EXISTS`；旧技能副本与标记为 `LEGACY_SKILL_CLEANUP_BACKUP_EXISTS`）：换一个 `--at` 重新计划；
- 某个条目与设备目录不在同一卷（`MIGRATE_CLEANUP_CROSS_VOLUME`）：移动是改名，不能跨卷。

以下内容不在任何清理清单里：

- 旧工作区所在的容器目录；
- 平台档案目录；
- 旧设备目录里的旧引擎副本。旧设备目录只移走安装标记。

## 迁移完成后

- 旧工作区留在原处，仍可只读打开。对它写入会返回 `LEGACY_WORKSPACE_MIGRATED`，其中 `movedTo` 指向新库，改用 `--workspace <库>` 即可。没有迁移过的旧布局，写入仍返回 `LEGACY_WORKSPACE_READ_ONLY`。
- 旧链里未满足的 gate，在新库里保持原状态，仍挡住所绑工单转 done；拒绝码 `WORKSPACE_GATE_PENDING` 会点名这张 gate。
  - 解除只能在 Atelier 面：以 `EINZBERN_SURFACE=atelier` 运行 `work-gate-release --id <gate> --reason <原因> --actor <操作者> --at <UTC 时刻>`，记录谁、何时、为何。
  - 模型直接运行会被拒绝（`MODEL_WRITE_REFUSED`）。
  - `work-gate-list --status all` 列出这些 gate。
- 库里的事件数与头哈希：
  - 项目自己的库，第一条流前段就是旧链，到旧头为止；之后是本机在迁移中写入的语言与受管段记录，由安装向导以 `agent:setup` 署名；
  - 其余分区的库与旧链的事件数和头哈希完全相同；
  - 可用 `chain-validate --workspace <库>` 核对。
- 用 `doctor --project <项目目录>` 检查八项。旧名与当前名的对应关系见[词汇表](Glossary.md)。
