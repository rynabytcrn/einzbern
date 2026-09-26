# Minutes V1

## Status and scope

`einzbern.minutes.v1` records a decision in one write (TCRN-CROSS-STORY-475 R1,
MIN-227 D9, D10). A conference took an open, a position per participant and a
close; a minutes record carries the whole outcome at once and is never edited:
it is written with `revision` 1 and is not a tombstone. The schema is
`schemas/minutes-v1.schema.json`; the engine module is
`packages/core/src/minutes.ts`.

## Record

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `einzbern.minutes.v1` |
| `externalKey` | the record's key, canonical (upper case), such as `TCRN-CROSS-MIN-233` |
| `id` | `deriveStableId("minutes", externalKey)`; replay refuses any other value |
| `projectId` | a live project |
| `title` | non-empty text, at most 512 UTF-8 bytes |
| `summary` | non-empty text, at most 4096 UTF-8 bytes |
| `decisions` | 1 to 64 entries of non-empty text, each at most 4096 UTF-8 bytes |
| `decidedBy` | the participants who decided: up to 64 protocol ids, without repeats |
| `linkedWorkIds` | up to 64 live work ids of the same project, without repeats |
| `recordedAt` | the strict instant of the event that wrote it |
| `revision` | 1 |
| `tombstone` | false |

The field set is closed. A record that fails any rule is refused on the write
path with `MINUTES_RECORD_INVALID`, and replay reads the same event as
`WORKSPACE_EVENT_CORRUPT`.

## Decision numbers and references

Decision *n* of a record is `Dn`, its index in `decisions` plus one. A decision
is cited anywhere as the minutes id and its number, `minutes:<hex> D3`; a work
record names the minutes it was decided in with the `decided-in` relation (the
`advisory:decided-by` list of minutes ids, work-model-v1).

## Keys

A writer may give the external key. Without one, the engine takes the next
number after the largest one under the same prefix, keeping the width of its
digits and skipping a number whose id is taken; the prefix is the writer's, or
that of the minutes recorded last. A library that has no numbered minutes key
under that prefix yet refuses with `MINUTES_EXTERNAL_KEY_REQUIRED`: the minutes a
conference close wrote never stored their key, so the first record names its own.
A key whose id is already taken — by new minutes or by a conference's minutes —
is refused.

## Operation

`minutes.recorded` carries `{operation, record}` (and `actor` once attestation is
enabled). Replay checks the record, that its id is new to both kinds of minutes,
that its project is live and that every linked work record is live and in that
project.

## Reading minutes

`minutesView` lists every live record, new and historical, ordered by the
instant it was recorded and then by id. Each entry is `{id, externalKey, kind,
projectId, title, summary, decisions: [{number, text}], decidedBy,
linkedWorkIds, recordedAt}`. `kind` is `minutes` for a record of this shape and
`conference-minutes` for minutes a conference close wrote; those keep their
`tcrn.conference.v1.minutes` records unchanged, read with the conference's title,
participants and linked work, `externalKey` null and `recordedAt` the instant of
the close. `minutesById` finds one entry by id or by external key.
