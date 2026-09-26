# The governed loop, end to end

This tutorial walks the whole product in one sitting: from an empty library to a
completed story whose closing decision is ratified in a conference, distilled into
the knowledge store, and then traced back through an unbroken chain of
digests. Every command below is a real governed CLI verb, and every one of them is
replayed verbatim by the hermetic proof `tests/e2e-governed-loop.test.mjs`, which
`pnpm test` runs — the tutorial and the proof are diffed against each other, so a
command that drifts here fails the build. The `verify:e2e` name that used to select
that one file retired in TCRN-CROSS-STORY-359; the proof did not.

The loop is:

**initiative → epic → story → conference → distill → decide → trace.**

## Conventions

- Commands are shown with a `$ ` prompt and the published binary name
  `einzbern`. Substitute your own installed invocation as needed.
- The library path is a placeholder (`./flagship/.ether`: a project's library is the
  `.ether` directory in its root). Identifiers written as `<project-id>`, `<story-id>`,
  and so on stand for the id echoed by the previous command's receipt — copy the real
  value from that output.
- Every mutation takes an explicit `--at` instant. The engine serialises writers
  with its own write lock, so no version is passed; each receipt echoes the ids it
  wrote, the new `version` and `headEventHash`. The instants here are illustrative
  and deterministic; supply your own real timestamps in practice.
- The loop stays actor-optional: attestation is never enabled, so no `--actor` is
  required. Enable it first if your workspace mandates attested writes.

## 0. Create the library

`init` creates the library (its manifest, README, `.gitignore` and empty `akasha/`,
`crest/`, `config/` and `artifacts/` directories) and leaves it at version 0. This
device's identity and write lock live in the device directory, not in the library.

```console
$ einzbern init --workspace ./flagship/.ether --project-name Flagship --at 2026-07-11T00:00:00Z
```

The receipt reports `LIBRARY_CREATED` at `version` 0. Each mutation below advances
the version by exactly one.

## 1. Plan the delivery graph: initiative → epic → story

First a project, then the frozen planned-delivery hierarchy under it. `work-create`
echoes the new record's id in `record.id`; capture each one for the next parent.
`--title` is required: a record that carries only an external key is findable by that
key and by nothing a reader would think to type.

```console
$ einzbern project-create --workspace ./flagship/.ether --at 2026-07-11T00:00:01Z --external-key FLAGSHIP-PROJECT --name Flagship
$ einzbern work-create --workspace ./flagship/.ether --at 2026-07-11T00:00:02Z --project-id <project-id> --external-key FLAGSHIP-INITIATIVE --kind Initiative --title Flagship-initiative
$ einzbern work-create --workspace ./flagship/.ether --at 2026-07-11T00:00:03Z --project-id <project-id> --external-key FLAGSHIP-EPIC --kind Epic --parent-id <initiative-id> --title Flagship-epic
$ einzbern work-create --workspace ./flagship/.ether --at 2026-07-11T00:00:04Z --project-id <project-id> --external-key FLAGSHIP-STORY --kind Story --parent-id <epic-id> --scope <story-scope> --title Flagship-story
```

Each verb returns `WORKSPACE_COMMAND_COMPLETED` with the created `record`. The Epic
names the Initiative as its `--parent-id`, and the Story names the Epic — the graph
is validated on every append.

## 2. Move the story into flight

A story is planned when created. Walk it through the lifecycle to `active`; it
reaches `done` only once its deciding minutes are recorded (section 6).

```console
$ einzbern work-transition --workspace ./flagship/.ether --at 2026-07-11T00:00:05Z --id <story-id> --status ready
$ einzbern work-transition --workspace ./flagship/.ether --at 2026-07-11T00:00:06Z --id <story-id> --status active
```

## 3. Hold the conference

Open a conference anchored to the story, record a position, then close it into
minutes. The minutes become the story's recorded decision.

```console
$ einzbern conference-open --workspace ./flagship/.ether --at 2026-07-11T00:00:08Z --external-key FLAGSHIP-CONFERENCE --project-id <project-id> --type architecture --title Decide-the-story --work-ids <story-id> --desired-outcome ratify-the-approach --participant-ids profile:architect-01
$ einzbern conference-append-position --workspace ./flagship/.ether --at 2026-07-11T00:00:09Z --conference-id <conference-id> --external-key FLAGSHIP-POSITION --actor-id profile:architect-01 --position persist-via-event-log --risks forward-reads-as-corruption --recommendations document-the-posture --evidence-ids evidence:position-01
```

Capture the conference id from the open receipt's `recordId`.

## 4. Distill the decision into knowledge

Before closing with distillation, initialize the disposable knowledge store in the
library's `crest/` directory — every library requires explicit acknowledgment that the
store is rebuildable and disposable.

```console
$ einzbern knowledge-init --workspace ./flagship/.ether --acknowledge-disposable true
```

Now close the conference with `--distill`. The close event lands first; the
governed high-water rebind re-binds the knowledge store to the advanced head, then
each minutes decision is written as a knowledge card, retrievable from the write. The
receipt carries the minutes id in `recordId` and the new card id in `knowledgeUnitIds`.

```console
$ einzbern conference-close --workspace ./flagship/.ether --at 2026-07-11T00:00:10Z --conference-id <conference-id> --minutes-external-key FLAGSHIP-MINUTES --summary approach-ratified --outcome-class role_decision --decisions persist-conference-and-gate-records --unresolved-issues - --distill true --accountable-owner-id owner:governance --stale-days 90 --evidence-ids evidence:close-01
```

The card carries the fixed conference tag set
(`conference-decision`, `distilled`, `type-architecture`), the deduplicated evidence
union of the position and the close, and a `sourceDigest` bound to the full minutes
basis. It is written with lifecycle `active`: there is no candidate state and no
promotion step, so the card answers recall from the moment it is written.

## 5. Read the card

Validate the knowledge store and list the card, while the knowledge marker's
high-water still equals the workspace head — before the final workspace mutations
advance it.

```console
$ einzbern knowledge-validate --workspace ./flagship/.ether
$ einzbern knowledge-list --workspace ./flagship/.ether --at 2026-07-11T00:00:11Z --selection all
```

`knowledge-validate` reports the marker `version`; `knowledge-list --selection all`
returns the card record, `lifecycle` `active` and `promotionState` `promoted`.

## 6. Record the decision and finish the story

The same minutes that produced the knowledge card are the story's decision.
`work-annotate --decided-by` records them on the story, and a Story reaches `done`
only once that decision is on the record.

```console
$ einzbern work-annotate --workspace ./flagship/.ether --at 2026-07-11T00:00:14Z --id <story-id> --decided-by <minutes-id>
$ einzbern work-transition --workspace ./flagship/.ether --at 2026-07-11T00:00:15Z --id <story-id> --status done
```

## 7. Trace the chain

Finally, read the governed record the chain hangs from and confirm the loop binds
end to end.

```console
$ einzbern work-show --workspace ./flagship/.ether --id <story-id>
```

The trace is a chain of digests, each link a field of one record that names the
next:

1. **Work record → conference minutes.** The story's `decidedBy` names the minutes
   id from the distilling close, and the story reached `done` only with that decision
   on the record.
2. **Conference minutes → knowledge card.** The card's `sourceDigest` is
   the canonical hash of the minutes basis (title, decision, minutes id) — recompute
   it and it matches, so the card provably came from these minutes, and the close
   receipt's `knowledgeUnitIds` names the same card.

No link reads a host path or a hostname — the chain is carried entirely by content
digests and governed record ids, so it is reproducible on every machine. That is the
whole governed loop: planned, deliberated, distilled, decided, and proven.
