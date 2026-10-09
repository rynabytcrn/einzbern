# Einzbern 2.0.1 发行说明：跨项目协作

[发行说明](Release-Notes.md) › [Einzbern 2.0.1](Release-Notes-2.0.1.md) › 模块 1/4：跨项目协作

下一模块：[Atelier](Release-Notes-2.0.1-Atelier.md)

## A coordination library's Stories can reach done through their gates

A coordination library's Stories can reach done through their gates (TCRN-CROSS-STORY-519, INIT-053
R50; fixes TCRN-CROSS-STORY-485). On a coordination chain, `gates-plan` and `gates-run` with
`--work-id` also plan and run a Story that an enabled gate of the library's own project scope covers
by exact work id: in the project root registered for the library, under that project's declarations,
one plan or run per project, recording the project and the Story ids, so `work-transition` and
`work-batch` read that run at done. These results are listed under a new `library` field beside
`targets`, which keeps its shape; a covered Story gets no `PROJECT_SCOPE_UNDECIDED` or
`COORDINATION_ONLY` result, a selected one still runs per target, and uncovered work answers as
before. `--project-id` may be left out; given, it must name the project of every covered Story, or
the command refuses with `GATES_PROJECT_MISMATCH` before any gate runs. The gate root of a
coordination library's project, for these runs, for plans and runs with `--project-id` and for the
done check, now comes from the library's registry entry even when that entry records no project, as
setup and migration write it, as long as no entry records the project itself; a project chain still
needs an entry for the project, or the root is `GATES_PROJECT_UNKNOWN`. The done criteria and their
refusals are unchanged.

---

[返回模块目录](Release-Notes-2.0.1.md) · 下一模块：[Atelier](Release-Notes-2.0.1-Atelier.md)
