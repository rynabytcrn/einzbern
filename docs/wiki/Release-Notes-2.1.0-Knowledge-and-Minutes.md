# Einzbern 2.1.0 发行说明：知识与纪要

[发行说明](Release-Notes.md) › [Einzbern 2.1.0](Release-Notes-2.1.0.md) › 模块 6/8：知识与纪要

上一模块：[并发与设备状态](Release-Notes-2.1.0-Concurrency-and-Device-State.md) · 下一模块：[发行与仓库工具](Release-Notes-2.1.0-Release-and-Repository-Tooling.md)

## The conflict guards of knowledge cards and of minutes now split their conflicts by INIT family

The conflict guards of knowledge cards and of minutes now split their conflicts by INIT family
(TCRN-CROSS-STORY-531, TCRN-CROSS-SUB-485 and TCRN-CROSS-SUB-486, EPIC-149 R4, MIN-256 D6,
MIN-257 D6). A record's family is the Initiative at the top of the parent chain of the work it
names, directly or through the minutes it links. A card written with neither `--supersedes` nor
`--coexist`, whose conflicts are each of a family apart from the new card's, is written beside them:
the card records them in `coexistsWith`, as `--coexist` would, and the receipt lists them under
`warnings` with `KNOWLEDGE_POSSIBLE_CONFLICT`. A conflict of a shared family, or of no known family
on either side, refuses the write with `KNOWLEDGE_POSSIBLE_CONFLICT` as before, naming those under
`conflicts` and the others under `otherFamilyConflicts`. In the same way, `minutes-record` writes a
record beside the close decisions of another family, adding them to its `declarations.coexists` and
warning with `MINUTES_POSSIBLE_CONFLICT`, and refuses with `MINUTES_POSSIBLE_CONFLICT` only for the
decisions of a shared or unknown family. `--supersedes` and `--coexist` behave as before.

---

[返回模块目录](Release-Notes-2.1.0.md) · 上一模块：[并发与设备状态](Release-Notes-2.1.0-Concurrency-and-Device-State.md) · 下一模块：[发行与仓库工具](Release-Notes-2.1.0-Release-and-Repository-Tooling.md)
