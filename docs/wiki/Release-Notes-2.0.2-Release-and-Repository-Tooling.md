# Einzbern 2.0.2 发行说明：发行与仓库工具

[发行说明](Release-Notes.md) › [Einzbern 2.0.2](Release-Notes-2.0.2.md) › 模块 2/2：发行与仓库工具

上一模块：[受管段、Command Spell 与门](Release-Notes-2.0.2-Managed-Sections-Rules-and-Gates.md)

## The repository root no longer has `AGENTS.md` or `CLAUDE.md`

The repository root no longer has `AGENTS.md` or `CLAUDE.md` (TCRN-CROSS-SUB-442, INIT-053 R52), and
the source archive, which holds what git tracks, no longer carries them. Rules for agents are kept
only in the platform root's `AGENTS.md`; `CONTRIBUTING.md` remains the contributor manual.

## The engine no longer reads the acceptance roster or its verdict file from the platform documents

The engine no longer reads the acceptance roster or its verdict file from the platform documents
(TCRN-CROSS-SUB-373, TCRN-CROSS-SUB-376, INIT-053 R52; STORY-490 R3, STORY-491 R2). Both files move
to the platform documents' archive, and machine-judged work is decided by the gates a project
declares in its library (`gates-config-list`) and the `gates-run` results that cover it
(TCRN-CROSS-STORY-485). `scripts/platform-doctor.mjs` drops its `acceptanceGateGroups` and
`acceptanceVerdicts` legs, so `platform:doctor` no longer reports `PLATFORM_ACCEPTANCE_ROSTER_*`,
`PLATFORM_ACCEPTANCE_VERDICTS_MISSING`, `PLATFORM_ACCEPTANCE_LANE_UNPROVEN` or
`PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED`; the install manifest's `PLATFORM_ACCEPTANCE_PROBE_*`
codes are unchanged. In `scripts/final-gate-plan.mjs` and `scripts/operational-batch-entry.mjs` the
roster is only an explicit input: the CLI refuses a final plan without `--roster <path>` with
`GATE_PLAN_ROSTER_REQUIRED` (a development plan needs none), executing a plan without a roster path
is refused with `GATE_PLAN_ROSTER_UNAVAILABLE` before any root runs, no roster exception is accepted
where no roster is named, and `batch:formal` takes the roster as `rosterPath` in its request and
answers `BATCH_ROSTER_REQUIRED` without one. The policy rule `STORY-COMPLETION-LINKS` now lands on
that done criterion and is also superseded by TCRN-CROSS-MIN-227. `docs/platform-container-layout.md`
is removed with the layout pipeline and is no longer classified under `platform-layout`;
`tests/fixtures/acceptance-gate-groups.json` stays as the explicit roster the planner tests pass.

---

[返回模块目录](Release-Notes-2.0.2.md) · 上一模块：[受管段、Command Spell 与门](Release-Notes-2.0.2-Managed-Sections-Rules-and-Gates.md)
