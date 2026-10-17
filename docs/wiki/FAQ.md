# 常见问题

## 我在 AGENTS.md 里改了 Einzbern 写的一段，会被覆盖吗？

不会。引擎只在三处摘要一致时才替换一段；你改过的段原样保留，记录转为待处理。之后用 `rule-resolve` 决定：`overwrite` 写回引擎的正文，`keep` 把你的版本留下（引擎再也不写这一段），`unmanage` 去掉标记、把文字交给你。细节见「受管段与 Command Spell」页。

## 编辑器把换行存成了 CRLF，或者在行尾留了空格，算修改吗？

不算。摘要按归一化之后的正文计算：CRLF 换成 LF，行尾空白去掉，末尾恰好一个换行。

## 我删掉了一整段（连同标记），下次渲染会补回来吗？

不会。标记不在了，引擎就当你移除了这一段，记录转为 `removed`。如果那是一条 Command Spell 原则的段，它的状态变为 `removed-from-file`；想重新写入，在 Atelier 里先停用再启用这条原则（`rule-disable` 再 `rule-enable`）。

## 引擎改写文件之前会备份吗？备份在哪里？

会。替换之前先把原文件复制到设备目录下的 `backups/<UTC 时间>/managed-sections/`（设备目录缺省是 `~/.einzbern/`）。`agents-render`、`rule-resolve`、`rule-enable` 与 `rule-disable` 的回执都给出备份目录。

## AGENTS.md 的受管段标记写坏了怎么办？

引擎拒绝写这个文件，报 `MANAGED_SECTION_MALFORMED` 并指出行号。`agents-render` 先规划 AGENTS.md 与 CLAUDE.md 两个文件再动笔，所以另一个文件也不会写。修好那一行（或删掉残缺的标记）之后重新运行即可。

## 为什么 Command Spell 的原则默认全部关闭？

原则改变的是 Agent 在这个项目里的工作方式，是否采用由项目自己决定。在 Atelier 的规则页逐条打开（命令是 `rule-enable --id <规则 id>`，以 `EINZBERN_SURFACE=atelier` 运行），`rule-list` 查看每条的状态。

## 引擎升级带来了原则的新版本，我的 AGENTS.md 会自动更新吗？

不会。引擎升级不写任何文件。`rule-list` 会把这条原则标为 `update-available`，`agents-render` 也保持文件原样；在 Atelier 里重新启用它（`rule-enable --id <规则 id>`）才会换成新版本的正文。

## 原则写成中文还是英文？

按项目的 `artifact.language`：`zh-CN` 写中文，其他取值或未设置时写英文。改了这个设置之后运行一次 `agents-render`，已启用原则的段就换成对应的语言。

## 为什么 settings-set、variable-set、rule-enable 或 gates-config-set 报 MODEL_WRITE_REFUSED？

项目配置由人在 Atelier 里改：设置、变量、Command Spell 原则的启停和门声明都是。环境变量 `EINZBERN_SURFACE` 不为 `atelier`、也没有以 `--decided-in` 引用 Owner 决定时，`settings-set`、`settings-remove`、`variable-set`、`variable-remove`、`rule-enable`、`rule-disable`、`gates-config-set` 与 `gates-config-remove` 一律拒绝，补救提示是 `change it in Atelier, or cite the Owner's decision with --decided-in minutes:<id>#D<n>`，库里不追加任何事件。补救有两条：在 Atelier 里改（或以 `EINZBERN_SURFACE=atelier` 运行同一条命令），或者给同一条命令加 `--decided-in minutes:<id>#D<n>`，引用 Owner 的一条决定。引用的决定要满足四条：纪要能在本库或本库链身份指向的协调库里找到，纪要的 `decidedBy` 含 `owner:governance`，决定仍有效，决定正文写出被改对象的名字（或写出 `<前缀>.*` 而名字以 `<前缀>.` 开头）。不满足时报 `MODEL_WRITE_AUTHORIZATION_INVALID`，`reason` 说明哪一条没过，库里不追加事件；满足时写入，事件记下 `decidedIn`、`decidedInLibraryId` 与 `surface: cli`。细节见「变量」页的「引用 Owner 的决定」。这是约定，不是身份保证：CLI 分辨不了是谁在运行它，这道软屏障挡的是模型在工作途中顺手改配置，不是蓄意绕过。读取从不拒绝。

## 变量里能放 API 密钥吗？

不能。AGENTS.md 会随项目提交，形如凭据的值或说明在写入时就被拒绝（`VARIABLE_SECRET_SHAPED`），库里不留记录。密钥放在宿主或系统自己的密钥存储里。

## Story 转为完成时报 WORK_DONE_GATES_NOT_RUN，该怎么办？

项目有门适用于这张 Story（启用的必需门，Story 或其祖先 `gates` 字段点名的门，或覆盖写了它或其祖先 work id 的门；TCRN-CROSS-STORY-525），但本设备还没有在当前这棵树与当前这组门声明上以带它的 `--work-id` 跑过这些门。先运行 `gates-run --base <提交> --work-id <Story id> --at <时刻>`：非 release 运行必须给 `--base`，发布时改用 `--release true`；`--work-id` 把这次运行绑定到这张 Story，没有绑定的运行不能放行它，一次 `--work-id A,B` 的运行可以分别放行 A 与 B。适用门全部为绿之后再转换。之后又改了文件或门声明，要重新跑。

