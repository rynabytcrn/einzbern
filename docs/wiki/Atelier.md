# Atelier 工作台

Atelier 是项目配置工作台。进入页面后，先核对当前项目与知识库，再查看状态、设置、模型分类与模型档位、变量、规则和门配置。页面中的配置来自引擎管理的项目记录；需要更改时使用 Atelier 或引擎支持的配置入口，不要直接改写 `.ether` 控制文件。

## 启动

Atelier 随引擎装在设备目录里，在终端用 Node 启动：

```text
node ~/.einzbern/engine/<版本>/atelier/portal.mjs [--library <库>] [--port <端口>]
```

设备目录缺省是 `~/.einzbern`，不在这里时换成实际的 `<设备目录>`；`<版本>` 是设备目录 `engine/current` 记着的当前版本，例如 `2.0.0`。

- 选库：`--library` 写库的路径、库 id 或该库已登记项目的路径，只认本设备注册表里登记过的库。不给 `--library` 时读环境变量 `TCRN_PORTAL_LIBRARY`；两者都没有时，依次取启动目录经 `library-resolve` 找到的库、本机设置 `portal.defaultPartition` 指向的已登记库、注册表里的第一项。启动后可以在库切换器里换库。
- 端口：`--port` 指定；不给时读环境变量 `TCRN_PORTAL_PORT`，再没有就用本机设置 `portal.port`（设置页「Atelier 门户」组，重启 Atelier 后生效），仍没有就是 `4319`。
- 只监听 `127.0.0.1`，只能在本机打开；请求的主机名只认 `127.0.0.1` 和 `localhost`，其他主机名以 `PORTAL_HOST_REJECTED` 拒绝。
- 写入者：Atelier 的每次写入都经引擎 CLI，以 `--actor` 带上环境变量 `TCRN_PORTAL_ACTOR` 的值。这个变量必须设置，没有默认值：没设或为空时 Atelier 拒绝启动，在标准错误打印一行 `reasonCode` 为 `PORTAL_ACTOR_REQUIRED` 的 JSON 并以退出码 2 结束。启动时设成实际操作者，例如 `TCRN_PORTAL_ACTOR=<操作者> node ~/.einzbern/engine/<版本>/atelier/portal.mjs`；生成的启动器不写死这个值，从启动它的环境里取，没设时同样拒绝。这个值只说明经哪个入口写入，不证明身份。Atelier 写配置时带 `EINZBERN_SURFACE=atelier`，门、原则、设置与变量的写入事件因此另记 `surface: atelier`。未启用署名的库（链上没有 `attestation.actor.enabled`）不记写入者，事件里不会留下这个值，见[从 TCRN Workflow 迁移](Migrating-from-TCRN-Workflow.md)。
- 页面令牌：Atelier 每次启动随机生成一个令牌，写进它发给浏览器的页面。页面发往 Atelier 接口的请求都在请求头 `x-portal-token` 里带上它，缺少或不符时以 `PORTAL_TOKEN_REQUIRED` 拒绝；所以 Atelier 重启后，已打开的页面要重新载入。通过令牌检查的回答都带 `x-portal-served-target`，写明它服务的是哪个库和配置目标；除切换库、切换配置作用域和本机设置外，写请求另在 `x-configuration-target` 里写明它针对的目标，选择已变时以 `PORTAL_CONFIGURATION_TARGET_CHANGED` 拒绝（见下文「切换知识库」）。

启动成功时，Atelier 在标准输出打印一行 JSON，`reasonCode` 为 `PORTAL_LISTENING`：`url` 是在浏览器里打开的地址 `http://127.0.0.1:<端口>/`，另有打开的库（`library`、`workspace`）、选库依据（`selectedBy`：`argument`、`working-directory`、`machine-default` 或 `first-registered`）、已登记的库数（`libraries`）、AGENTS.md 所在的项目目录（`proseRoot`）、写入者（`actor`）和所用的 CLI（`cli`）。选库与注册表类的启动失败时，在标准错误打印一行 `ok` 为 `false` 的 JSON 并以退出码 2 结束，例如注册表里没有库（`PORTAL_LIBRARY_REGISTRY_EMPTY`，先用 `library-register` 登记），或 `--library` 不是已登记的库（`PORTAL_LIBRARY_UNKNOWN`）。端口已被占用时，Node 直接报 `EADDRINUSE`，退出码 1。

Atelier 在前台运行，没有停止命令：在启动它的终端按 Ctrl-C；在后台启动的，结束这个 node 进程。

## 状态

状态页用于核对当前引擎、项目与已选知识库。链上工作记录的状态仍以引擎只读结果为准，例如 `status`、`work-list` 和 `work-show`；页面显示不能代替对具体 Story 的读取。

