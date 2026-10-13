# Einzbern 2.0.3 发行说明：门与完成

[发行说明](Release-Notes.md) › [Einzbern 2.0.3](Release-Notes-2.0.3.md) › 模块 1/7：门与完成

下一模块：[配置写入与 Owner 决定](Release-Notes-2.0.3-Configuration-Writes-and-Owner-Decisions.md)

## A Story reaches done on the gates that apply to it, and a gate no longer has to list the Story in its `covers`

A Story reaches done on the gates that apply to it, and a gate no longer has to list the Story in
its `covers` (TCRN-CROSS-STORY-525, TCRN-CROSS-SUB-446 to TCRN-CROSS-SUB-449, EPIC-149 R1, MIN-256).
Every enabled required gate now applies to every Story in the library by default (a release-only
gate only in a release run); so does a gate that the Story's own `gates` field or an ancestor's
names, and a gate whose `covers` names the Story or an ancestor. Initiatives, Epics and Stories take
the new `gates` field through `work-create --gates`, `work-annotate --gates` (`--gates -` removes
it) and a `work-batch` member's `gates`, and the field is inherited downward: a Story is held to the
names of its own field, its Epic's and its Initiative's. `work-show` reports the record's own list
as `fields.gates` and the union as `effectiveGates`; a name the project does not declare is listed
in the plan's `unknownGates` and refused at done with `WORK_DONE_GATES_NOT_COVERED`. `covers`
accepts `work:<id>` of an Initiative or an Epic as well as of a Story, and the gate then applies to
every Story below it. Done is decided by the latest run with a `--work-id` that includes the Story,
on the current tree and the current gate declarations, with every applicable gate green: without
such a run the transition is refused with `WORK_DONE_GATES_NOT_RUN`, a missing applicable result
with `WORK_DONE_GATES_NOT_COVERED`, and a red one with `WORK_DONE_GATES_RED`. `docs/wiki/Gates.md`
describes the criterion and the field.

## The tree digest of a gate run is now `einzbern.gate-tree.v2`

The tree digest of a gate run is now `einzbern.gate-tree.v2` (TCRN-CROSS-STORY-530,
TCRN-CROSS-SUB-450, EPIC-149 R1). A run with `--work-id` counts only the paths under the gate roots
that the Story's commits touched: the commits reachable from `HEAD` whose message names the key of
the Story or of one of its Subtasks, not followed by a digit. The run lists those paths in
`trees[].paths`, and the done check recomputes the digest over them, so an unrelated untracked file
or another Story's change no longer stales the run, while a later change to one of those paths or a
new commit does.

---

[返回模块目录](Release-Notes-2.0.3.md) · 下一模块：[配置写入与 Owner 决定](Release-Notes-2.0.3-Configuration-Writes-and-Owner-Decisions.md)
