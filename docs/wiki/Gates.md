# 门

门是项目声明的检查命令：测试、类型检查、链接检查，任何以退出码说明好坏的程序都可以。门按项目声明，由改动决定这一次要跑哪几道，没有人手工挑选。Story 转为完成之前，适用于它的每一道门都必须在当前这棵树、当前这组门声明上，以带这张 Story 的 `--work-id` 运行并为绿（TCRN-CROSS-STORY-525，MIN-256）：启用的必需门适用于每一张 Story；Story 或其祖先的 `gates` 字段点名的门、`covers` 写了 Story 或其祖先 work id 的门，也适用于它。`covers` 不必列出 Story。路径匹配只负责选择和运行门，不把门绑定到 Story。

## 门声明

一道门是库里 `gate` 集合的一条记录，键就是门的名字，所以每台合并这个库的设备跑的是同一组门。一条声明写明：

| 字段 | 含义 | 新门的缺省值 |
| --- | --- | --- |
| `command` | 要运行的命令，写成 argv 数组，不经过 shell。 | 必填 |
| `root` | 命令在项目的哪个目录里运行；这个目录下的 Git 改动决定是否选中这道门。 | `.` |
| `covers` | 选择门的 `root` 路径 glob，或精确 work id `work:<24 位小写十六进制>`：写 Story 的 id，门适用于这张 Story；写 Epic 或 Initiative 的 id，门适用于其下每一张 Story。 | `**` |
| `required` | Story 转为完成之前是否必须为绿。 | `true` |
| `enabled` | 是否启用。 | `true` |
| `releaseOnly` | 是否只在发布时运行。 | `false` |
| `order` | 可选，正整数：这道门在计划、运行与显示中的位置（TCRN-CROSS-STORY-508 R7）。 | 无 |

路径 glob 相对 `root` 匹配整条路径：`**` 必须独占一段，匹配任意多段；`*`、`?` 与 `[...]` 只在一段之内匹配。`*.md` 是 `root` 下第一层的 Markdown 文件，`**/*.md` 是任意深度的 Markdown 文件，以 `/` 结尾的 glob 覆盖那个目录下的一切。路径匹配会选择并运行门，但当前没有可信的 Story 到路径映射，所以路径匹配不把门绑定到任何 Story，release 模式也一样。`work:<24 位小写十六进制>` 是 work id，不作为路径 glob 编译：写 Story 的 id，门适用于这张 Story；写 Epic 或 Initiative 的 id，门适用于其下每一张 Story（见「完成判据」）。

```text
gates-config-set --name <门名> --command '<JSON argv>' [--root <目录>] [--covers <glob-or-work-id,...>] [--required true|false] [--enabled true|false] [--release-only true|false] [--order <正整数>] --at <时刻>
gates-config-list
gates-config-remove --name <门名> --at <时刻>
```

例如 `gates-config-set --name links --command '["pnpm","run","verify:links"]' --root docs --covers '**/*.md' --at <时刻>`。再次声明同一道门时，没有给出的旗标保留原来的值，顺序也一样。`--order` 不是正整数时报 `CLI_ARGUMENT_MALFORMED`。`gates-config-list` 按名字列出声明，带顺序的声明带 `order`。

门声明由人在 Atelier 的门页里保存和删除（TCRN-CROSS-STORY-513 R1）。环境变量 `EINZBERN_SURFACE` 不为 `atelier` 时，`gates-config-set` 与 `gates-config-remove` 一律拒绝，报 `MODEL_WRITE_REFUSED`，补救提示为 `change it in Atelier`，details 的 `gate` 是门名，库里不追加任何事件。这样模型在工作途中既不能给自己的 Story 声明一道门再自己满足它，也不能放宽或删掉挡住它的门。在 Atelier 里改，或以 `EINZBERN_SURFACE=atelier` 运行同一条命令，照常写入。这是约定，不是身份保证：CLI 分辨不了是谁在运行它，自己带上这个变量的调用同样放行（见「变量」页的模型写保护）。`gates-config-list`、`gates-plan` 与 `gates-run` 不受限。

