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
  - 只有用户明确选择该分区不带旧知识库时，才给这一项加 `"omitLegacyKnowledge": {"reason": "<原因>"}`，见下文「显式不带旧知识库」。
  - 链角色只来自显式的 `"chainRole"`：协调链一项写 `"coordination"`，具体项目写 `"project"`，见下文「Project roles after import」。
  - 分区名、旧工作区、项目各只能出现一次。
  - 不给 `--mapping` 时，若项目自身含旧工作区，计划会推定一项。
- 一个容器里有多个项目时：
  - 映射不带 `chainRole` 时，`--project` 给容器根；容器根本身对应的分区（如 cross-project）的库就在容器根下。
  - 映射带 `chainRole` 时，`--project` 给任一 `chainRole` 为 `"project"` 的分区的根。协调分区的根会在计划阶段被拒（`SETUP_ANSWER_INVALID`，blocker 写明可改用的项目分区根），什么都不导入；用同一份映射改给项目分区的根再计划一次。

## 先看计划

```text
einzbern setup --mode migrate --project <项目目录> --mapping <迁移映射 JSON> --at <UTC 时刻> \
  [--cloud true|false] [--language <语言标签>] [--navigation true|false]
```

不加 `--yes true` 时命令只读，返回 `SETUP_PLAN_READY`。`migration` 字段列出：

- `partitions`：逐分区给出目标库 `target` 与目标现状 `targetState`，以及动作 `action`：导入 `import`、已迁移跳过 `skip` 或被阻断 `blocked`。另有旧链的事件数与头哈希、在途工作数，以及全部未满足的 gate；`chainIdentity` 是映射给出的链身份，未给角色时为 `null`。gate 逐项列出，不计为零；`knowledge` 列出将携带的知识，`knowledgeOmission` 列出显式不带的选择、原因与旧文件事实。
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

缺省导入把旧工作区的知识库原样带进库的 `crest/`：

- 带走的是旧控制目录里 `knowledge/` 的标记 `store.json`、`metadata/` 与 `bodies/`（含分段），逐字节复制并按 SHA-256 核对。旧的 `views/` 不带走，库的索引视图是本机缓存。
- 库按这种布局读取旧卡，新卡作为事件写在旁边；写卡从不改写带过来的文件。本页各步骤中，只有「迁移完成后」的清除步骤会改写这些文件：它先备份随迁的 `bodies/`，再去掉已移除卡的正文重写。
- 旧引擎在元数据里标了 `extensions.supersededBy` 的卡读作已移除：`knowledge-list` 只在 `--status removed` 或 `--status all` 时列出它。它照样随迁。

`library-import-legacy` 的回执里，dry-run 与正式导入同一口径。旧工作区没有知识库，或映射显式选择不带它时，`knowledge` 为 `null`；后者必须连同解释未带内容的 `knowledgeOmission` 一起看。正常随迁时各字段含义如下：

| 字段 | 含义 |
| --- | --- |
| `cards` | 旧库的全部卡数，任何状态都计（`knowledge-list --selection all --status all`） |
| `removedCards` | 其中读作已移除的卡数（`--status removed`） |
| `defaultCards` | 默认列出的卡数（只含有效卡） |
| `files`、`bytes` | 带进 `crest/` 的文件数与字节数 |

复制之后，库须答出同样的三个数，否则导入停在 `LEGACY_IMPORT_MISMATCH`。执行前想看某个分区的卡数，运行 `library-import-legacy --legacy <旧工作区> --dry-run true --at <UTC 时刻>`，它不写任何文件。

没有显式不带声明时，旧知识库读不通便阻断该分区：

- 计划里这次拒绝单列为一条阻塞项，`path` 是出问题的文件；拒绝落不到单个文件时（例如针对整个知识库），`path` 是知识库本身。
- 分区条目照样列出旧链的事件数、头哈希、未满足的 gate 与在途工作。
- `library-import-legacy` 的拒绝在 `file` 里点名同一文件，相对旧知识库根；拒绝落不到单个文件时（例如针对整个知识库），`file` 为 `.`。

