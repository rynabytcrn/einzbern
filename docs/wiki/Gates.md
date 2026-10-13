# 门

门是项目声明的检查命令：测试、类型检查、链接检查，任何以退出码说明好坏的程序都可以。门按项目声明，由改动决定这一次要跑哪几道，没有人手工挑选。Story 转为完成之前，至少一道必需门必须声明它的精确 work id，并在同树、同声明的运行中记录该 id；该次运行里的所有必需门都必须为绿。路径匹配只负责选择和运行门。

## 门声明

一道门是库里 `gate` 集合的一条记录，键就是门的名字，所以每台合并这个库的设备跑的是同一组门。一条声明写明：

| 字段 | 含义 | 新门的缺省值 |
| --- | --- | --- |
| `command` | 要运行的命令，写成 argv 数组，不经过 shell。 | 必填 |
| `root` | 命令在项目的哪个目录里运行；这个目录下的 Git 改动决定是否选中这道门。 | `.` |
| `covers` | 选择门的 `root` 路径 glob，或用于证明 Story 覆盖的精确 `work:<24 位小写十六进制>` 主体 id。 | `**` |
| `required` | Story 转为完成之前是否必须为绿。 | `true` |
| `enabled` | 是否启用。 | `true` |
| `releaseOnly` | 是否只在发布时运行。 | `false` |
| `order` | 可选，正整数：这道门在计划、运行与显示中的位置（TCRN-CROSS-STORY-508 R7）。 | 无 |

路径 glob 相对 `root` 匹配整条路径：`**` 必须独占一段，匹配任意多段；`*`、`?` 与 `[...]` 只在一段之内匹配。`*.md` 是 `root` 下第一层的 Markdown 文件，`**/*.md` 是任意深度的 Markdown 文件，以 `/` 结尾的 glob 覆盖那个目录下的一切。路径匹配会选择并运行门，但当前没有可信的 Story 到路径映射，所以路径匹配本身不能证明任意 Story 已覆盖，release 模式也一样。`work:<24 位小写十六进制>` 是精确主体 id，不作为路径 glob 编译；只有声明包含目标 Story 的精确 id 且运行记录的 `matchedWorkIds` 包含该 id，才能证明 Story 覆盖。

```text
gates-config-set --name <门名> --command '<JSON argv>' [--root <目录>] [--covers <glob-or-work-id,...>] [--required true|false] [--enabled true|false] [--release-only true|false] [--order <正整数>] --at <时刻>
gates-config-list
gates-config-remove --name <门名> --at <时刻>
```

例如 `gates-config-set --name links --command '["pnpm","run","verify:links"]' --root docs --covers '**/*.md' --at <时刻>`。再次声明同一道门时，没有给出的旗标保留原来的值，顺序也一样。`--order` 不是正整数时报 `CLI_ARGUMENT_MALFORMED`。`gates-config-list` 按名字列出声明，带顺序的声明带 `order`。

门声明由人在 Atelier 的门页里保存和删除（TCRN-CROSS-STORY-513 R1）。环境变量 `EINZBERN_SURFACE` 不为 `atelier`、也没有以 `--decided-in` 引用 Owner 决定时，`gates-config-set` 与 `gates-config-remove` 一律拒绝，报 `MODEL_WRITE_REFUSED`，补救提示为 `change it in Atelier, or cite the Owner's decision with --decided-in minutes:<id>#D<n>`，details 的 `gate` 是门名，库里不追加任何事件。这样模型在工作途中既不能给自己的 Story 声明一道门再自己满足它，也不能放宽或删掉挡住它的门。在 Atelier 里改，或以 `EINZBERN_SURFACE=atelier` 运行同一条命令，照常写入。这是约定，不是身份保证：CLI 分辨不了是谁在运行它，自己带上这个变量的调用同样放行（见「变量」页的模型写保护）。`gates-config-list`、`gates-plan` 与 `gates-run` 不受限。

模型也可以引用 Owner 的决定来声明或删除门（TCRN-CROSS-STORY-526）：给这两条命令加 `--decided-in minutes:<id>#D<n>`，`<id>` 是纪要 id（`minutes-show` 读得到；`TCRN-CROSS-MIN-256#D8` 这类外部键号写法不认，报 `malformed`），`<n>` 是决定序号。引擎在写锁内核对这条决定，四条都满足才写入：纪要能找到（先在本库找，本库没有时按本库链身份里的协调库 id，到本设备注册表登记的协调库里只读查找）；这份纪要的 `decidedBy` 含 `owner:governance`；这条决定仍有效（被取代或撤回的不算）；决定正文写出了这道门的门名，前后不紧接字母、数字或 `._:-`，或者写出 `<前缀>.*` 而门名以 `<前缀>.` 开头。核对通过时照常写入，写入的每条事件另记 `decidedIn`（完整的决定编号）、`decidedInLibraryId`（纪要所在库的 id）与 `surface: cli`；核对不通过报 `MODEL_WRITE_AUTHORIZATION_INVALID`，错误带 `decidedIn`、`target` 与 `reason`（`malformed`、`not-found`、`not-owner-decided`、`obsolete`、`target-not-named`，也写在错误文本里），库里不追加任何事件。Atelier 的写入记 `surface: atelier`。引用只让写入可追溯到一条决定，不证明 Owner 真的做了这个决定：模型自己记一份 `decidedBy` 写着 `owner:governance` 的纪要再引用它，同样能通过。

## gates-plan：这次改动要跑哪几道门

```text
gates-plan [--project <目录>] [--base <提交>] [--work-id <work-id,...>] [--release true]
```

