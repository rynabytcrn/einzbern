# 受管段与 Command Spell

AGENTS.md 与 CLAUDE.md 是你的文件。Einzbern 只写它自己标记出来的几段，叫受管段；段外的文字一个字节都不改。Command Spell 是随引擎提供的四条原则，按项目逐条启用，启用的原则以受管段写进 AGENTS.md。

## 段的格式

一段由两行标记围住，每行标记独占一行：

```text
<!-- einzbern:section id=<段 id> rev=<修订号> digest=<sha256> -->
正文
<!-- einzbern:section-end id=<段 id> -->
```

- `digest` 是正文归一化之后的 sha256。归一化把 CRLF 换成 LF，去掉每行行尾的空白，末尾恰好留一个换行。所以编辑器把换行存成 CRLF，或在行尾留下空格，都不算修改。
- 库里为每一段记一条记录（`managed-section` 集合，键为 `<文件名>#<段 id>`），记下修订号、摘要和状态。
- 只有三处摘要一致时，引擎才替换这一段：起始标记里的、库记录里的、按正文现算的。不一致说明你改过它，这一段原样保留，记录转为待处理（pending）。
- 标记被删掉的段，视为你移除了它，不再补回。
- 标记解析不了时（缺结束标记、段套段、同一 id 出现两次、属性写错），整个文件拒写，报 `MANAGED_SECTION_MALFORMED` 并给出行号。
- 文件不存在时，只有在确实有段要写的情况下才创建。
- 替换之前，先把原文件复制到设备目录的 `backups/<UTC 时间>/managed-sections/` 下，再经临时文件加改名替换。
- 段里从不写绝对路径。引擎升级不会自动改写任何文件。

| 段 id | 所在文件 | 内容 |
| --- | --- | --- |
| `claude-import` | CLAUDE.md | 一行 `@AGENTS.md`；只在 CLAUDE.md 还没有导入 AGENTS.md 时写。没有 CLAUDE.md 的项目会得到只含这一段的 CLAUDE.md。 |
| `navigation` | AGENTS.md | 三行导航：本项目由 Einzbern 管理、开工前加载 Mana Orchestrate、先检索再动手。只在本机的 `agents.navigation` 为 `written` 时写；选了 `declined` 的设备改由 SessionStart 与 SubagentStart 两个指针钩子给出同样三行。 |
| `variables-system` | AGENTS.md | 系统变量：模型分类 `models.category` 与模型档位 `models.tiers`（都按顺序排列）、三个升档键 `models.escalation.*`，以及 `design.authority`，见「变量」页。 |
| `variables-custom` | AGENTS.md | 自定义变量，见「变量」页。 |
| `rule:<规则 id>` | AGENTS.md | 一条已启用的 Command Spell 原则的正文。 |

`agents-render [--project <目录>] --at <时刻>` 按库里的记录把上表各段渲染进本机注册表解析出的项目。`--project` 可以是项目里的任何目录，省略时取当前目录。回执 `AGENTS_RENDERED` 列出每一段的 `{id, file, result, state}`、等待你处置的段和备份目录。

## 你改过的段：三种处置

被你改过的段会停在待处理状态，直到你决定怎么办：

```text
rule-resolve --section <段 id> --action overwrite|keep|unmanage [--force true] [--project <目录>] --at <时刻>
```

| 处置 | 做什么 | 之后 |
| --- | --- | --- |
| `overwrite` | 把引擎的正文写回去，作为新的基线 | 这一段重新受管。覆盖一段你保留过（keep）或接管过（unmanage）的段，要加 `--force true`。 |
| `keep` | 把文件里现在的正文记为你的版本，不写文件 | 引擎再也不写这一段。 |
| `unmanage` | 去掉两行标记，留下正文 | 这段文字从此只归你，引擎不再管理。 |

把一段从文件里拿掉（禁用）时，改过的段同样要加 `--force true`，否则报 `MANAGED_SECTION_FORCE_REQUIRED`，拒绝信息里带 `file` 与 `section`。

## Command Spell：四条原则