## 知识

状态页的「知识」标签列出当前知识库的卡片与文章索引，只读元数据，默认只列有效卡片。上方的「卡片状态」可以改为「已移除卡片」或「有效与已移除」，对应 `knowledge-list --status removed` 与 `--status all`；只在需要查看已移除卡片时切换。

已移除卡片只显示编号、主题、移除原因（冲突被取代、判为无效、与工单或决策重复）、依据、操作者与时间，以及取代它的卡片。它的正文已清除：页面不提供读取正文的按钮，经引擎读取也会以 `KNOWLEDGE_CARD_REMOVED` 拒绝。移除是终态，页面和引擎都没有恢复入口；移除有误时写一张新卡。移除由 `knowledge-remove` 写入，不在 Atelier 中进行。

新建的库还没有知识存储时，`knowledge-list` 回答空库存（`knowledgeStore` 为 `absent`），「知识」标签显示「尚无知识」的空状态，而不是读取失败；卡片状态筛选仍在。写入第一张卡片或文章索引后，标签按普通列表显示。

## 设置

设置页只放单值的键（`shape` 为 `scalar`），按领域分组：通用、模型与升档、执行与限额、知识、召回、存储、Atelier 门户。一个键归入哪一组、在组内排第几，取自 `settings-catalog` 与 `machine-settings-catalog` 每一行的 `group` 与 `order`；页面本身不保存分组表。每一项都标明存放位置：「项目级（随库同步）」的键写入库中，随库同步到其他设备；「本机」的键只存在这台设备的设备目录里。多条记录的配置（`shape` 为 `collection`）不在设置页编辑，「模型与升档」组里的链接会打开它们各自的页面。

项目绑定中「从此项目继承默认值」所存的来源项目，在本设备无法解析时（未登记、登记位置打不开，或继承关系绕回当前目标），设置页照常打开：本该继承它的键显示「—」，并注明继承的默认值不可访问，不显示缺省值；项目绑定区把这个已存选择列在第一位，写明原因，可以改选其他项目后保存，或点「停止继承默认值」移除它。移除后各键恢复正常显示。引擎在求有效配置、项目上下文与按工单运行门时仍如实拒绝这样的目标。

## 模型分类与模型档位

`models.category` 与 `models.tiers` 是两张记录表，各占一页，用同一个表格组件：第一列是「顺序」，页头写明该页顺序的用途。默认分类为 `flagship`、`main`、`economy`（顺序 10、20、30），默认档位表为 `claude-code` 与 `codex` 在每个分类各一条。

- 模型分类页：每条记录有顺序、标识、名称和说明，顺序越小分类越强。每个分类显示归入它的档位数；点击档位数会打开模型档位页并标出这些档位。
- 模型档位页：每条记录有顺序、分类、运行器、模型、effort 和备注。顺序在全表内唯一，越小越强。规则只指定分类，取该分类中顺序最大的记录；升档时沿顺序取更小的上一条。分类列是下拉框，旁边的链接打开模型分类页并标出该分类。

两页都整表保存：修改先留在页面上，点「保存整张表」时一次写入，由引擎当作一个值校验。引擎拒绝时页面保留提交的表，并在涉及的行下显示原因码：顺序重复为 `MODELS_ORDER_DUPLICATE`，档位引用的分类不存在为 `MODELS_CATEGORY_UNKNOWN`，分类标识重复为 `MODELS_CATEGORY_DUPLICATE`。仍有档位归入、或升档上限 `models.escalation.ceiling` 指向的分类不能删除，`MODELS_CATEGORY_IN_USE` 显示在表格上方，并列出仍引用它的档位记录或 `models.escalation.ceiling`；「恢复默认表」若会去掉上限指向的分类，也同样被拒。因此分类表总会留着上限指向的分类；只有合并让上限指向了表中没有的分类时，这条限制才不起作用。形如凭据的值会存入库中，但不写入 AGENTS.md，所在行标出 `secret-shaped`。空表会提示先做什么；还没有任何分类时，档位页引导先去模型分类页添加分类。表格与默认值不同时，可以用「恢复默认表」退回默认值。

模型档位页顶部只读显示三个升档键的当前值：是否升档（`models.escalation.enabled`）、每步退回次数（`models.escalation.threshold`）和升档上限（`models.escalation.ceiling`）。这三个键只在设置页修改，摘要旁的链接打开设置页的「模型与升档」组。

写入模型分类、模型档位、三个升档键或 `design.authority` 之后，Atelier 会重新渲染 AGENTS.md 的受管段。

