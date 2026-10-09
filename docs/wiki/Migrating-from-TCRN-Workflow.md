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
  - `"projectId"` 指明库的配置（语言、受管段与注册项）归旧链里的哪个项目，写作 `project:` 加 24 位小写十六进制。它须是该分区旧链里未删除的项目；库已迁移过的，也须是库里未删除的项目。按行的角色：
    - `chainRole` 为 `"project"` 的行：注册项的 `projectId` 与链身份的 `primaryProjectId` 都指向它。`--project` 所指的分区是这种行、旧链又有未删除的项目时，必须写，否则计划停下并列出候选，见下文「先看计划」；旧链没有项目时不用写。
    - 不带 `chainRole` 的行：可以写，写了就复用该项目，注册项指向它，迁移不写链身份。`--project` 所指的分区不写、注册项与链身份也没有指向项目时，沿用旧做法：setup 按项目目录名另建一个自己的配置项目；旧链已有项目时，库里就多出一个项目，见下文「迁移新建了第二个项目时」。
    - `chainRole` 为 `"coordination"` 的行不收 `projectId`：协调链不写项目语言，也不接线。
    - 形状不对或写在协调行，命令以 `SETUP_ANSWER_INVALID` 拒绝，`field` 为 `projectId`。
    - 选哪个项目由用户定：计划在 `projectCandidates` 里列出候选，从不按名称、唯一项目或路径替用户选。
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

- `partitions`：逐分区给出目标库 `target` 与目标现状 `targetState`，以及动作 `action`：导入 `import`、已迁移跳过 `skip` 或被阻断 `blocked`。另有旧链的事件数与头哈希、在途工作数，以及全部未满足的 gate；`chainIdentity` 是映射给出的链身份，未给角色时为 `null`。gate 逐项列出，不计为零；`knowledge` 列出将携带的知识，`knowledgeOmission` 列出显式不带的选择、原因与旧文件事实。协调分区另有 `coordinationSettings`，即协调链自己的设置，见下文「Project roles after import」。每个分区另有 `projectId`，即映射行写的项目，没写时为 `null`；还有 `projectCandidates`，即旧链里未删除的项目，每项 `{id, name, externalKey, work}`，`work` 是该项目未删除的工单数，按项目 id 排序，旧链读不出时为 `null`。project 行写了 `projectId` 时，`chainIdentity` 另带 `primaryProjectId`。
- `registry`：每个库将得到的注册表条目，`migratedFrom` 记旧工作区；行里写了 `projectId` 的，条目另带 `projectId`。
- `deviceSettings`：随迁的门户设置。
- `hostCleanup`：每一项清理，含类别 `kind`、路径、动作（改写 `update` 或移走 `move`）与去向 `into`。
- `projectBinding`：只在 `--project` 所指分区的行写了 `projectId`、且该分区未被阻断时出现，见下文「迁移新建了第二个项目时」。

`writes`、`backups`、`blockers` 与其他模式相同。有阻塞项时不会执行。旧知识库读不通的分区，另有一条知识类阻塞项，见下文「知识随迁」。

与 `projectId` 有关的阻塞项，`step` 为 `library`，`path` 为该分区的库：

- `SETUP_ANSWER_INVALID`：行里的 `projectId` 不是旧链里未删除的项目，或库已迁移过而它不是库里未删除的项目。该分区的 `action` 为 `blocked`，消息逐个列出可选的项目，写法是 `<id> "<名称>" (<n> work items)`。
- `SETUP_ANSWER_INVALID`：`--project` 所指的分区是 `chainRole` 为 `"project"` 的行，旧链有未删除的项目，行里却没写 `projectId`。消息列出候选；setup 不替用户选，也不在旁边另建配置项目。由用户从 `projectCandidates` 里选定一个，写进该行，再计划一次。
- `SETUP_LIBRARY_CONFLICT`：库已迁移过，链身份写的是另一个 `primaryProjectId`。主项目只能用 `chain-declare` 改，它在 Atelier 面运行，模型直接运行会被拒绝（`MODEL_WRITE_REFUSED`）。

## 执行

核对计划后，用同一条命令加 `--yes true`，依次：

