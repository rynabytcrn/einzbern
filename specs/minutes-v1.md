# Minutes V1

## Status and scope

`einzbern.minutes.v1` records a decision in one write (TCRN-CROSS-STORY-475 R1,
MIN-227 D9, D10). A conference took an open, a position per participant and a
close; a minutes record carries the whole outcome at once and is never edited:
it is written with `revision` 1 and is not a tombstone. The schema is
`schemas/minutes-v1.schema.json`; the engine module is
`packages/core/src/minutes.ts`.

Each decision is valid or obsolete on its own (TCRN-CROSS-SUB-426, MIN-239 D3,
D5, D6). A decision becomes obsolete only when minutes are recorded that say
so, in the same write; obsolete is final, and a decision judged wrongly is
corrected by a new decision.

## Record

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `einzbern.minutes.v1` |
| `externalKey` | the record's key, canonical (upper case), such as `TCRN-CROSS-MIN-233` |
| `id` | `deriveStableId("minutes", externalKey)`; replay refuses any other value |
| `projectId` | a live project |
| `title` | non-empty complete text within the executing runtime |
| `summary` | non-empty complete text within the executing runtime |
| `decisions` | one or more entries of complete non-empty text |
| `decidedBy` | the participants who decided: a complete collection of protocol ids, without repeats |
| `linkedWorkIds` | a complete collection of live work ids of the same project, without repeats |
| `recordedAt` | the strict instant of the event that wrote it |
| `revision` | 1 |
| `tombstone` | false |
| `declarations` | present only when the record declares something about decisions already recorded (see Declarations) |

The field set is closed. A record that fails any rule is refused on the write
path with `MINUTES_RECORD_INVALID`, and replay reads the same event as
`WORKSPACE_EVENT_CORRUPT`.

## Decision numbers

Decision *n* of a record is `Dn`, its index in `decisions` plus one. Its
number, the stable way to name one decision anywhere, is the minutes id and
`#Dn`: `minutes:<id>#D3`. The minutes a conference close wrote are numbered
the same way, with their own ids. A writer may also name a decision of minutes
recorded with a key as `<external key>#Dn` (`TCRN-CROSS-MIN-239#D3`), which the
engine turns into the number. A work record names the minutes it was decided in
with the `decided-in` relation (the `advisory:decided-by` list of minutes ids,
work-model-v1).

## States

A decision is `valid` or `obsolete`. An obsolete decision was either
superseded, and names the decision that superseded it, or withdrawn, and names
none. Both directions are read: the superseding decision lists what it
superseded (`supersedes`), and the obsolete one names its successor
(`supersededBy`) and the minutes that declared it obsolete (`declaredIn`).
Nothing makes an obsolete decision valid again.

## Declarations

`declarations` is `{supersedes, withdraws, coexists}`:

| List | Entries | Meaning |
| --- | --- | --- |
| `supersedes` | `{decision, by}`, sorted by `decision` | `decision` is obsolete from this record on, superseded by `by`: one of this record's decisions, or a valid decision already recorded |
| `withdraws` | decision numbers, sorted | each is obsolete from this record on, with no successor |
| `coexists` | decision numbers, sorted | valid decisions close in topic to this record's that stay valid beside it |

Every entry is a decision number; no list repeats one, and at least one list is
not empty (a record that declares nothing leaves the field out). A decision is
made obsolete once, and never one of the record's own; the decision that
supersedes one is not made obsolete by the same record and, when it is the
record's own, is one of its decisions; a decision it stands beside is neither
its own nor made obsolete by it.

Against the minutes already recorded, every decision a record names outside
itself is a decision of a live minutes record, new or historical, of the same
project (`MINUTES_NOT_FOUND`, `MINUTES_RECORD_INVALID`), and no decision it
supersedes or withdraws is obsolete already (`MINUTES_DECISION_OBSOLETE`). The
write path also requires the superseding decision and the decisions it stands
beside to be valid. Replay checks the same, except that those two need only
exist: in a library merged from several devices, two devices that superseded one
decision apart leave the supersession merged first, and the other record is the
rejected event every device reads alike.

## Topic comparison

