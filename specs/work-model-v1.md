# Work Model V1

Work records conform to `work-model-v1.schema.json`. IDs and external keys are
stable, revisions increase monotonically from one, and tombstones remain
addressable records rather than deletion signals.

The planned-delivery graph is exactly `Initiative -> Epic -> Story -> Subtask`.
Initiatives have no parent; each other planned-delivery node has the immediately
preceding kind as parent in the same project. Missing parents,
cross-project parents, cycles, kind skips, duplicate IDs, and live references to
tombstoned parents fail closed.

Review, Incident, Release, and Knowledge are extension work shapes. They MAY
reference a same-project record but are not inserted into or required by the
planned-delivery hierarchy. Deterministic order is project ID in
`utf8-byte-order-v1`, kind rank, then record ID in that same total order. The
permitted status transitions are frozen in the protocol module;
terminal states have no outgoing transitions.

The protocol carries all eight kinds at every layer — validation, ordering,
template admission — and replay accepts all eight, so every record of every kind
already on a chain still reads, transitions and can be named by a relation. The
write path is narrower (TCRN-CROSS-STORY-472 R1, MIN-227 D6): a new record is an
Initiative, Epic, Story or Subtask. Incident (opened at the CLI in 0.3.2) and
Release (opened in 0.5.0) are refused as new records with `WORK_KIND_RETIRED` and a
remedy — a defect is a Story with a `fixes` relation — and Review and Knowledge were
never creatable. `work-list --kind` still filters by the historical kinds.

## Relations

Relations between work records are fields from a closed vocabulary of six names:
`parent`, `blocked-by`, `implements`, `supersedes`, `fixes` and `decided-in`. A
record stores only its forward relations:

- `parent` is its `parentId`;
- `decided-in` is its `advisory:decided-by` extension, a non-empty list of minutes
  ids checked for shape only, so a write may name minutes this library does not
  hold yet;
- `blocked-by`, `implements`, `supersedes` and `fixes` live in the `required:false`
  extension `advisory:relations`, whose value (`$defs/relationsExtensionValue` in
  `work-model-v1.schema.json`) is `{blockedBy?, implements?, supersedes?, fixes?}`,
  each a non-empty complete list of work ids, sorted in `utf8-byte-order-v1`,
  without repeats, never naming the record itself.

The reverse relations — `blocks`, `implemented-by`, `superseded-by`, `fixed-by` and
`decides` — are projected when a record is read, by one scan of the live records,
and are never an event field, so the two directions cannot disagree. A write
(`work-create`, `work-annotate`, a `work-batch` member) refuses a target that is not
a live work record, the record itself, an unknown relation or a list longer than 64;
an annotation replaces each list it names whole, and an empty list removes it.
Replay checks only the shape of the stored value: a chain written before a target
existed on this device, or merged from a device that saw records this one has not,
still reads. `work-show` reports `relations {forward, reverse, missing}`, and
`work-list --relation <name>=<id>` filters by a forward or a reverse name.

`missing` lists every forward target the library does not currently hold as a live
record: a `parent`, `blocked-by`, `implements`, `supersedes` or `fixes` target that
is not a live work record, and a `decided-in` minutes id that no live minutes
record here carries, minutes a conference close wrote included. It is marked when
the record is read and never stored: once the target arrives, from a later write
or a merged device stream, the next read no longer lists it, and the stored
relation is unchanged.

## Involved projects (format 2)

`involvedProjects` is a canonical work field, independent of the work item's owning
`projectId` and work-to-work relations. Its exact shape is `{state, targets}`.
`undecided` and `coordination-only` require an empty list; `selected` requires a
nonempty list of `{libraryId, projectId}` stable references. Writers deduplicate
and sort targets; replay refuses malformed or noncanonical shape without
requiring this device to access any target. An absent historical field reads as
undecided and is not backfilled during replay. A child's actual scope is explicit;
a selected parent provides candidates, never automatic child scope. A selected
child cannot exceed a declared parent's selected scope.

Create, annotate and batch preserve the field. `work-show` includes separately
resolved project contexts; `work-list --involved-project <JSON>` filters by both
identities. `work-annotate --expected-revision` rejects stale form submissions.
A selected relationship grants neither filesystem permission nor write authority.
