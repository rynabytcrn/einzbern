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

门声明由人在 Atelier 的门页里保存和删除（TCRN-CROSS-STORY-513 R1）。环境变量 `EINZBERN_SURFACE` 不为 `atelier` 时，`gates-config-set` 与 `gates-config-remove` 一律拒绝，报 `MODEL_WRITE_REFUSED`，补救提示为 `change it in Atelier`，details 的 `gate` 是门名，库里不追加任何事件。这样模型在工作途中既不能给自己的 Story 声明一道门再自己满足它，也不能放宽或删掉挡住它的门。在 Atelier 里改，或以 `EINZBERN_SURFACE=atelier` 运行同一条命令，照常写入。这是约定，不是身份保证：CLI 分辨不了是谁在运行它，自己带上这个变量的调用同样放行（见「变量」页的模型写保护）。`gates-config-list`、`gates-plan` 与 `gates-run` 不受限。

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

门的顺序只决定何时运行，不决定运行证明了什么，所以不计入门声明的摘要：只改顺序，之前的运行照样算数。改 `command`、`covers`、`required` 等其余字段，之前的运行仍然作废。

## 发布门

发布之前跑全部启用的门，包括只在发布时运行的门：

```text
gates-plan --release true
gates-run --release true --at <时刻>
```

发布计划不看 Git 改动，所以在没有 Git 的目录里也能跑；没有 Git 时，这也是项目唯一能跑的计划。

## 项目从哪里来

`gates-plan`、`gates-run`、`work-transition` 与 `work-batch` 都接受 `--project`。省略时取本机注册表为这个库记录的项目；门需要项目而注册表里一个也没有时，命令报 `GATES_PROJECT_UNKNOWN`。

## Target boundaries

A cross-project work item has one execution context per involved concrete
project. Resolve it with `work-project-context` before planning verification.
Gate roots and coverage bindings belong to their target; they are never copied
from coordination or inherited as ordinary common scalar defaults.
