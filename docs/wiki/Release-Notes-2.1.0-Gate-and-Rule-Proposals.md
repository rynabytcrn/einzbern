# Einzbern 2.1.0 发行说明：门与规则提议

[发行说明](Release-Notes.md) › [Einzbern 2.1.0](Release-Notes-2.1.0.md) › 模块 3/8：门与规则提议

上一模块：[工作租约](Release-Notes-2.1.0-Work-Leases.md) · 下一模块：[Atelier](Release-Notes-2.1.0-Atelier.md)

## A model can now propose a gate or rule change that Atelier settles, instead of being refused

A model can now propose a gate or rule change that Atelier settles, instead of being refused
(TCRN-CROSS-STORY-527, TCRN-CROSS-SUB-477 and TCRN-CROSS-SUB-478, EPIC-149 R4, MIN-257 D6).
`gates-config-propose` proposes a gate declaration or removal, and `rule-propose` a rule's enable or
disable; neither is refused to a model, and both record `--actor` as the proposer. The proposal is
stored in the new closed `proposal` collection, keyed `gate:<name>` or `rule:<id>`, outside the
declarations: a pending proposal is not planned, enabled, rendered or projected into
`config/project.json`, and proposing again replaces it. `proposal-approve` and `proposal-reject`
settle a proposal by `--key` and the `--proposed-at` they read, and run for Atelier only, otherwise
`MODEL_WRITE_REFUSED` with nothing appended. An approval appends, in one append, the configuration
event the direct write appends and the proposal's removal, recorded with `surface: atelier`,
`decidedInLibraryId` naming this library and `decidedIn` in the new form
`proposal:<key>@<proposed-at>`; a rule's approval writes `AGENTS.md` in the `--project` directory,
or in the one this device registered. A rejection keeps the record as rejected.
`PROPOSAL_NOT_FOUND`, `PROPOSAL_NOT_PENDING` and `PROPOSAL_STALE` refuse an approval or rejection
that cannot settle what it read. `gates-config-list` and `rule-list` take
`--status declared|pending|rejected`; `declared`, the default, lists what they listed before.

---

[返回模块目录](Release-Notes-2.1.0.md) · 上一模块：[工作租约](Release-Notes-2.1.0-Work-Leases.md) · 下一模块：[Atelier](Release-Notes-2.1.0-Atelier.md)