## gates-plan：这次改动要跑哪几道门

```text
gates-plan [--project <目录>] [--base <提交>] [--work-id <work-id,...>] [--release true]
```

非 release 计划必须给有效 Git 提交 `--base`，不会隐式使用 `HEAD`。对每一道可在变更模式运行的启用门，取它 `root` 下相对该提交的改动文件：已提交、已暂存、未暂存、已删除、已改名的文件与未跟踪的文件都算；只要一个改动文件落在路径 glob `covers` 里，这道门就被选中，匹配的文件记在 `matched`。`--work-id` 可给一个或多个 Story id，计划还会选中适用于这些 Story 的每一道门：全部启用的必需门，Story 或其祖先 `gates` 字段点名的门，以及 `covers` 写了 Story 或其祖先 work id 的门；每道门在 `matchedWorkIds` 记下它适用的 Story，`reason` 依次取 `changed`、`work-id`、`work-field` 与 `required` 中最先成立的一项。路径匹配不把门绑定到 Story。字段点名、项目却没有声明的门名列在计划的 `unknownGates` 里。不带 `--work-id` 的计划与从前一样。只在发布时运行的门不会在变更模式中被选中。明确指定 `--release true` 时不要求 Git base，并列出全部启用的门，`matchedWorkIds` 同样记下每道门适用的 Story。

计划按顺序列出选中的门，这也是显示与运行的顺序：有 `order` 的门在前，按顺序从小到大；没有的在后，按名字；顺序相同的几道之间也按名字。没有任何门带顺序时，计划与从前一样按名字排列。

## gates-run：跑门

```text
gates-run [--project <目录>] [--base <提交>] [--work-id <work-id,...>] [--release true] --at <时刻>
```

- 按与 `gates-plan` 相同的方式选门，然后一道接一道地运行，每道门都是它 `root` 里的独立进程，不经过 shell。非 release 必须显式给有效 `--base`；传入的 `--work-id` 会绑定到这次运行并写入结果。
- 退出码为 0 且没有超时的门是绿的，其余都是红的。
- 一道门红了不会中断后面的门；全部跑完之后一次报出所有红门：`reds` 列出全部红门，`requiredReds` 列出其中的必需门。
- 每道门的输出（stdout 与 stderr 按到达顺序）写进文件，超过上限的部分截断。超时的门连同它的整个进程组一起停止，门结束时它留在进程组里的进程也会被停止。
- 每次运行都记在设备目录的 `cache/<库 id>/gate-runs/<运行 id>.json`（`einzbern.gate-run.v1`），并记录目标 Story id、各门匹配的路径与它适用的 Story id，以及运行时那棵树的摘要（`einzbern.gate-tree.v2`）：每个启用门 `root` 的 `HEAD` 提交，加上每个改动文件与未跟踪文件的内容。带 `--work-id` 的运行只计 Story 提交涉及的文件（TCRN-CROSS-STORY-530）：引擎从工单记录取 Story 与它全部 Subtask 的键号（计划的 `subjectKeys`），在 `HEAD` 可达的提交里找说明写了其中一个键号、且键号后面不是数字的提交（`STORY-52` 不算 `STORY-525` 的提交），这些提交涉及的文件才进摘要，运行记录在 `trees[].paths` 列出它们。

## 工单字段 gates 与继承

Initiative、Epic 与 Story 可以在 `gates` 字段里点名自己要过的门（TCRN-CROSS-STORY-525，MIN-256）：`work-create --gates <门名,...>`、`work-annotate --gates <门名,...>`，或 `work-batch` 成员的 `gates` 数组。门名按门声明的规则写：字母、数字、点、冒号、下划线与连字符，以字母或数字开头；不合规的门名拒写（`WORKSPACE_INPUT_INVALID`），其他种类的工单写非空列表也拒写。写入时去重并排序；注解给出的列表整体替换原来的列表，`--gates -`（空列表）清除该字段。字段存为 `required:false` 扩展 `advisory:gates`，不用这个字段的工单与事件字节不变。重放只检查存储形状，不问库里是否声明了这道门。