| 拒绝码 | 含义 |
| --- | --- |
| `KNOWLEDGE_RECORD_INVALID` | 点名的文件（标记或某张卡的元数据）已不是引擎写下的字节，常见于被其他工具重新保存：加了缩进，或缺了末尾换行。 |
| `KNOWLEDGE_PATH_INVALID` | 知识库绑定的位置不是旧工作区现在所在的位置（引擎写入后被复制或移动过），或其中某个路径读不到。 |
| `KNOWLEDGE_PARTIAL_STATE` | 知识库不完整：有引擎不会留下的条目（如没写完的 `mutation.claim`、多出的文件），卡与正文对不上，或索引视图过期。 |

处置：

- 展示阻塞项及其文件后停下；有阻塞项时什么也不迁移。
- 不要自己改写、重排格式、移动或删除旧知识库里的文件。
- 由用户把知识库恢复成引擎留下的样子（从备份或更早的副本），或把旧工作区放回知识库绑定的位置，然后重新计划。

### 显式不带旧知识库

仅在用户明确批准后，给所选分区的映射项加
`"omitLegacyKnowledge": {"reason": "<为什么不带旧知识库>"}`。这个对象只接受 `reason`：不为空白、没有控制字符的一行，最多 512 字符。未知字段、错误类型、缺失或空白原因都返回 `SETUP_ANSWER_INVALID`。选择作用于该分区的整个旧知识库，能读的旧卡也不带；用户自己的 crest 与其他分区不受影响。没有声明的分区仍按缺省路径随迁，规范字节、路径与摘要校验照常。

单条导入也使用同一份映射：

```text
einzbern library-import-legacy --legacy <旧工作区> --mapping <映射文件> --dry-run true --at <UTC 时刻>
```

`--legacy` 必须对应映射中一项的绝对旧路径（解析 `.` 与 `..` 后相等），目标取这一项的 `<projectRoot>/.ether`；若另给 `--target`，它必须等于该目标。旧路径不在映射里或目标冲突时拒绝 `SETUP_ANSWER_INVALID`。正式导入在批准后去掉 `--dry-run true`；没有另一个跳过校验的旗标。

dry-run、计划的分区项和执行回执都列出 `knowledgeOmission`：

- `selection: "omit"`、声明的 `reason`、源知识库 `store` 与现状 `presence`。
- `refusal` 保留普通读者的拒绝码、相对文件与消息；`files` 逐项列原文件路径、字节数、SHA-256 与 `issue`，普通读者在首个文件停下时，仍能点名第二个不规范 JSON 文件。
- `counts` 只取普通读者的三个计数；拒绝时为 `"unknown"`，没有旧库时为 `"absent"`，不把无法读出的计数记成零。
- `unvalidatedCards` 列从元数据解析出的卡 id、externalKey 和文件。这些是明确未验证的事实，不是已接纳卡，也不能据此计数。读不到的事实保持未知，清单不跟随链接。

确认执行前，展示每个显式不带选择的原因、点名文件与未验证卡标识。链、历史、流头与 pending gate 照常随迁；新库的知识列表可读，且没有这份旧知识库的卡。旧目录原字节不变。不能靠改映射清除已经携带旧元数据的目标库，这时计划拒绝 `LEGACY_IMPORT_MISMATCH`；用同一声明再次执行时，已迁移库跳过，原因与旧文件事实仍可见。

已批准的 TMS 选择让 `store.json` 与 `metadata/knowledge:af064728aab1f7daa1440840.json` 留在旧工作区，原字节不动。实际迁移完成后，再按旧文件内容用 `knowledge-create` 重建 `CARD-FALSIFIABLE-NOT-CORRECT` 与 `CARD-COUNT-ONLY-GATE`，正常的重复与语言门照常执行；导入器不修旧库，也不代写重建卡。

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

