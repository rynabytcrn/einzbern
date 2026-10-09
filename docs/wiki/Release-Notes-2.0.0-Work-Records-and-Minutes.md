# Einzbern 2.0.0 发行说明：工作记录、纪要与决策

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 3/13：工作记录、纪要与决策

上一模块：[库与设备](Release-Notes-2.0.0-Libraries-and-Devices.md) · 下一模块：[召回与钩子](Release-Notes-2.0.0-Recall-and-the-Hook.md)

## An Incident is a Story now

An Incident is a Story now (TCRN-CROSS-STORY-472; MIN-227 D6; `packages/core/src/work-relations.ts`):
a new record is an Initiative, Epic, Story or Subtask, and `work-create --kind Incident` or
`Release` (and a batch member of either kind) is refused with `WORK_KIND_RETIRED` and a remedy
(`details.remedy`: open a Story with a fixes relation). Every Incident and Release already on a
chain still replays, reads, transitions and can be the target of a relation; `work-list --kind`
still filters by both. Relations between work records are fields from a closed vocabulary:
parent (the record's parent), blocked-by, implements, supersedes, fixes and decided-in. A record
stores its forward relations only, blocked-by, implements, supersedes and fixes in the
required:false extension `advisory:relations` (each a sorted list of at most 64 work ids) and
decided-in as its `advisory:decided-by` minutes list, and the engine projects the reverse
(blocks, implemented-by, superseded-by, fixed-by, decides) when the record is read; the reverse
is never an event field. `work-create` and `work-annotate` take `--blocked-by`, `--implements`,
`--supersedes`, `--fixes` and `--decided-in` (`--decided-by` is its older name); a write refuses a
target that is not a live work record, the record itself or an unknown relation, and an
annotation replaces each list it names whole (`-` removes one). Replay checks only the shape of a
stored value, so an old chain or a merge naming a record this device has not seen still reads.
`work-show` returns `relations {forward, reverse, missing}` (missing: forward targets the library
no longer holds as live records), `work-list --relation <name>=<id>` filters by a forward or a
reverse name, and a `work-batch` member carries `relations {blockedBy, implements, supersedes,
fixes, decidedIn}`.

## A Story is its goal, its acceptance and a free body

A Story is its goal, its acceptance and a free body (TCRN-CROSS-STORY-473; MIN-227 D8;
`packages/core/src/story-fields.ts`): the engine checks that a Story has a goal and an acceptance
and nothing else about its prose. They are the required:false extensions `advisory:goal`,
`advisory:acceptance` and `advisory:body`, written with `work-create` and `work-annotate --goal`,
`--acceptance` and `--body`, or as the `goal`, `acceptance` and `body` of a `work-batch` member. A
Story created with `--scope` alone still works: its goal and acceptance come from the scope's Goal
and Acceptance Criteria blocks, and the other blocks are its body. Every Story already on a chain
keeps its scope byte for byte and is mapped the same way whenever it is read; nothing is migrated.
A Story with no goal or no acceptance is refused with `WORK_STORY_FIELD_REQUIRED` (`details.field`
names which, `details.remedy` how to give it; the shipped entry prints both), on creation and on
an annotation that rewrites its goal, acceptance or scope, while an annotation that touches none
of them (a title, a summary, a relation) stays open to every Story; a batch member without either
fails the shape rule `story-fields-required`. The summary defaults to the first sentence of the
goal, and the rule that an Owner-decided Story needs its deciding minutes before done reads the
goal. The ten-block contract is gone with its reason codes (`WORKSPACE_STORY_SCOPE_REQUIRED`,
`WORKSPACE_STORY_SCOPE_INVALID`, `STORY_SCOPE_PURPOSE_INVALID`,
`STORY_SCOPE_LEGACY_ELEMENT_MISSING`) and `scripts/story-scope-compliance.mjs`; the template floor,
which alone still checks headings, reports `TEMPLATE_SCOPE_*`, and a Story bound to a template is
no longer judged by the template's headings. `work-show` returns `fields {goal, acceptance, body,
source}` (source: `fields`, `scope` or `none`); `work-list` gives each record `fields.source`, and
with `--search` it also matches the three texts and returns each as an excerpt bounded by
`--scope-bytes`, as it does the scope. `work-draft` still prints the ten-block skeleton, now marked
`optional: true` with the note `仅供参考，引擎只校验 goal 与 acceptance` and `requiredFields`, and its
examples include Stories written with fields. The governed-loop tutorial creates its Story with
`--goal` and `--acceptance`.

## Minutes replace the conference

Minutes replace the conference (TCRN-CROSS-STORY-475; MIN-227 D9, D10; `packages/core/src/minutes.ts`,
`specs/minutes-v1.md`). `minutes-record --project-id --title --summary` with `--decisions <list>`
or `--decisions-file <JSON array of strings>`, `--decided-by`, `--work-ids` and an optional
`--external-key` writes a decision down in one `minutes.recorded` event and answers
`MINUTES_RECORDED` with the minutes `id`, its `externalKey` and the decisions numbered D1 to Dn
(`decisions [{number, text}]`); without a key it takes the next number after the latest one
recorded, and a library's first minutes must name theirs (`MINUTES_EXTERNAL_KEY_REQUIRED`).
`minutes-list` (`--project-id`, `--work-id`, `--limit`, `--offset`) pages every minutes record,
the ones a conference close wrote included (kind `conference-minutes`, titled by their
conference, with no external key), and `minutes-show --id | --external-key` returns one with
`decides`, the work records that name it as decided-in; both read an old-layout workspace too.
`work-create` and `work-annotate --decided-in` name a minutes id. Every conference verb is
retired and answers `CLI_COMMAND_UNKNOWN`: conference-open, conference-append-position,
conference-close (with `--execution-form` and `--distill`), conference-cancel,
conference-list-by-work, conference-minutes-list and conference-position-list, and with them the
settings `execution.independenceFloor` and `conference.positionBudgetBytes`. Every conference
event already on a chain still replays. The governed-loop tutorial and its proof record minutes
and name them with decided-in instead of holding, distilling and promoting a conference.

## Each decision is valid or obsolete on its own, and a card that repeats a work record or a valid decision is refused

Each decision is valid or obsolete on its own, and a card that repeats a work record or a valid
decision is refused (TCRN-CROSS-STORY-514 R2 to R5, TCRN-CROSS-SUB-426; MIN-239 D3, D5, D6;
`packages/core/src/minutes.ts`, `packages/core/src/knowledge-duplicates.ts`, `specs/minutes-v1.md`).
A decision's number is `minutes:<id>#D<n>`, the historical minutes' decisions included. A decision
becomes obsolete only in the write that records the minutes saying so: `minutes-record` takes
`--supersedes <decision>=<successor>` (the successor one of the record's own decisions, `D<n>`, or
a valid decision already recorded), `--withdraws <decision>` (obsolete with no successor) and
`--coexists <decision>` (a valid decision close in topic that stays valid beside it), each decision
a number or `<external key>#D<n>`, and the record stores them as its optional `declarations`
field, which its receipt echoes. Obsolete is final: declaring an obsolete decision obsolete again,
or naming one as a successor or to stand beside, is `MINUTES_DECISION_OBSOLETE`; a decision the
library does not hold is `MINUTES_NOT_FOUND`; replay checks every declaration, and of two devices
that superseded one decision apart the record merged second is the rejected event. A decision close
in topic (a weighted cosine of recall's tokens of at least 0.5, sharing three or more) to a valid
decision the declarations leave unsettled is refused with `MINUTES_POSSIBLE_CONFLICT`, naming the
candidates under `conflicts`. `minutes-list` and `minutes-show` give the valid decisions unless
`--status obsolete|all` asks otherwise: a record with no valid decision is left out of the list,
and one with obsolete decisions names their numbers under `withheldDecisions`; in an explicit read
each decision has `status`, and an obsolete one `supersededBy` (the successor's number, text and
status, null when withdrawn) and `declaredIn`, while a valid one lists what it `supersedes`.
`minutes-show --id minutes:<id>#D<n>` (or `--external-key <key>#D<n>`) reads that decision whatever
its state. Recall indexes only valid decisions (a minutes hit's lead keeps the decision's own
number) unless `recall --status` names a decision status, which it reads as `minutes-list` does:
`obsolete` the obsolete decisions alone, each minutes hit carrying its own under
`obsoleteDecisions` with its successor or null, and `all` every decision; `removed`, a card status,
leaves the decisions valid, and the prompt hook takes no status and indexes valid decisions only.
`work-show` and a recall hit answer `obsoleteDecisions [{decision, supersededBy}]` when the
record's decided-in minutes, or a card's referenced minutes or named decisions, hold an obsolete
decision, and the hit's line adds `过时决策 <decision>→<successor>`.
No minutes verb is added. Before a card is written, knowledge-create, knowledge-batch,
knowledge-capture and an article's index card compare it with every live work record and every
valid decision; a card whose words one of them carries for at least half their weight (eight or
more shared) is refused with `KNOWLEDGE_ALREADY_RECORDED`, naming the record under `target` and
where its content belongs under `remedy`, and nothing is written. A record without declarations,
and every read of a library with no obsolete decision, answers exactly as before.

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[库与设备](Release-Notes-2.0.0-Libraries-and-Devices.md) · 下一模块：[召回与钩子](Release-Notes-2.0.0-Recall-and-the-Hook.md)