两页是否可以保存，跟随当前链 `settings-catalog` 是否列出该键。协调链只保存它自己的运行设置，目录里没有模型分类与模型档位，所以这两页在协调链上只读：没有添加、保存与恢复默认，页首写明「模型配置属于各个具体项目」。门、变量与规则页在协调链上照常保存。

## 规则

规则页管理 Command Spell。内置规则及版本为：

| 规则 | 版本 | 初始状态 |
| --- | --- | --- |
| `autonomy` | `v1` | `disabled` |
| `batch` | `v2` | `disabled` |
| `unattended-commands` | `v1` | `disabled` |
| `silent-reporting` | `v1` | `disabled` |

规则状态包括 `disabled`、`enabled`、`user-modified`、`removed-from-file`、`update-available` 和 `pending`。启用前先阅读规则正文；规则本身不会授权更改已批准的工作步骤。

编辑器上方写明所编辑的是哪个仓库的文件（「AGENTS.md · 仓库目录名」），完整路径收在旁边的「完整路径」详情里，可以复制。同一条链的项目登记了两个仓库时，库切换器里是两项，以仓库目录名区分，选哪一项就编辑哪个仓库的 AGENTS.md。当前目标的项目登记了多个仓库、无法确定是哪一个时，编辑器列出这些仓库，先在库切换器中选定其一再编辑。

每条规则有「顺序」，页头写明它的用途：决定规则段在 AGENTS.md 中的渲染顺序。有顺序的规则排在前面，从小到大；其余按目录顺序。规则卡片也按这个顺序排列。已启用的规则改好顺序后点「保存顺序」，经 `rule-enable --order` 写入，并重读 AGENTS.md；未启用的规则在启用时带上所填的顺序。处于其他状态的规则（例如 `user-modified`、`update-available`、`pending`）要先处理状态再改顺序，因为经 `rule-enable` 改顺序会连带改动它的版本或段落。

## 变量

变量页管理自定义变量：每个变量记录顺序、类型、值和说明，写入后渲染进 AGENTS.md 的自定义变量段。第一列「顺序」的用途写在页头：它决定变量在自定义变量段中的渲染顺序，有顺序的变量排在前面，从小到大，其余按名称；表格也按这个顺序排列。保存经 `variable-set --order` 写入，顺序留空就是不设顺序。值或说明形如凭据时以 `VARIABLE_SECRET_SHAPED` 拒绝。系统变量段由引擎渲染，内容来自模型分类、模型档位与 `design.authority` 等系统变量；它们只能经 Atelier 修改，在设置页和两张模型页里改。

## 门

门记录由命令 argv、项目内根目录、覆盖（路径 glob 或精确 work id）、是否必需、是否启用以及是否仅发布时运行组成，另可带一个顺序。门表分三列：顺序、门与覆盖。每道门的启用、必需与仅发布时运行三个开关，同命令、根目录和保存、移除操作一起放在「门」一列；覆盖一列能完整显示一个 work id。门表、两张模型表与变量表在 1024 像素宽时也不需横向滚动，每一列和每行的操作都在表内；窄宽下放不下的字段值在输入框内滚动显示。门表第一列「顺序」的用途写在页头：它决定门的计划、运行与显示顺序，有顺序的门排在前面，从小到大，其余按名称。保存经 `gates-config-set --order` 写入；顺序留空时保留已记的顺序。顺序不进入门声明摘要，只改顺序不会让已有的运行记录失效。计划门时，引擎按各根目录相对 `--base` 的 Git 变更与覆盖中的路径 glob 求交；带 `--work-id` 时，适用于这些 Story 的门也被选中：全部启用的必需门、Story 或其祖先 `gates` 字段点名的门，以及覆盖中写了 Story 或其祖先 work id 的门；发布计划会列出所有启用的门。运行会收集所有结果。Story 完成之前，适用于它的每一道门都须在当前树与当前门声明下、以带它的 `--work-id` 运行并为绿，覆盖不必列出 Story（TCRN-CROSS-STORY-525，MIN-256）：项目没有启用的门，或没有一道门适用于这张 Story 时不拦；没有绑定该 Story 的运行记录报 `WORK_DONE_GATES_NOT_RUN`，适用门缺结果报 `WORK_DONE_GATES_NOT_COVERED`，适用门失败报 `WORK_DONE_GATES_RED`。路径 glob 只选择和运行门，不把门绑定到 Story。

## 待批准的门与规则改动

