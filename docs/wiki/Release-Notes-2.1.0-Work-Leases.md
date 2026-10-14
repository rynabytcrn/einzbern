# Einzbern 2.1.0 发行说明：工作租约

[发行说明](Release-Notes.md) › [Einzbern 2.1.0](Release-Notes-2.1.0.md) › 模块 2/8：工作租约

上一模块：[门与完成](Release-Notes-2.1.0-Gates-and-Done.md) · 下一模块：[门与规则提议](Release-Notes-2.1.0-Gate-and-Rule-Proposals.md)

## A Story's transition to done, and every transition and annotation member of a `work-batch`, is now held to the leases before the gates are judged

A Story's transition to done, and every transition and annotation member of a `work-batch`, is now
held to the leases before the gates are judged (TCRN-CROSS-STORY-536, TCRN-CROSS-SUB-471 and
TCRN-CROSS-SUB-472, EPIC-149 R4). While another actor's unexpired lease binds the item,
`work-transition --status done` is refused with `WORK_LEASED` (`holder`, `expiresAt` and
`leasedWorkId` in its details) and no gate is judged; a batch with such a member is refused whole
with `WORK_BATCH_REFUSED`, whose `failed.reasonCode` is `WORK_LEASED`, and nothing is written. A
record that an earlier member of the batch creates is bound by a lease above the parent that member
names. The holder's own transition is judged by the gates as before, and `work-create` stays outside
the lease.

## Those lease checks now parse `--at` first, with the strict instant parser the write uses, and judge no lease when it does not parse

Those lease checks now parse `--at` first, with the strict instant parser the write uses, and judge
no lease when it does not parse (TCRN-CROSS-STORY-536, TCRN-CROSS-SUB-496, EPIC-149 R5). An `--at`
that is not a strict instant is refused by the write with `TIMESTAMP_INVALID`, or answered first by
the gates for a Story going to done, the same way whether the library holds a lease or not; 2.0.3
refused it with `WORK_LEASE_INVALID` in a library that held any lease.

## A deleted work item or project no longer leaves its leases behind

A deleted work item or project no longer leaves its leases behind (TCRN-CROSS-STORY-535,
TCRN-CROSS-SUB-475 and TCRN-CROSS-SUB-476, EPIC-149 R4). `work-delete` removes the item's own lease
in the same append that deletes it, whoever deletes and whether the lease still runs; a refused
delete leaves the lease in place. `project-delete` judges the project's leases at its `--at`: an
expired lease, and a lease on a work item that is deleted or absent (as a delete written by 2.0.3
left it), is removed in the same append, before the project is deleted. A running lease on a live
work item refuses the delete with `WORK_LEASED`, whoever asks, with `workId`, `holder`, `expiresAt`,
`leasedWorkId` and `projectId` in its details, and nothing is written. The CLI entry
`scripts/einzbern.mjs` now prints `projectId` with that refusal (TCRN-CROSS-STORY-535,
TCRN-CROSS-SUB-495, EPIC-149 R5).

---

[返回模块目录](Release-Notes-2.1.0.md) · 上一模块：[门与完成](Release-Notes-2.1.0-Gates-and-Done.md) · 下一模块：[门与规则提议](Release-Notes-2.1.0-Gate-and-Rule-Proposals.md)