Story 继承上级：适用于 Story 的点名门是它自己、它的 Epic 与 Initiative 的 `gates` 字段的并集。`work-show` 把工单自己的列表给在 `fields.gates`（工单带这个字段时），把连同祖先的并集给在 `effectiveGates`。点名的门由带 `--work-id` 的计划选中，`reason` 为 `work-field`；项目没有声明的门名列在计划的 `unknownGates`，完成判据报 `WORK_DONE_GATES_NOT_COVERED` 并列出这些门名。被停用的门不适用。

## 完成判据

`work-create --status done`、`work-transition` 或 `work-batch` 让 Story 直接出生为完成或转为完成之前，引擎为每张 Story 读取本设备在当前这棵树、当前这组门声明上记录的、目标 Story 含这张 Story 的最近一次运行，自己不跑门。适用于 Story 的门是：启用的必需门（运行不是发布运行时，不含只在发布时运行的门），Story 或其祖先 `gates` 字段点名的门，以及 `covers` 写了 Story 或其祖先 work id 的门（TCRN-CROSS-STORY-525）。`covers` 不必列出 Story；路径 glob 只选择和运行门，不把门绑定到 Story。

- 项目作用域里没有启用的门：不拦，回执的 `doneGates.reason` 为 `no-gates`。有启用的门、但没有一道适用于这张 Story：不拦，`reason` 为 `no-applicable-gates`。这两种情况都不查项目根。
- `gates` 字段点名了项目没有声明的门：拒绝，报 `WORK_DONE_GATES_NOT_COVERED`，details 的 `gates` 列出这些门名。
- 找不到这样的运行：拒绝，报 `WORK_DONE_GATES_NOT_RUN`，补救是先跑 `gates-run --work-id <Story id>`：非发布运行带 `--base <提交>`，发布运行带 `--release true`。
- 运行里缺一道适用门的结果，或那道门的 `matchedWorkIds` 不含这张 Story：拒绝，报 `WORK_DONE_GATES_NOT_COVERED`，details 的 `gates` 列出缺的门名。
- 有适用门是红的：拒绝，报 `WORK_DONE_GATES_RED`，列出每一道红的适用门（stderr 上还有 `stories` 与 `runId`）。只由路径匹配选中的 optional 门红了不拦。
- 通过的转换在回执的 `doneGates` 里给出放行它的那次运行；几张 Story 由不同的运行放行时，`runIds` 列出全部。

运行必须同树、同门声明，并以 `--work-id` 绑定这张 Story；一次 `--work-id A,B` 的运行可以分别放行 A 与 B。「同树」按运行记下的 `paths` 判断（TCRN-CROSS-STORY-530）：判据在这些文件上重算摘要，与运行记下的摘要比对，从最近的运行往前找第一份对得上的。所以另一个进程在项目里新增无关的未跟踪文件、改别的 Story 的文件，都不影响这次运行；Story 提交涉及的文件运行后又被改，或有了新提交（`HEAD` 变了），就报 `WORK_DONE_GATES_NOT_RUN`。Story 还没提交的新文件不进摘要，运行后再改它们，判据看不到。树或声明一变，之前的运行就不再算数，要按新的 `--base` 或 `--release` 和 `--work-id` 重新 `gates-run`。直接出生、单项转换和批量转换遵守相同拒绝与零写入规则。

门声明与运行都按 Story 所在的项目区分：判据只读 Story 项目作用域里的门声明，只认记录了同一 `projectId` 的运行。所以在项目库上，门要用 `gates-config-set --project-id <Story 的项目>` 声明，带 `--work-id` 的 `gates-run` 也要带同一个 `--project-id`。不带时有两种结果：不带 `--project` 时，只要注册项记着这个项目，命令就以 `GATES_PROJECT_UNKNOWN` 拒绝，不会运行；带 `--project` 时，得到一次 0 道门、`ok` 为 `true`、不记项目的空运行，它不说明门是绿的。两种情况下 Story 转完成时都报 `WORK_DONE_GATES_NOT_RUN`，要等运行带上 `--project-id` 才能转完成。协调库上的 `gates-run` 不必带 `--project-id`：门同样声明在 Story 的项目里，只要其中有启用门适用于这张 Story，`gates-run --work-id <Story id>` 就按 Story 自己的项目在协调库的项目根运行并记下项目（TCRN-CROSS-STORY-519，见「Target boundaries」），之后 `work-transition` 与 `work-batch` 读的就是这次运行；判据与拒绝和项目库相同。