1. 逐分区导入，并把事件数与头哈希同计划比对。不等即停，返回 `LEGACY_IMPORT_MISMATCH` 并点名分区；此时注册表尚未写入。
2. 写入各库的注册表条目（带 `migratedFrom`；行里写了 `projectId` 的，带上它），以及本机还没有的门户设置；协调库再写入计划标为 `write` 的自身设置（标为 `default` 的行不写）。
3. 在项目自己的库里写入语言；行里写了 `projectId` 时写在该项目上，不另建配置项目。
4. 召回冒烟：取项目自己的库里最新的一张有效卡（按 `updatedAt`，同刻按 id），以它的标题经提示钩子的同一路径召回。命中记为 `recallSmoke` 的 `hit`（带卡 id 与查询），库里没有有效卡记为 `no-card`；未命中返回 `SETUP_RECALL_SMOKE_MISSED` 并停下，此时库已导入并登记，旧安装未清理，也未接线。查明原因（例如库的 `retrieval.tau`）后，用同一映射再运行，已迁移的分区跳过，从冒烟处继续。
5. 清理旧安装：
   - 用户级与每个映射项目（含容器根）的 `.claude/settings.json`、`.codex/hooks.json`，去掉旧平台钩子（不论挂在哪个事件上）、旧 deny 规则与旧惰性键；
   - Codex 的 `config.toml` 保持 hooks 开关开启，去掉已移除钩子的信任状态；
   - 其他工具的钩子与键不动；
   - 旧模板目录、旧技能副本与安装标记、旧注入状态、旧门户启动器，移进备份。
6. 按全新安装的步骤接线：
   - 两份技能副本、两个启动器；
   - 用户级设置里每个宿主一条 Einzbern 钩子；
   - `CLAUDE.md` 的导入段，以及按 `--navigation` 写入的 `AGENTS.md` 导航段；
   - 注册表已在第 2 步写好，不再重复。
7. 计划有 `projectBinding`、且要删除原项目时，再核对一次，条件仍都成立才删除 setup 自己建的配置项目，否则只移绑定，见下文「迁移新建了第二个项目时」。
8. 以 `doctor` 的八项检查作自检。

成功返回 `SETUP_APPLIED`：

- `migration` 含逐分区结果（`imported` 或 `skipped`）、注册表条目与实际完成的 `hostCleanup`；计划有 `projectBinding` 时，回执也有，其中不为 `null` 的 `retirement`，`action` 为 `deleted` 或 `kept`；
- `recallSmoke` 是召回冒烟的结果；
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
  - 项目自己的库，第一条流前段就是旧链，到旧头为止；之后是本机在迁移中写入的语言与受管段记录，写入者是安装向导 `agent:setup`；
  - 其余分区的库与旧链的事件数和头哈希完全相同；映射给了 `chainRole` 时，旧链之后另有一条链身份记录；协调库在其后还可能有它自己的设置记录（见下文）；
  - 这些记录只在已启用署名的库里带上 `agent:setup`，见下一条；
  - 可用 `chain-validate --workspace <库>` 核对。
- 写入者（事件 `payload` 里的 `actor`）只记在已启用署名的库里：
  - 旧链启用过署名（链上有 `attestation.actor.enabled` 事件）的库，从那条事件起，每条事件的 `payload` 都带 `actor`：迁移写入的语言、受管段、链身份与设置记录带 `agent:setup`；Atelier 的写入带 `TCRN_PORTAL_ACTOR` 的值，缺省为 `agent:portal`，见 [Atelier](Atelier.md)；CLI 的写入带 `--actor` 的值。cross-project 迁移出的协调库就是这样。
  - 旧链从未启用署名的库（例如 TCRN-TMS 与 dsh-tcrn-workflow-plugin），整条链都不记写入者：setup 写入的链身份与设置记录（项目自己的库还有语言与受管段记录）都不带 `actor`，事件 `payload` 只有 `operation` 与 `record`；Atelier 与 CLI 的写入也一样，`TCRN_PORTAL_ACTOR` 与 `--actor` 照常接受，但不写进事件。记录内容本身要写明操作者的，例如 `work-gate-release` 写下的解除记录，照旧记在记录里。
  - 引擎没有为已有的库启用署名的命令，也不给旧事件补写写入者。
  - 读法：`event-list --workspace <库>` 分页列出事件，每页缺省 64 条，用 `--offset` 与 `--limit` 翻页；看各事件的 `payload` 里有没有 `actor`。
  - 写入者只说明经哪个入口写入，不证明身份。
- 用 `doctor --project <项目目录>` 检查八项。旧名与当前名的对应关系见[词汇表](Glossary.md)。

## 迁移新建了第二个项目时

`--project` 所指分区的映射行没写 `projectId`、注册项与链身份也没有指向项目时，setup 按项目目录名在库里另建一个自己的配置项目（外部键以 `SETUP-CONFIG-` 开头），把语言、受管段记录与注册项的 `projectId` 都绑在它上面。2.0.0 的映射还不认 `projectId`，用它迁移时都是这样；现在不带 `chainRole` 的行不写时也还是这样。旧链本来就有项目时，库里便多出一个项目：旧链的工单等记录在原有的项目里，配置却在 setup 建的项目里。TCRN-AOS 的 2.0.0 迁移就是一例。

辨认：

