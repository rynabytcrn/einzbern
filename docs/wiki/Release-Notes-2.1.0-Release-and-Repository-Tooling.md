# Einzbern 2.1.0 发行说明：发行与仓库工具

[发行说明](Release-Notes.md) › [Einzbern 2.1.0](Release-Notes-2.1.0.md) › 模块 7/8：发行与仓库工具

上一模块：[知识与纪要](Release-Notes-2.1.0-Knowledge-and-Minutes.md) · 下一模块：[从 2.0.3 升级](Release-Notes-2.1.0-Upgrading-from-2.0.3.md)

## Inside `gates-run --release`, the push gate now leaves `verify:p1` out when the same gate run has already passed every P1 leg

Inside `gates-run --release`, the push gate (`engine:release`) now leaves `verify:p1` out when the
same gate run has already passed every P1 leg (TCRN-CROSS-STORY-537, TCRN-CROSS-SUB-488,
EPIC-149 R4, MIN-252 D3, MIN-257 D6). It reads `EINZBERN_GATE_RUN_PRIOR`, and only when every leg of
`scripts/p1-sequence.mjs` has a gate in that run that is named for the leg, ran in this repository,
ran exactly the leg's package script through pnpm, passed, kept its whole output, printed exactly
one terminal receipt of the leg and printed nothing P1's zero-warning rule rejects, does its receipt
record the `verify:p1` child as `notStarted`, with `coveredBy` naming the run and each leg's gate,
output file and digest, and the assessment `P1_COVERED_BY_GATE_RUN`. Otherwise `verify:p1` runs in
full, and when a run was handed but did not carry every leg, its entry gains `p1Coverage`, saying
which legs fell short and why. Run on its own, the push gate runs `verify:p1` in full as before.

## The release policy now says that, from the first release after 2.0.3, a change to a format version or to the shape of an event raises the minor version and is not released as a patch

The release policy now says that, from the first release after 2.0.3, a change to a format version
or to the shape of an event raises the minor version and is not released as a patch
(TCRN-CROSS-STORY-537, TCRN-CROSS-SUB-489, EPIC-149 R4, MIN-257 D3). This release is 2.1.0 under
that rule.

## The portal's Design System reconciliation and the DS component CSS snapshot generator now read `Navigation.tsx` from the candidate commit that `portal/ds-consumer-contract.json` binds, in the git objects of the Design System root, never from that checkout's working tree

The portal's Design System reconciliation and the DS component CSS snapshot generator now read
`Navigation.tsx` from the candidate commit that `portal/ds-consumer-contract.json` binds, in the git
objects of the Design System root, never from that checkout's working tree (TCRN-CROSS-STORY-533,
TCRN-CROSS-SUB-473 and TCRN-CROSS-SUB-474, EPIC-149 R4). An unpublished change in the sibling
checkout no longer turns the portal gate red. When the candidate cannot be read or has no usable
export, the reconciliation records the observation `DS_COMPONENT_CSS_SOURCE_UNRECONCILED` with its
reason (`not-a-repository`, `candidate-absent`, `tree-mismatch`, `export-not-found` or
`export-has-interpolation`), and its verdict still compares only the inline copy with the snapshot;
the generator refuses with `DS_COMPONENT_CSS_SOURCE_UNAVAILABLE` and the reason before it writes
anything, so the snapshot keeps its bytes.

---

[返回模块目录](Release-Notes-2.1.0.md) · 上一模块：[知识与纪要](Release-Notes-2.1.0-Knowledge-and-Minutes.md) · 下一模块：[从 2.0.3 升级](Release-Notes-2.1.0-Upgrading-from-2.0.3.md)