在项目库上，这条 `gates-run` 还要带 `--project-id <Story 的项目>`：判据只认记录了 Story 项目的运行。不带时，不带 `--project` 的调用只要注册项记着这个项目，就以 `GATES_PROJECT_UNKNOWN` 拒绝，不会运行；带 `--project` 的调用得到一次 0 道门、`ok` 为 `true`、不记项目的空运行。两种都过不了完成判据，转换仍报这个错，要等运行带上 `--project-id` 才能转完成。在协调库上不必带：协调库在 Story 的项目里适用于它的门，会在协调库为它登记的项目根按 Story 的项目运行（TCRN-CROSS-STORY-519），协调库的注册项不带 `projectId` 也找得到这个根。细节见「门」页。

## gates-run 的结果存在哪里？

设备目录的 `cache/<库 id>/gate-runs/` 下，每次运行一个 JSON 文件，连同运行时那棵树的摘要。它属于本设备，不随库同步。

## 一次已经提交的改动，gates-plan 为什么什么都没选？

非 release 计划必须给有效的 Git 提交 `--base`，不会隐式使用 `HEAD`，不给就报 `GATES_BASE_REQUIRED`。已经提交的改动相对 `HEAD` 没有差别，所以 `--base HEAD` 选不中按路径 glob 覆盖的门；用 `--base` 指向这次改动的分叉点，例如 `--base main`。带 `--work-id` 时，适用于 Story 的门（必需门、`gates` 字段点名的门、覆盖写了它或其祖先 work id 的门）另被选中，与改动无关。

## 钩子看起来没反应，怎么知道它有没有运行？

钩子只在本设备注册表登记过的项目里回答提示，其他地方照常以退出码 0 结束、什么也不输出，所以「没反应」和「没运行」看起来一样。分辨它们看设备目录的 `log/hook.ndjson`（设备目录缺省是家目录下的 `.einzbern/`，`EINZBERN_HOME` 可以改），每行一个 JSON 对象，`reasonCode` 说明这一次提示为什么得到这样的结果。已登记项目里的每次提示都由召回追加一行，答没答都记：`HOOK_RECALL_ANSWERED` 是有强命中、已经回答；`HOOK_RECALL_NO_HITS` 是召回跑了但没有强命中；`HOOK_RECALL_PROMPT_EMPTY` 是提示为空；`HOOK_RECALL_LIBRARY_UNCONFIRMED` 是注册表不再把这个目录解析到启动器匹配的库，按恢复办；其他代码是召回失败本身的原因码，钩子的 stderr 上也是同一个。提示所在的目录属于已知容器（库、旧布局工作区或旧平台容器）而注册表没有覆盖它时，由启动器追加一行，多带 `container` 与 `marker`：`HOOK_REGISTRY_ABSENT` 是本设备没有注册表，还没装好；`HOOK_PROJECT_UNREGISTERED` 是目录在旧布局里、没有登记的项目，按迁移办；`HOOK_LIBRARY_UNREGISTERED` 是目录里的库没有登记，按恢复办。这个文件每次这样的提示长一行，不会自动轮转，删掉不丢任何东西；写不进去时直接放弃，不影响钩子的输出。提示之后没有新行，说明目录不在已知容器里，或者钩子根本没有走到引擎，这时看 `doctor` 的 `hooks-present` 和钩子 stderr 上启动器的拒绝原因；平台容器上的 `platform-doctor` 还会把「钩子指向的脚本不存在」（`PLATFORM_HOOK_TARGET_UNAVAILABLE`）与「启动器在、但设备上没有装好引擎」（`PLATFORM_HOOK_ENGINE_NOT_INSTALLED`）分开报，家目录下用户级的 `.claude/settings.json` 与 `.codex/hooks.json` 也在它检查的范围内。

## Wiki 怎么更新？

Wiki 的每一页都在引擎仓库的 `docs/wiki/` 里编辑，不在网页上改。`scripts/push-wiki.mjs --wiki-dir <Wiki 仓库的本地工作树>` 把 `docs/wiki/` 同步进那个工作树并在本地提交，然后列出将要推送的提交；这是缺省的演练，不会推送。确认无误后加 `--execute push` 才真正推送。

### Does involving a project authorize writes there?

No. `work-project-context` resolves configuration and reports conflicts. Check
authorization and writable roots independently for each target. An unresolved
reference remains unresolved; it is never an empty success or a fallback to
Cross Project's settings.

## `work-list --status` 能传逗号分隔的多个状态吗？

不能。当前契约一次只接受一个状态：`planned`、`ready`、`active`、`blocked`、`pending-owner-acceptance`、`done` 或 `cancelled`。例如 `work-list --workspace <库> --status active`。`--status active,blocked` 会报 `CLI_ARGUMENT_MALFORMED`，不是多状态查询；要查询多个状态，请分别调用并按记录 ID 合并结果，或者省略 `--status` 后在调用方筛选。每次调用仍需按 `--limit` 与 `--offset` 分页，不要把第一页当作完整结果。本次修订只澄清现有契约，不扩展 CLI 的旗标语义。

## 没有配置输出项目根目录，为什么规则不显示为“文件已删除”？

没有可检查的输出根目录时，已启用规则显示 `output-unconfigured`，不再推断 `removed-from-file`。只有实际检查了绑定根目录中的 AGENTS.md、且未找到对应标记时，才报告后者。`outputBindingStatus` 用于区分绑定是否就绪；协调库按项目路径或库加项目 ID 查询，应解析同一设备登记的容器根目录。