- 清除各库随迁知识里已移除卡的正文：导入按旧引擎留下的样子带来旧卡，被取代卡的正文也在其中。
  - 导入后运行一次 `knowledge-bodies-migrate --workspace <库> --clear-removed true --at <UTC 时刻>`；此后每移除一批随迁旧卡（例如清理与工单或决策重复、或与其他卡冲突的存量旧卡），再运行一次，因为导入之后才移除的卡，正文同样留在那里。
  - 只在本设备是该库唯一写者时执行，每次运行都须在其他设备写入该库之前完成。已有其他设备写入时拒绝 `KNOWLEDGE_SOLE_WRITER_REQUIRED`，那些正文就留在原处，任何读取都不返回。
  - 答复给出 `clearedBodies`，以及改写前正文的备份目录 `backupDir`（设备目录 `backups/<UTC>/crest-bodies/` 下）；只有在没有已移除卡的正文可清除、也没有逐卡正文文件待移时，才什么也不写；若随迁布局仍有旧引擎留下的逐卡 `.body` 文件，这一步会先备份布局中的 `bodies/`，再把这些文件移进段里，因此 `clearedBodies` 可以为 0，而 `backupDir` 不为 `null`。
  - 同一秒的备份已在时拒绝 `KNOWLEDGE_ALREADY_EXISTS`：换一个更晚的 `--at` 重跑。
- 旧工作区留在原处，仍可只读打开。对它写入会返回 `LEGACY_WORKSPACE_MIGRATED`，其中 `movedTo` 指向新库，改用 `--workspace <库>` 即可。没有迁移过的旧布局，写入仍返回 `LEGACY_WORKSPACE_READ_ONLY`。
- 旧链里未满足的 gate，在新库里保持原状态，仍挡住所绑工单转 done；拒绝码 `WORKSPACE_GATE_PENDING` 会点名这张 gate。
  - 解除只能在 Atelier 面：以 `EINZBERN_SURFACE=atelier` 运行 `work-gate-release --id <gate> --reason <原因> --actor <操作者> --at <UTC 时刻>`，记录谁、何时、为何。
  - 模型直接运行会被拒绝（`MODEL_WRITE_REFUSED`）。
  - `work-gate-list --status all` 列出这些 gate。
- 库里的事件数与头哈希：
  - 项目自己的库，第一条流前段就是旧链，到旧头为止；之后是本机在迁移中写入的语言与受管段记录，由安装向导以 `agent:setup` 署名；
  - 其余分区的库与旧链的事件数和头哈希完全相同；映射给了 `chainRole` 时，旧链之后另有一条链身份记录，同样以 `agent:setup` 署名；
  - 可用 `chain-validate --workspace <库>` 核对。
- 用 `doctor --project <项目目录>` 检查八项。旧名与当前名的对应关系见[词汇表](Glossary.md)。

## Project roles after import

Imported old events retain their bytes and identities. A partition's chain role
comes only from its explicit `chainRole` in the mapping: `"coordination"` for the
mapping's one coordination chain, whose identity names its own library, and
`"project"` for a concrete project, whose identity names that coordination
partition's library. A mapping takes at most one coordination partition, and
project partitions need it in the same mapping; otherwise the plan refuses with
`SETUP_ANSWER_INVALID` on `chainRole`. The identity is written after the import is
checked, signed `agent:setup`, and the registry entry records the role. A
library migrated before without an identity gets it on the next run; one with
another identity stops the plan (`SETUP_LIBRARY_CONFLICT`) until `chain-declare`
changes it. A partition without `chainRole` stays unclassified, and the plan
shows `chainIdentity: null`; work project relations remain undecided until
explicitly declared. With roles, `--project` must name the root of a project
partition: the wizard writes that project's language and managed sections, and a
coordination chain takes neither, so a plan whose `--project` is the
coordination partition's root is refused at plan time (`SETUP_ANSWER_INVALID`,
one blocker naming a project partition's root to plan again with, the same
mapping) and nothing is imported. Never infer a coordination role from a Cross Project label,
a partition name or a path, or copy its old development settings into a newly
created product as implicit consent. The real Einzbern/Mana product identity and
the roles of the real migration mapping must be supplied at the authorized
migration step.
