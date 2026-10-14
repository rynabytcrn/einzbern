# Einzbern 2.1.0 发行说明：门与完成

[发行说明](Release-Notes.md) › [Einzbern 2.1.0](Release-Notes-2.1.0.md) › 模块 1/8：门与完成

下一模块：[工作租约](Release-Notes-2.1.0-Work-Leases.md)

## A run made with `--work-id` now takes its tree digest over the content of the Story's own files

A run made with `--work-id` now takes its tree digest over the content of the Story's own files
(TCRN-CROSS-STORY-534, TCRN-CROSS-SUB-469 and TCRN-CROSS-SUB-470, EPIC-149 R4, MIN-257 D6). It reads
every file that the commits of the Story and its Subtasks touched under a gate root, changed or not,
and records the root with those paths and a content digest for each file, without `HEAD` and without
a change list (`einzbern.gate-tree.v3`). A root that none of those commits touched is recorded with
its `HEAD` and every change, as in a run without `--work-id`, and so is every root when the commits
touched none. So a commit or a file elsewhere in the project, another session's among them, no
longer stales the run, and the Story goes to done without its gates running again. The done check
reads the recorded files again and compares their digests, and compares the files the Story's
commits touch now with the paths the run recorded: a change to one of the Story's files, committed
or not, or a new commit of the Story's that touches another file, refuses done with
`WORK_DONE_GATES_NOT_RUN`, whose details now carry `changedPaths` and `addedPaths`. Putting back the
content the run read brings the run back. A run without `--work-id`, a release run among them,
records the same shape as before.

## `gates-run` now hands every gate process `EINZBERN_GATE_RUN_PRIOR`

`gates-run` now hands every gate process `EINZBERN_GATE_RUN_PRIOR` (TCRN-CROSS-STORY-537,
TCRN-CROSS-SUB-487, EPIC-149 R4, MIN-257 D6): canonical JSON with the run id and, in run order, each
gate of the same run that ended before the gate started, with its name, its declared root, the real
directory it ran in, its command, whether it passed, whether its output was cut, and the absolute
path of its output file. The first gate reads an empty list. The engine's value replaces a variable
of the same name in the caller's environment, and it is not written to the run record.

---

[返回模块目录](Release-Notes-2.1.0.md) · 下一模块：[工作租约](Release-Notes-2.1.0-Work-Leases.md)