| id | 版本 | 名称 | 大意 |
| --- | --- | --- | --- |
| `autonomy` | 1 | 自主运行原则 | 使用者不在实时观看，中途问「要不要继续」只会让工作停摆。原始请求涵盖的可逆动作直接做，只有破坏性动作与真正的范围变更才停下来交给使用者。 |
| `batch` | 3 | 批量处理原则 | 一个 INIT 下的全部待办 Story 是一批：拆分一次做完，实施分包并行，见红只记不修，生成物批末再生，一批一次链写、一次汇报，派工按批段；「一次」按轮计，一轮做完即以判断清单开下一轮，轮间不等答复、不换会话、不汇报；知识采集按轮，判断产出 lessons.json，主线程用 knowledge-capture 逐条落卡并读回；小轮的验收与判断由一个主力档代理合并完成；证据按摘录读。 |
| `unattended-commands` | 1 | 无人值守指令原则 | 无人值守时弹出确认框等于停摆：删除改为移到 scratch 的 trash 子目录，命令里不 cd，只写工作目录与 scratch 目录，不碰权限规则列出的路径与命令，弹过框的写法不重试。 |
| `silent-reporting` | 1 | 静默汇报原则 | 工作进行期间主对话不输出进度汇报；只在全部完成或剩余任务全部阻塞时汇报一次；一轮做完、下一轮开始之间同样不汇报。 |

每条原则有中文与英文两份正文，按项目的 `artifact.language` 选择：`zh-CN` 写中文，其他取值或未设置时写英文。中文正文是定稿；`autonomy`、`batch`、`unattended-commands` 三条的英文待 Owner 事后更正；`batch` 第 6 条末尾的小轮合并、第 7、8、9 条与 `silent-reporting` 最后一句的英文是代理译文，同样待 Owner 更正。四条原则默认全部关闭。

### 启用与禁用

- `rule-list [--project <目录>]`：列出每条原则的 `{id, version, recordedVersion, fileVersion, section, state}`，库里记有顺序的原则还带 `order`；只读，不写任何文件。`version` 是本机引擎带的版本，`recordedVersion` 是库里记录的版本，`fileVersion` 是段起始标记里的修订号。
- `rule-enable --id <规则 id> [--order <正整数>] [--project <目录>] --at <时刻>`：在库的 `rule` 集合里记下 `{enabled: true, version}`（版本取本机引擎带的版本），并把正文作为 `rule:<规则 id>` 段写进 AGENTS.md。回执 `RULE_ENABLED` 给出原则的新状态、这一段的处理结果和备份目录。
  - 带 `--order` 时同时记下这条原则的顺序；不带时保留库里已记的顺序。
  - 对已经启用的原则只改顺序时，这一段的结果是 `unchanged`，文件按新顺序重排。
  - `--order` 不是正整数时报 `CLI_ARGUMENT_MALFORMED`，什么也不写。
- `rule-disable --id <规则 id> [--force true] [--project <目录>] --at <时刻>`：连同标记把这一段从 AGENTS.md 拿掉，并记下 `{enabled: false, version}`，已记的顺序保留，重新启用时回到原来的位置。你改过的段要加 `--force true`。回执 `RULE_DISABLED`。

原则的启停由人在 Atelier 的规则页里做（TCRN-CROSS-STORY-513 R1）。环境变量 `EINZBERN_SURFACE` 不为 `atelier`、也没有以 `--decided-in` 引用 Owner 决定时，`rule-enable` 与 `rule-disable` 一律拒绝，只带 `--order` 的调整也一样：报 `MODEL_WRITE_REFUSED`，补救提示为 `change it in Atelier, or cite the Owner's decision with --decided-in minutes:<id>#D<n>`，details 的 `rule` 是原则 id，库与 AGENTS.md 都不动。在 Atelier 里启停，或以 `EINZBERN_SURFACE=atelier` 运行同一条命令，照常写入。这是约定，不是身份保证：CLI 分辨不了是谁在运行它，自己带上这个变量的调用同样放行（见「变量」页的模型写保护）。`rule-list`、`rule-resolve` 与 `agents-render` 不受限。下文「怎么办」一栏里的 `rule-enable` 与 `rule-disable` 也照此在 Atelier 里做。