非 release 计划必须给有效 Git 提交 `--base`，不会隐式使用 `HEAD`。对每一道可在变更模式运行的启用门，取它 `root` 下相对该提交的改动文件：已提交、已暂存、未暂存、已删除、已改名的文件与未跟踪的文件都算；只要一个改动文件落在路径 glob `covers` 里，这道门就被选中。`--work-id` 可给一个或多个 Story id；精确主体 cover 与路径匹配分别记录，匹配任一项即可选择门。只在发布时运行的门不会在变更模式中被选中。明确指定 `--release true` 时不要求 Git base，并列出全部启用的门。

计划按顺序列出选中的门，这也是显示与运行的顺序：有 `order` 的门在前，按顺序从小到大；没有的在后，按名字；顺序相同的几道之间也按名字。没有任何门带顺序时，计划与从前一样按名字排列。

## gates-run：跑门

```text
gates-run [--project <目录>] [--base <提交>] [--work-id <work-id,...>] [--release true] --at <时刻>
```

- 按与 `gates-plan` 相同的方式选门，然后一道接一道地运行，每道门都是它 `root` 里的独立进程，不经过 shell。非 release 必须显式给有效 `--base`；传入的 `--work-id` 会绑定到这次运行并写入结果。
- 退出码为 0 且没有超时的门是绿的，其余都是红的。
- 一道门红了不会中断后面的门；全部跑完之后一次报出所有红门：`reds` 列出全部红门，`requiredReds` 列出其中的必需门。
- 每道门的输出（stdout 与 stderr 按到达顺序）写进文件，超过上限的部分截断。超时的门连同它的整个进程组一起停止，门结束时它留在进程组里的进程也会被停止。
- 每次运行都记在设备目录的 `cache/<库 id>/gate-runs/<运行 id>.json`（`einzbern.gate-run.v1`），并记录目标 Story id、各门匹配的路径与主体 id，以及运行时那棵树的摘要：每个启用门 `root` 的 `HEAD` 提交，加上每个改动文件与未跟踪文件的内容。

## 完成判据

`work-create --status done`、`work-transition` 或 `work-batch` 让 Story 直接出生为完成或转为完成之前，引擎读取本设备为相同目标 Story、当前这棵树和当前这组门声明记录的最近一次运行，自己不跑门：

- 没有启用的 required 声明包含目标 Story 的精确 work id，或同树同声明的运行没有相应 required 结果并在 `matchedWorkIds` 记录该 id：拒绝，报 `WORK_DONE_GATES_NOT_COVERED`。路径 glob 可选择变更模式要跑的门；release 会跑全部启用门，但任何路径 glob 都不能单独证明 Story 覆盖。空计划、只有 optional 门或不匹配的主体 id 都不算覆盖。
- 找不到这样的运行：拒绝，报 `WORK_DONE_GATES_NOT_RUN`，补救是先跑 `gates-run`。
- 运行里有必需门是红的：拒绝，报 `WORK_DONE_GATES_RED`，列出每一道红的必需门（stderr 上还有 `stories` 与 `runId`）。
- 通过的转换在回执的 `doneGates` 里给出放行它的那次运行。

运行必须同树、同门声明并绑定同一组 Story id；树、声明或目标 Story 组一变，之前的运行就不再算数，要按新的 `--base` 或 `--release` 和 `--work-id` 重新 `gates-run`。直接出生、单项转换和批量转换遵守相同拒绝与零写入规则。

门声明与运行都按 Story 所在的项目区分：判据只读 Story 项目作用域里的门声明，只认记录了同一 `projectId` 的运行。所以在项目库上，门要用 `gates-config-set --project-id <Story 的项目>` 声明，带 `--work-id` 的 `gates-run` 也要带同一个 `--project-id`。不带时有两种结果：不带 `--project` 时，只要注册项记着这个项目，命令就以 `GATES_PROJECT_UNKNOWN` 拒绝，不会运行；带 `--project` 时，得到一次 0 道门、`ok` 为 `true`、不记项目的空运行，它不说明门是绿的。两种情况下 Story 转完成时都报 `WORK_DONE_GATES_NOT_RUN`，要等运行带上 `--project-id` 才能转完成。协调库上的 `gates-run` 不必带 `--project-id`：门同样声明在 Story 的项目里，只要其中有启用门以精确 work id 覆盖这张 Story，`gates-run --work-id <Story id>` 就按 Story 自己的项目在协调库的项目根运行并记下项目（TCRN-CROSS-STORY-519，见「Target boundaries」），之后 `work-transition` 与 `work-batch` 读的就是这次运行；判据与三种拒绝和项目库相同。

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

A Story that the coordination library's own gates cover by exact work id, in
the scope of the Story's project, is planned and run in the coordination library
as well (TCRN-CROSS-STORY-519): in the project root this device registered for
that library, under that project's declarations, one plan or run per project.
The run records the project and the Story ids, so `work-transition` and
`work-batch` read it when the Story goes to done. These results are listed under
`library`, beside `targets`: `projectId`, `workIds`, `projectRoot` and `ok`, with
the `plan`, or the run's `reds`, `requiredReds`, `run` and `recordPath`; a
refused one has its own `reasonCode`. `library` is absent when the coordination
library covers none of the given work. Such a Story needs no decided relation
and gets no `PROJECT_SCOPE_UNDECIDED` or `COORDINATION_ONLY` result; a selected
one still runs per target as well, and the coordination library never becomes a
development target. Leave out `--project-id`: each Story runs in its own
project's scope. Given, it must name the project of every covered Story, or the
command refuses with `GATES_PROJECT_MISMATCH` before any gate runs. Work the
coordination library does not cover keeps the results described above.