模型不能直接声明门或启停规则，可以用 `gates-config-propose` 或 `rule-propose` 提交改动，由人在 Atelier 批准或拒绝（TCRN-CROSS-STORY-527）。有待批准项时，门页顶部出现「待批准的门改动」，规则页的规则卡片上方出现「待批准的原则改动」，没有时这一区不出现。每一行写明要改的门或规则、提出的改动、提出者与时刻，以及状态。它们与门表和规则卡片分开：待批准的门不在门表里，也不会被 `gates-plan` 或 `gates-run` 选中；待批准的规则仍是原来的状态，不渲染进 AGENTS.md。规则页原有的「Pending」指等待处置的受管段，与这里的待批准项不是一回事。

- 「批准」就是写入：门页经 `proposal-approve` 声明或删除这道门，规则页经 `proposal-approve` 启用或禁用这条规则并写 AGENTS.md；两者都以 `TCRN_PORTAL_ACTOR` 为行动者，事件记 `surface: atelier` 与 `decidedIn: proposal:<键>@<提交时刻>`。批准后页面重读列表：门表或规则卡片出现这项改动，待批准区随之清空。
- 「拒绝」经 `proposal-reject` 把这一项改为已拒绝，事件同样记 `surface: atelier`。已拒绝的项留在区里，只读显示拒绝者与时刻，不再有「批准」按钮；模型重新提出后才能再批准。
- 按钮带着页面显示的提交时刻。其间有人重新提出过同一项时，批准或拒绝报 `PROPOSAL_STALE`，重读页面后按新内容处理；已拒绝的项报 `PROPOSAL_NOT_PENDING`。

## 切换知识库

使用项目的知识库选择器切换到已登记的库。切换只更改项目当前绑定；不会搬动、合并或复制库数据。切换前核对目标库身份，切换后再从状态页确认选中的项目与库。不要通过复制或手改 `.ether` 文件来切换。

切换库或配置目标时，页面在读取新目标之前先清空属于原目标的内容：设计权威提示、回执（徽标回到空闲，抽屉关闭）、项目就绪结果与已打开的知识正文。每个回答都注明它所服务的目标，页面只采用与当前所示目标相符的回答，迟到的旧回答直接丢弃。

同一台设备上开着两个 Atelier 页签时，选择只有一份。另一个页签切换了库或目标之后，本页的下一次读取会被拒绝：页面上方提示另一个页签已切到哪里、本页原在哪里，不会把对方的值显示在本页名下，保存也同样被拒。点「切回」回到本页原来的目标，或点「改看」改为显示对方所选的目标。别处被拒绝的切换不改变选择，本页照常读取，不出现提示。

## Involved projects and target details

The work view edits explicit undecided, coordination-only or selected project
scope and filters by stable project reference. A child stays within its parent's
declared scope, as the engine requires: under a parent with selected projects
only those can be chosen, under a coordination-only parent none can, nor the
selected scope, and the unavailable choices say why. A refused save shows the
engine's reason code, its own words and how to recover. Project readiness shows,
for every target, its status, whether it is ready for development and what it
still misses; "not ready" is information, shown with the neutral badge. A
setting whose value differs between the targets is listed with each target's
value and where that value comes from. The work tree lists each Story's Subtasks
under it, every row naming the projects it involves, and the project filter
keeps a matching Subtask with its parents. Selecting a project does not grant
permission to edit its files. Lists, the library switcher, the rail and the top
bar show each project's own name from its project record; only a project without
a name reads "Unnamed project" in the page's language, and names that read alike
carry the shortest tails of their ids that tell them apart. One chain's project
registered for two repositories is two entries in the library switcher, told
apart by the repositories' directory names, never by a path. The Details under
each list keep the full identities: the summary opens and closes from the
keyboard, Escape closes it and returns focus, and each identity has a copy
action. Saving reads the work list again through the work view's own read, so a
library left in the meantime is not shown. Switching while a target write is in
flight is refused, and stale form revisions require reloading. Coordination
chains do not expose development settings.

## 工单租约

工作视图的工单树里，持有租约的工单在自己那一行（Initiative 与 Epic 在分组标题上）显示持有者与到期时刻，取自 `work-list` 每条的 `lease`（TCRN-CROSS-STORY-528，MIN-256）。是否仍在租期内按读取时的本机时钟判断，已到期的租约写明已到期。下级工单的行不重复显示上级的租约，但同样受它约束。

旁边的「释放租约」按钮在 Atelier 里强制释放这张工单的租约：门户以 `TCRN_PORTAL_ACTOR` 为行动者运行 `work-release --force true`（`--force` 只在 `EINZBERN_SURFACE=atelier` 下可用），回执照常显示，工单树随即重新读取，`work-show` 的 `lease` 变为 `null`。Atelier 自己的写入同样受他人租约约束：要改他人租用的工单，先在这里释放。约束一张工单的若是上级的租约，到上级那一行释放。