模型也可以引用 Owner 的决定来启停原则（TCRN-CROSS-STORY-526）：加 `--decided-in minutes:<id>#D<n>`，`<id>` 是纪要 id，`<n>` 是决定序号，外部键号写法不认。引擎在写锁内核对这条决定，四条都满足才写入：纪要能找到（先在本库找，本库没有时按本库链身份里的协调库 id，到本设备注册表登记的协调库里只读查找）；这份纪要的 `decidedBy` 含 `owner:governance`；这条决定仍有效（被取代或撤回的不算）；决定正文写出了这条原则的 id，前后不紧接字母、数字或 `._:-`，或者写出 `<前缀>.*` 而原则 id以 `<前缀>.` 开头。核对在动 AGENTS.md 之前完成。核对通过时照常写入，这次启停追加的每条事件（原则记录与受管段记录）另记 `decidedIn`（完整的决定编号）、`decidedInLibraryId`（纪要所在库的 id）与 `surface: cli`；核对不通过报 `MODEL_WRITE_AUTHORIZATION_INVALID`，错误带 `decidedIn`、`target` 与 `reason`（`malformed`、`not-found`、`not-owner-decided`、`obsolete`、`target-not-named`，也写在错误文本里），库里不追加任何事件。Atelier 的写入记 `surface: atelier`。引用只让写入可追溯，不证明 Owner 真的做了这个决定。

`agents-render` 也渲染已启用原则的段：项目换了 `artifact.language`，下一次渲染就换成对应语言的正文。

### 提交待批准

模型要启停原则有两条路（TCRN-CROSS-STORY-541，MIN-258 D3）：手里有点名这条原则 id 的 Owner 决定时，直接用上一节的 `rule-enable` 或 `rule-disable` 加 `--decided-in` 写入，不必提议；没有决定时，提交待批准的启停，由人在 Atelier 的规则页里批准或拒绝（TCRN-CROSS-STORY-527）：

```text
rule-propose --id <规则 id> [--action enable|disable] [--order <正整数>] [--project <目录>] --actor <行动者> --at <时刻>
rule-list --status pending|rejected
proposal-approve --key rule:<规则 id> --proposed-at <提交时刻> [--project <目录>] --actor <行动者> --at <时刻>
proposal-reject --key rule:<规则 id> --proposed-at <提交时刻> --actor <行动者> --at <时刻>
```

- 待批准项记在库的 `proposal` 集合里，键为 `rule:<规则 id>`。它不启用原则，也不写任何文件：`rule-list` 缺省列出的状态不变，`agents-render` 与 `rule-resolve` 不渲染它。`rule-list --status pending` 或 `--status rejected` 列出对应状态的待批准项。注意这里的待批准项与六种状态里的 `pending`（等待处置的受管段）不是一回事。
- 批准只在 Atelier 运行，与 `rule-enable`、`rule-disable` 一样先写 AGENTS.md 再追加记录：原则记录、段记录与移除待批准项在同一次追加里，追加失败时文件放回原样。事件记 `surface: atelier` 与 `decidedIn: proposal:rule:<规则 id>@<提交时刻>`。拒绝、重新提出与过期的处理同门，见「门」页的「提交待批准」。

### 原则段的顺序

库里有原则记着顺序（TCRN-CROSS-STORY-508 R7）时，AGENTS.md 里的原则段按顺序排列：

- 有顺序的在前，按从小到大。
- 没有顺序的在后，按引擎目录的次序：`autonomy`、`batch`、`unattended-commands`、`silent-reporting`。
- 本机引擎不带的原则排最后，按 id。

排列只在原则段已经占着的位置之间进行，所以这些位置不动，段外文字一个字节都不动；每一段整段移动，正文与标记都不变。你改过、正等待处置、保留过或接管过的段留在原位，其余的段按顺序填满剩下的位置。

`rule-enable` 与 `agents-render` 都会这样排列。库里没有任何原则记着顺序时，不做任何排列：段仍按写入的先后排着，与从前一样。

### 六种状态

| 状态 | 含义 | 怎么办 |
| --- | --- | --- |
| `disabled` | 没有启用：库里没有这条原则的记录，或记录为关闭。 | `rule-enable` |
| `enabled` | 已启用，段里是引擎写的正文。 | 无需处理 |
| `user-modified` | 已启用，但段里不是引擎写的正文：你改过它，或者用 `keep` 把你的版本留了下来。 | 用 `rule-resolve` 处置；保留下来的段引擎不再写。 |
| `removed-from-file` | 已启用，但 AGENTS.md 里没有这一段的标记。 | 引擎不会补回。要重新写入，先 `rule-disable` 再 `rule-enable`。 |
| `update-available` | 本机引擎带来了更高的版本，库里记的仍是旧版本；文件保持原样。 | `rule-enable` 取新版本。 |
| `pending` | 一次写入因为你的修改被拒绝，正等待处置。 | `rule-resolve` |

