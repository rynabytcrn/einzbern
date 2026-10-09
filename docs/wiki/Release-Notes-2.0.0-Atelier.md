# Einzbern 2.0.0 发行说明：Atelier

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 9/13：Atelier

上一模块：[跨项目协作](Release-Notes-2.0.0-Cross-Project.md) · 下一模块：[安装与引擎版本](Release-Notes-2.0.0-Installation-and-Engine-Versions.md)

## Atelier's gate page says what a cover is

Atelier's gate page says what a cover is (TCRN-CROSS-STORY-513 R2, TCRN-CROSS-SUB-423; fixes
TCRN-CROSS-STORY-485; `portal/locales.js`, `portal/index.html`). The label of the cover input on the
add form, the heading of the cover column in the gate table, the column's add button and the name of
the remove button beside each cover read, in all five languages, that a cover is a path glob or a
work id, the two forms `gates-config-set --covers` accepts; they used to say that covers were paths.
The page's own text for the label and the heading, shown before a language applies, is the English
copy. The input still takes one cover per line, and the covers the page writes, the gate records and
the reason codes are unchanged.

## Atelier's work tab says that it is reading

Atelier's work tab says that it is reading (TCRN-CROSS-STORY-513 R3, TCRN-CROSS-SUB-424; fixes
TCRN-CROSS-STORY-510; `portal/index.html`, `portal/locales.js`). While the work view's read of the
selected library is out, a status line above the work tree reads, in the page's language, that the
work records are being read through the engine (`dashboard.workLoading`, one key in each of the five
languages); it goes when the read returns and the list shows. The work tree keeps its `aria-busy`, the
view still keeps what it showed until a refresh's read returns, a read that failed is still shown in
the work view alone, and no other view waits for the work read. <code>&#47;api/work</code>, its pages and its result
are unchanged.

## Atelier edits a work item's involved projects, filters by them and shows each target's readiness

Atelier (TCRN-CROSS-INIT-053 R43 to R45) edits a work item's involved projects, filters by them and
shows each target's readiness, and sets a project's common default and repository bindings. Its
release package carries the registry lock and device directory modules once, behind a guard. Every
list names a target by one rule: the project's own name, "Unnamed project" only for a project
without one, and the shortest id tails where two read alike, never a full id in a visible label; the
complete identities are in a keyboard-operable disclosure with a copy action. Project readiness
lists, per target, its status, whether it is ready for development, what it still misses and the
settings whose values differ. The work view reads the work list once per refresh by its own read;
the side navigation collapses to a rail with the published control and keeps the choice; and the
shell's type, page width and brand mark follow the published family. Writes bind the selection's
epoch, library and project, and a switch is refused while a target write is in flight.

## Atelier shows each project's own name in its lists, switcher, rail and top bar

Atelier (TCRN-CROSS-INIT-053 R46) shows each project's own name in its lists, switcher, rail and top
bar; one chain's project registered for two repositories is told apart by the repositories'
directory names, and the Rules page names the repository it edits. A target whose common default
cannot be read marks the rows it would set "Inherited defaults unavailable", with no value, and
offers to choose another project or stop inheriting; a library without a knowledge store says "No
knowledge yet". A switch clears what belonged to the old target, an answer for a target the page no
longer shows is dropped, and when another tab moves the selection the page says where it went and
offers to switch back or to view it. A child work item's projects stay within its parent's scope,
and a refused save shows the engine's reason code, its own words and how to recover; on a
coordination chain the model tables are read only and say why. Readiness lists each target's value
and source for every setting that differs and shows "Not ready" with the neutral badge, and the work
tree lists each Story's Subtasks with their projects. Every language uses the published UI type
family. The gate, model and variable tables fit a 1024 px desktop without sideways scrolling: the
gate table has three columns, a gate's switches sit in its own cell, and a cover input shows a whole
work id.

## Atelier consumes the design system at `d53f2305`

Atelier consumes the design system at `d53f2305` (TCRN-CROSS-INIT-053 R46 and R47): its record
component family, its documentation stories and a static Clipboard bridge that Atelier can use;
Atelier does not use the bridge yet (post-MVP backlog item BL-04).

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[跨项目协作](Release-Notes-2.0.0-Cross-Project.md) · 下一模块：[安装与引擎版本](Release-Notes-2.0.0-Installation-and-Engine-Versions.md)