- `project-list --workspace <库>` 里，除旧链原有的项目外，还有 setup 建的一个；
- `library-list` 里该项目的注册项，`projectId` 指向 setup 建的那一个；
- 下面第 2 步计划的 `projectCandidates` 给出每个项目的外部键与未删除工单数：setup 建的那个，外部键以 `SETUP-CONFIG-` 开头，名称是项目目录名，通常没有工单。

修正仍用 `setup --mode migrate`，没有另外的命令。前提：

- 本机的引擎须已带上这项修正，映射才认 `projectId`。2.0.0 不认：带 `projectId` 的行被当作含有分区不收的字段，以 `SETUP_ANSWER_INVALID` 拒绝，`field` 为 `projectId`，消息含 `which a partition does not take`。这时先按[安装向导](Install-Wizard.md)的「更新与离线发布包」更新引擎。
- 映射只写两行：协调行，加上要修正的项目行。两行照抄当初迁移时的写法，分区名、旧工作区、项目根与 `chainRole` 都不变；项目行另加 `projectId`，值为由用户选定的、持有旧链记录的那个项目。
- 链只追加，修正写入的事件撤不回。想留下修正前的字节，先把整个库目录备份到库外。

```json
{
  "schemaVersion": "einzbern.migration-mapping.v1",
  "partitions": [
    { "partition": "<协调分区名>", "legacyWorkspace": "<协调分区的旧工作区目录>", "projectRoot": "<协调库所在的目录>", "chainRole": "coordination" },
    { "partition": "<分区名>", "legacyWorkspace": "<旧工作区目录>", "projectRoot": "<项目根目录>", "chainRole": "project", "projectId": "project:<24 位十六进制>" }
  ]
}
```

步骤：

1. 修正前读回，留作对照：加 `--workspace <库>` 运行 `project-list`、`chain-identity`、两个项目各自的 `settings-catalog --project-id <项目>`、`work-list`、`minutes-list`、`knowledge-list --at <UTC 时刻> --status all --selection all --allow-trailing true`、`work-gate-list --status all` 与 `chain-validate`；另运行 `library-list` 与 `doctor --project <项目根目录>`。
2. 计划，不加 `--yes true`：

   ```text
   einzbern setup --mode migrate --project <项目根目录> --mapping <两行映射> --at <UTC 时刻> \
     --language <当初回答的语言> --cloud <当初的回答> --navigation <当初的回答>
   ```

   当初回答的语言记在 setup 建的项目上，第 1 步的 `settings-catalog` 读得到。核对：
   - `SETUP_PLAN_READY`，`blockers` 为空；
   - 两个分区的 `action` 都是 `skip`；出现 `import`，说明某一行与当初的迁移不同，不要执行；
   - 项目分区的 `chainIdentity.primaryProjectId` 与 `registry` 里该项的 `projectId` 都是映射写的项目，协调分区两者都没有；
   - `migration.projectBinding` 的 `from` 是注册项原来指向的项目，即 setup 建的那个；`to` 是映射写的项目；`retirement` 说明 `from` 将被删除还是保留，见下文；
   - `writes` 里没有对协调库的写入。
3. 执行：同一条命令换一个更晚的 `--at`，加 `--yes true`。回执 `SETUP_APPLIED` 中，`migration.projectBinding.retirement.action` 为 `deleted` 或 `kept`。
4. 修正后读回，与第 1 步对照：
   - `project-list` 里只剩旧链原有的项目（`deleted` 时）；
   - `chain-identity` 的 `primaryProjectId` 为映射写的项目；
   - 该项目的 `settings-catalog` 里，`artifact.language` 为所答语言，来源是该项目本身；setup 建的项目删除后，它的 `settings-catalog` 以 `WORKSPACE_INPUT_INVALID` 拒绝；
   - `library-list` 里注册项的 `projectId` 为映射写的项目；
   - 工单、纪要、卡与 gate 逐条与修正前相同；
   - `chain-validate` 为 `CHAIN_VALIDATED`，`doctor` 八项通过。
5. 用同一映射再计划一次，`writes` 应为空。

修正在该库写入的事件：链身份补上 `primaryProjectId`，再写该项目的语言（已相同则不写）与受管段记录；删除原项目时，接着移除它的语言、移除它的受管段记录，最后一条是 `project.deleted`。已启用署名的库里，这些事件都带 `agent:setup`，见上文「迁移完成后」。删除只是链上的 `project.deleted` 事件，项目记录留作墓碑，不删任何文件。

`retirement` 只在注册项原来指向另一个项目、且该分区已迁移（`action` 为 `skip`）时不为 `null`；注册项原来没有指向项目或已指向映射写的项目时为 `null`，什么也不删。它的字段：

| 字段 | 含义 |
| --- | --- |
| `projectId`、`externalKey` | 原项目，即注册项原来指向的项目，及其外部键 |
| `action` | 计划里为 `delete` 或 `keep`，回执里为 `deleted` 或 `kept` |
| `holds` | 留下原项目的原因；为空才删除 |
| `settings`、`records` | 原项目的设置键与配置记录（`<集合>:<键>`），删除时随它一起移除 |

