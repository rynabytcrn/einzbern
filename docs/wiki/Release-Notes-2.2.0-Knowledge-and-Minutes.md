# Einzbern 2.2.0 发行说明：知识与纪要

[发行说明](Release-Notes.md) › [Einzbern 2.2.0](Release-Notes-2.2.0.md) › 模块 2/9：知识与纪要

上一模块：[并发与设备状态](Release-Notes-2.2.0-Concurrency-and-Device-State.md) · 下一模块：[受管段、Command Spell 与变量](Release-Notes-2.2.0-Managed-Sections-Rules-and-Variables.md)

## The INIT family of a record is now also read from a reference that is the whole external key of a work record this library holds, and from a card's linked work, in the knowledge card guard and in the `minutes-record` guard alike

The INIT family of a record is now also read from a reference that is the whole external key of a
work record this library holds, and from a card's linked work, in the knowledge card guard and in
the `minutes-record` guard alike (TCRN-CROSS-STORY-539, TCRN-CROSS-SUB-503, EPIC-150 R7, MIN-256 D6,
MIN-258 D1). A key the library holds no work under names no family, as a file or a URL does.

## Reads now set aside an unresolved pair of cards whose INIT families are both known and differ

Reads now set aside an unresolved pair of cards whose INIT families are both known and differ
(TCRN-CROSS-STORY-539, TCRN-CROSS-SUB-504, EPIC-150 R7): `knowledge-list` neither names such a pair
nor withholds its cards from default selection, and recall and a checkpoint follow. The crest scan
and its cache still find every pair, and a pair of one family, or of no known family, stands as
before. The knowledge hint leaves out the cards of a family apart from its target's and says how
many: its line ends with that count, and the receipts of `work-transition`, `work-batch` and
`minutes-record` carry it as `filteredByFamily`. A target of no known family keeps every card. The
minutes spec's topic comparison and the governed-loop tutorial describe the split and the count
(TCRN-CROSS-SUB-520, EPIC-150 R8).

---

[返回模块目录](Release-Notes-2.2.0.md) · 上一模块：[并发与设备状态](Release-Notes-2.2.0-Concurrency-and-Device-State.md) · 下一模块：[受管段、Command Spell 与变量](Release-Notes-2.2.0-Managed-Sections-Rules-and-Variables.md)
