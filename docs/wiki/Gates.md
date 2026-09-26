# 门

门是项目声明的检查命令：测试、类型检查、链接检查，任何以退出码说明好坏的程序都可以。门按项目声明，由改动决定这一次要跑哪几道，没有人手工挑选。Story 转为完成之前，它的改动涉及的必需门必须是绿的。

## 门声明

一道门是库里 `gate` 集合的一条记录，键就是门的名字，所以每台合并这个库的设备跑的是同一组门。一条声明写明：

| 字段 | 含义 | 新门的缺省值 |
| --- | --- | --- |
| `command` | 要运行的命令，写成 argv 数组，不经过 shell。 | 必填 |
| `root` | 命令在项目的哪个目录里运行；这个目录下的 Git 改动决定是否选中这道门。 | `.` |
| `covers` | 这道门覆盖 `root` 之下的哪些路径，写成 glob 列表。 | `**` |
| `required` | Story 转为完成之前是否必须为绿。 | `true` |
| `enabled` | 是否启用。 | `true` |
| `releaseOnly` | 是否只在发布时运行。 | `false` |

glob 相对 `root` 匹配整条路径：`**` 必须独占一段，匹配任意多段；`*`、`?` 与 `[...]` 只在一段之内匹配。`*.md` 是 `root` 下第一层的 Markdown 文件，`**/*.md` 是任意深度的 Markdown 文件，以 `/` 结尾的 glob 覆盖那个目录下的一切。

```text
gates-config-set --name <门名> --command '<JSON argv>' [--root <目录>] [--covers <glob,glob>] [--required true|false] [--enabled true|false] [--release-only true|false] --at <时刻>
gates-config-list
gates-config-remove --name <门名> --at <时刻>
```

例如 `gates-config-set --name links --command '["pnpm","run","verify:links"]' --root docs --covers '**/*.md' --at <时刻>`。再次声明同一道门时，没有给出的旗标保留原来的值。

## gates-plan：这次改动要跑哪几道门

```text
gates-plan [--project <目录>] [--base <提交>] [--release true]
```

对每一道启用的门，取它 `root` 下相对 `--base`（缺省为 `HEAD`）的改动文件：已暂存、未暂存、已删除、已改名的文件与未跟踪的文件都算。只要有一个改动文件落在 `covers` 里，这道门就被选中。只在发布时运行的门不会被选中。一次已经提交的改动，相对 `HEAD` 没有可跑的，这时用 `--base` 指向它的分叉点。

## gates-run：跑门

```text
gates-run [--project <目录>] [--base <提交>] [--release true] --at <时刻>
```

- 按与 `gates-plan` 相同的方式选门，然后一道接一道地运行，每道门都是它 `root` 里的独立进程，不经过 shell。
- 退出码为 0 且没有超时的门是绿的，其余都是红的。
- 一道门红了不会中断后面的门；全部跑完之后一次报出所有红门：`reds` 列出全部红门，`requiredReds` 列出其中的必需门。
- 每道门的输出（stdout 与 stderr 按到达顺序）写进文件，超过上限的部分截断。超时的门连同它的整个进程组一起停止，门结束时它留在进程组里的进程也会被停止。
- 每次运行都记在设备目录的 `cache/<库 id>/gate-runs/<运行 id>.json`（`einzbern.gate-run.v1`），同时记下运行时那棵树的摘要：每个启用门 `root` 的 `HEAD` 提交，加上每个改动文件与未跟踪文件的内容。

## 完成判据

`work-transition` 或 `work-batch` 把 Story 转为完成之前，引擎读取本设备在当前这棵树、当前这组门声明下最近的一次运行，自己不跑门：

- 项目没有任何启用的门：放行。
- 找不到这样的运行：拒绝，报 `WORK_DONE_GATES_NOT_RUN`，补救是先跑 `gates-run`。
- 运行里有必需门是红的：拒绝，报 `WORK_DONE_GATES_RED`，列出每一道红的必需门（stderr 上还有 `stories` 与 `runId`）。
- 通过的转换在回执的 `doneGates` 里给出放行它的那次运行。

树一变（改了文件、换了提交），之前的运行就不再算数，要重新 `gates-run`。

## 发布门

发布之前跑全部启用的门，包括只在发布时运行的门：

```text
gates-plan --release true
gates-run --release true --at <时刻>
```

发布计划不看 Git 改动，所以在没有 Git 的目录里也能跑；没有 Git 时，这也是项目唯一能跑的计划。

## 项目从哪里来

`gates-plan`、`gates-run`、`work-transition` 与 `work-batch` 都接受 `--project`。省略时取本机注册表为这个库记录的项目；门需要项目而注册表里一个也没有时，命令报 `GATES_PROJECT_UNKNOWN`。