版本与本机引擎不一致的原则，`agents-render` 原样保留：旧版本等你用 `rule-enable` 更新，由更新的引擎启用的新版本也不会被旧正文覆盖。库里记录的版本比本机引擎带的更新时，`rule-enable` 报 `RULE_VERSION_NEWER`，提示先升级引擎。

批量处理原则 v3 保留 v2 六条原则，并追加代理通信与等待：普通进度与可延后问题按完整包交付；宿主已通知完成时不重复发送。安全、硬阻塞及会阻塞其他代理的依赖或冲突可立即协调。主代理直接处理需要决策或行动的信息，不纯确认或催问普通进度；等待使用宿主通知及阻塞等待，无新状态时延长间隔，遵守等待上限、用户中断并继续独立工作。Owner 在同一版本内追加第 7 条：「一次」按轮计，一轮内拆分、每包实施、集成、名册、验收、判断各做一遍，不逐红重复；一轮做完，判断列出的问题清单与排队项就是下一轮的输入，直到 goal 写明的终态达成，或剩余工作全部阻塞于只有 Owner 能做的决定；轮与轮之间不等 Owner 答复、不换会话、不汇报。Owner 第五轮在同一版本内再追加第 8 条：知识采集按轮，每轮的单名判断代理在判断报告旁产出 lessons.json（每条含 subject、summary、snippet、body、tags 与来源证据路径，只写本轮新确立的事实与教训，不超过 5 条），主线程在同一轮的链写里用 knowledge-capture 逐条落卡并读回，卡被预算拒绝就记阻塞、迁移后补写，不依赖 Stop 钩子的标记行采集。Owner 在同一版本内又于第 6 条末尾补入小轮合并，并追加第 9 条：本轮实施包不超过 2 个或验收只有一片时，验收与判断由一个主力档代理一次完成，仍按原格式写验收、判断与 lessons 三份文件，并顺带写出下一轮的拆分文件，不另派拆分代理；验收两片以上的轮维持验收分片并行、判断单独、拆分单独；没有实施包、只有链写或文档动作的轮，不派拆分与验收代理，主线程完成动作后派一个主力档代理读回并判断。第 9 条证据按摘录读：治理代理与主线程只读派工指明的摘录文件、节号或行号范围，不整读拆分、计划、判断、台账与 routing 文件；工具输出先写进文件再按需读入，每次不超过 200 行；超过 32 KB 的文件不整读，宿主的读取守卫会拒绝并给出改法。

已有 batch v2 仍适用且保持原字节；rule-list、Atelier 读取及普通 agents-render 只显示 update-available，显式 rule-enable 升级才写 v3。用户修改仍按 user-modified/pending 与 keep/overwrite/unmanage 保护。正文验证不是运行期遵守证明，未经可比会话测量的 token 节省为 unknown。

同一版本内的正文修订不改版本号（INIT-053 R40：batch v3 追加第 7 条，silent-reporting v1 追加「一轮做完、下一轮开始之间同样不汇报」一句，Owner 在自己的 AGENTS.md 里把这两段记为修订号 2；INIT-053 R48：batch v3 追加第 8 条「知识采集按轮」，Owner 把该段记为修订号 3；INIT-053 R52：batch v3 在第 6 条末尾补入小轮合并，并追加第 9 条「证据按摘录读」，Owner 把该段记为修订号 4）。已在该版本启用的原则，rule-list 与 Atelier 仍读作 enabled，没有单独的「正文过期」状态；下一次 agents-render 把未改动的段换成修订后的正文，段的修订号加 1；你改过的段照旧不被覆盖，按 user-modified/pending 等待处置。

## Project-bound output

Managed output uses the selected project's effective settings and provenance.
Explicit common defaults may supply settings but do not inherit managed-file
digests or gate coverage. Existing user-modification checks and explicit rule
upgrades remain required; a work relationship cannot authorize another root.