门的顺序只决定何时运行，不决定运行证明了什么，所以不计入门声明的摘要：只改顺序，之前的运行照样算数。改 `command`、`covers`、`required` 等其余字段，之前的运行仍然作废。

## 发布门

发布之前跑全部启用的门，包括只在发布时运行的门：

```text
gates-plan --release true
gates-run --release true --at <时刻>
```

发布计划不看 Git 改动，所以在没有 Git 的目录里也能跑；没有 Git 时，这也是项目唯一能跑的计划。

## 项目从哪里来

`gates-plan`、`gates-run`、`work-transition` 与 `work-batch` 都接受 `--project`。省略时取本机注册表为这个库记录的项目：当前目录解析到这个库、这个项目时取它，否则取注册表里这个库、这个项目唯一的那一项。带 `--project-id`，或按 Story 的项目查找时，只认记录了同一 `projectId` 的注册项；此时给了 `--project`，这个目录所属的注册项也要记着这个项目。门需要项目而注册表里一个也没有时，命令报 `GATES_PROJECT_UNKNOWN`。

协调库例外（TCRN-CROSS-STORY-519）：setup 与迁移为协调库登记的注册项不带 `projectId`，协调库的项目都在它服务的那个目录下。所以在链身份为 coordination 的库上，注册表里没有一项记录所查的项目、而这个项目在库里且未删除时，为这个库登记、不带 `projectId` 的那一项代为回答；这样的项不止一项时用 `--project` 指明其中一项。一旦有注册项记录了这个项目，就只认那一项。项目库（链身份为 project，或没有链身份的库）不变，仍须有记录这个项目的注册项（`library-register --project-id`），否则报 `GATES_PROJECT_UNKNOWN`。

## Target boundaries

A cross-project work item has one execution context per involved concrete
project. Resolve it with `work-project-context` before planning verification.
Gate roots and coverage bindings belong to their target; they are never copied
from coordination or inherited as ordinary common scalar defaults.

For a Cross Project work item, pass its `--work-id` to the existing gate plan or
run command on the coordination library. Each selected target uses its own
registered repository and gate declarations. The response separates successful
and refused targets and includes the effective configuration handed to each
process: the target's `handoff` from `work-project-context`, with the repository
and root the gates run in. A missing or unavailable target is a refused result
of its own; the other targets still run. A target reference does not grant filesystem access. An undecided
relation must be resolved; coordination-only work needs no development target.

A Story that an enabled gate of the coordination library applies to, in the
scope of the Story's project, is planned and run in the coordination library as
well (TCRN-CROSS-STORY-519). A gate applies to a Story when it is required, when
the Story's or an ancestor's `gates` field names it, or when its covers name the
Story or an ancestor (TCRN-CROSS-STORY-525); a release-only gate only for a
release. Such a Story runs in the project root this device registered for
that library, under that project's declarations, one plan or run per project.
The run records the project and the Story ids, so `work-transition` and
`work-batch` read it when the Story goes to done. These results are listed under
`library`, beside `targets`: `projectId`, `workIds`, `projectRoot` and `ok`, with
the `plan`, or the run's `reds`, `requiredReds`, `run` and `recordPath`; a
refused one has its own `reasonCode`. `library` is absent when no gate of the
coordination library applies to any of the given work. Such a Story needs no decided relation
and gets no `PROJECT_SCOPE_UNDECIDED` or `COORDINATION_ONLY` result; a selected
one still runs per target as well, and the coordination library never becomes a
development target. Leave out `--project-id`: each Story runs in its own
project's scope. Given, it must name the project of every covered Story, or the
command refuses with `GATES_PROJECT_MISMATCH` before any gate runs. Work no gate
of the coordination library applies to keeps the results described above.