A record is refused with `MINUTES_POSSIBLE_CONFLICT` when one of its decisions
is close in topic to a valid decision of its project that its declarations do
not settle (one it supersedes or withdraws, the decision that supersedes one,
and one it stands beside are settled). The refusal names each such decision
under `conflicts`, strongest first, and the way out under `remedy`.

Each text is read as recall's tokens (lower-case words and CJK bigrams, stop
words removed). A token weighs `ln(1 + (N + 10) / (df + 1))` over the `N`
decisions compared (every live decision and the record's own), `df` of which
carry it; the score is the weighted cosine of the two token sets. Two decisions
are close at 0.5, when they share at least three tokens. Measured on the
recorded cross-project corpus (1,618 decisions), 68 pairs of decisions of
different records reach it; replaying the 263 historical records of the
cross-project library in order, 38 would have met a candidate.

The refusal is split by INIT family, as the card guard's
(`KNOWLEDGE_POSSIBLE_CONFLICT`) is (TCRN-CROSS-STORY-531, TCRN-CROSS-STORY-539;
the whole rule is in "Conflict retirement" of
`packages/core/spec/knowledge-core-v1.md`). A family is the Initiative at the
top of a work record's parent chain, and both guards read it through the same
references: a work id names its own, a minutes id those of the work the minutes
link (a conference's minutes, the conference's), and the external key of a work
record this library holds that record's. A record's families are those of the
work it links (`linkedWorkIds`, work ids only); a valid decision's, those of the
work its minutes link. A side has no known family when it links no work, or
when any work it links is one this library does not hold or one whose chain
ends at no Initiative. A close decision whose families and the record's are
both known and share none refuses nothing: the record is written beside it, the
decision added to the record's `declarations.coexists` as `--coexists` would
add it, and the `minutes-record` answer names it under `warnings` (`reasonCode`
`MINUTES_POSSIBLE_CONFLICT`, `decision`, `text`, `families`, `message`). A close
decision of a shared family, or of no known family on either side, refuses as
before; the refusal's `conflicts` names those alone and `otherFamilyConflicts`
the others.

## Operation

`minutes.recorded` carries `{operation, record}` (and `actor` once attestation is
enabled). Replay checks the record, that its id is new to both kinds of minutes,
that its project is live, that every linked work record is live and in that
project, and its declarations (see Declarations).

## Reading minutes

`minutesView` lists every live record, new and historical, ordered by the
instant it was recorded and then by id. Each entry is `{id, externalKey, kind,
projectId, title, summary, decisions, decidedBy, linkedWorkIds, recordedAt}`,
and `declarations` when the record declared any. `kind` is `minutes` for a
record of this shape and `conference-minutes` for minutes a conference close
wrote; those keep their `tcrn.conference.v1.minutes` records unchanged, read
with the conference's title, participants and linked work, `externalKey` null
and `recordedAt` the instant of the close.

A read gives one status of decisions:

- `valid` (the default): each entry keeps its valid decisions as `{number,
  text}`, with `supersedes` on a decision that superseded others; a record with
  no valid decision is left out, and one with obsolete decisions names their
  numbers under `withheldDecisions`.
- `obsolete`: each entry keeps its obsolete decisions, and a record with none is
  left out.
- `all`: every record with every decision.

In the `obsolete` and `all` reads every decision carries `status`; an obsolete
one carries `supersededBy` -- `{decision, text, status}` of the decision that
superseded it, or null when it was withdrawn -- and `declaredIn`.
`minutesById` finds one entry by id or by external key, with the decisions of
the status asked (an empty list when it has none); given a decision number it
answers the entry with that one decision, whatever its state, read as the
`all` read reads it.

## Hints

A work record whose decided-in minutes hold an obsolete decision, and a card
whose source references name such minutes (by id or by key) or whose subject,
summary, snippet or references name the decision (`minutes:<id>#Dn`,
`<external key>#Dn`, or the key and ` Dn`, a key's tail naming the one minutes
record that carries it), are read with `obsoleteDecisions`: `[{decision,
supersededBy}]`, `supersededBy` null when the decision was withdrawn. work-show
answers the work record's; a recall hit carries its record's, and its line adds
`过时决策 <decision>→<successor or 撤回>` after the id. Recall's `--status`
reads only the family of records that has the status it names, as that family's
read does: left out or `valid`, the valid decisions of each record, a record
with none not indexed; `obsolete`, the obsolete decisions alone, a record with
none not indexed, each minutes hit carrying its own under `obsoleteDecisions`;
`all`, every decision of every record. `removed` names a card status and leaves
the decisions valid. The prompt hook takes no status and indexes the valid
decisions only.

## Cards that repeat a record

A card is written for what the work records and decisions do not already say
(MIN-239 D5). Before a card is written -- by knowledge-create, a knowledge-batch
member, knowledge-capture or an article's index card, all through the one card
write in `packages/core/src/knowledge-core.ts` -- it is compared with the text
of every live work record (title, summary, scope, goal, acceptance and body) and
of every valid decision of the library (`packages/core/src/knowledge-duplicates.ts`).
The card's words are its subject, summary, snippet and body, weighed as the
topic comparison weighs them over those records and the card. A card whose
words a record carries for at least half their weight, sharing at least eight
of them, repeats it and is refused with `KNOWLEDGE_ALREADY_RECORDED`: `target`
names the closest record (a work id or a decision number) and `remedy` where
the content belongs, the work record or minutes. The code is not
`KNOWLEDGE_DUPLICATE`, which names one external key written by two writers.
Measured read-only on the cross-project library (158 cards), the eight cards at
or above the threshold are all retired or superseded cards restating an
Incident or Story; no active card reaches 0.44.

## Commands

`minutes-record` writes one record (`--project-id`, `--title`, `--summary`, the decisions as
`--decisions <list>` or `--decisions-file <JSON array of strings>`, `--decided-by`,
`--work-ids`, an optional `--external-key`, `--at`, `--actor`) and answers `MINUTES_RECORDED`
with `id`, `externalKey`, `decisions`, the written `ids`, `version` and `headEventHash`, and
`knowledgeHint` (`line`, `conflictCandidateIds`, `filteredByFamily`; see
`packages/core/spec/knowledge-core-v1.md`, "Conflict retirement"); when the record was
written beside decisions of another INIT family, the answer also carries `warnings` (see
Topic comparison). Its
declarations are `--supersedes <decision>=<successor>,...` (the successor may be `Dn`, a
decision of the record being written), `--withdraws <decision>,...` and `--coexists
<decision>,...`, each decision a number or `<external key>#Dn`; the answer then carries
`declarations` as stored.
`minutes-list` pages `minutesView` (`--project-id`; `--work-id` keeps the minutes that link the
work record or that it names as decided-in; `--status valid|obsolete|all`, valid by default;
`--limit`, `--offset`). `minutes-show` answers one entry, found with `--id` or `--external-key`,
with `decides`: the live work records that name it as decided-in; `--status` chooses its
decisions, and a decision number given to `--id` (or `<key>#Dn` to `--external-key`) answers that
decision with `decision` beside the entry, and takes no `--status`. Both reads work on an
old-layout workspace, which takes no new minutes (`LEGACY_WORKSPACE_READ_ONLY`). A work record
names its deciding minutes with `--decided-in` on `work-create` and `work-annotate`
(specs/work-model-v1.md). No verb is added for the lifecycle: the minutes verbs remain
`minutes-list`, `minutes-record` and `minutes-show`.

## Reason codes

| Code | When |
| --- | --- |
| `MINUTES_RECORD_INVALID` | the record or its declarations are out of shape, or a declaration names a decision of another project |
| `MINUTES_EXTERNAL_KEY_REQUIRED` | no numbered key exists yet to number a key-less record after |
| `MINUTES_NOT_FOUND` | no such minutes or decision |
| `MINUTES_DECISION_OBSOLETE` | a declaration makes an obsolete decision obsolete again, or names one as a successor or to stand beside |
| `MINUTES_POSSIBLE_CONFLICT` | a decision is close in topic to a valid decision the declarations do not settle, and the two share an INIT family or either side's family is not known; a close decision of another family refuses nothing: the record is written beside it and the `minutes-record` answer names it under `warnings` with this code (see Topic comparison) |
| `KNOWLEDGE_ALREADY_RECORDED` | a card repeats a work record or a valid decision |