原项目只在下面各条都成立时删除：外部键以 `SETUP-CONFIG-` 开头；没有未删除的子项目；没有归它的工单、会议、会议纪要、纪要、gate、模板或卡；设置只有 `artifact.language`，配置记录只有受管段；除 `agent:setup` 外没有别的写入者写过它。执行时再读一遍，并确认注册项、链身份（project 链）与受管段记录都已移到映射写的项目，才移除它的设置与记录、删除它。任一条不成立就只移绑定：原项目原样留在库里，`action` 为 `kept`，`holds` 写明原因，如何处理由用户定。

| `holds` 的值 | 含义 |
| --- | --- |
| `absent`、`deleted` | 原项目不在库里，或已删除 |
| `not-setup-configuration` | 外部键不以 `SETUP-CONFIG-` 开头，不是 setup 建的 |
| `projects` | 有未删除的子项目 |
| `work`、`conferences`、`conference-minutes`、`minutes`、`gates`、`templates` | 有归它的这类记录 |
| `setting:<键>` | 有 `artifact.language` 以外的设置 |
| `record:<集合>:<键>` | 有受管段以外的配置记录 |
| `cards`、`cards-unreadable` | 有归它的卡；或知识库读不出，这时一律保留 |
| `writer:<写入者>` | 有 `agent:setup` 以外的写入者写过它；未启用署名的库不记写入者，不会出现这一项 |
| `registry-not-moved`、`identity-not-moved`、`sections-not-moved` | 只在执行时出现：注册项、链身份或受管段记录还没移到映射写的项目 |

受管段按映射写的项目重写：`AGENTS.md` 的系统变量段（`variables-system`）里，`Configuration target:` 一行改为该项目，段标记的 `rev` 加一。该文件由项目仓跟踪时，工作树里会出现这处改动，提交与否由用户定。

## Project roles after import

Imported old events retain their bytes and identities. A partition's chain role
comes only from its explicit `chainRole` in the mapping: `"coordination"` for the
mapping's one coordination chain, whose identity names its own library, and
`"project"` for a concrete project, whose identity names that coordination
partition's library. A mapping takes at most one coordination partition, and
project partitions need it in the same mapping; otherwise the plan refuses with
`SETUP_ANSWER_INVALID` on `chainRole`. The identity is written after the import is
checked, and the registry entry records the role; the identity's event carries the
actor `agent:setup` only in a library whose old chain enabled actor attestation
(see 「迁移完成后」 above), and in one that never did, it carries no actor. A
library migrated before without an identity gets it on the next run; one with
another identity stops the plan (`SETUP_LIBRARY_CONFLICT`) until `chain-declare`
changes it. A project row may also name `projectId`, a live project of its old
chain: the identity then names that project as `primaryProjectId`, and the
registry entry records it as `projectId`. A library migrated before whose identity
names no primary project gets the row's on the next run; one whose identity names
another stops the plan (`SETUP_LIBRARY_CONFLICT`) until `chain-declare` changes
it. A coordination row names no project, so neither the coordination library's
identity nor its registry entry records one.
A partition without `chainRole` stays unclassified, and the plan
shows `chainIdentity: null`; work project relations remain undecided until
explicitly declared. With roles, `--project` must name the root of a project
partition: the wizard writes that project's language and managed sections, and a
coordination chain takes neither, so a plan whose `--project` is the
coordination partition's root is refused at plan time (`SETUP_ANSWER_INVALID`,
one blocker naming a project partition's root to plan again with, the same
mapping) and nothing is imported. The coordination chain keeps its own artifact
language and orchestration limits instead: the plan's coordination partition
carries `coordinationSettings`, rows `{ key, value, source, action }` for
`artifact.language` (always: the old chain's library-level value,
`source: "legacy-declared"`, else the catalog default, `"legacy-default"`) and for
`execution.maxConcurrentSubagents` and the four `quota.*` keys when the old chain
declares them. `action: "carried"` means the import already holds the value at the
coordination library's library level; a `"write"` row is written there by the
apply, signed `agent:setup`, once. An `artifact.language` the old chain does not
declare is listed as `"legacy-default"` with `action: "default"` and is written
nowhere: the coordination library reads the catalog default and records no
language, so its card writes need no language bundle, as before the migration (a
recorded `artifact.language` turns on the write language policy, after which a
card write needs the economy-tier model and `--language-bundle`). These values are never written into a project
chain, and no project chain reads them. Never infer a coordination role from a Cross Project label,
a partition name or a path, or copy its old development settings into a newly
created product as implicit consent. The real Einzbern/Mana product identity and
the roles of the real migration mapping must be supplied at the authorized
migration step.
