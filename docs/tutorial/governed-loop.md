# The governed loop, end to end

This tutorial walks the whole product in one sitting: from an empty library to a
completed story whose deciding minutes are recorded in one command, named on the story
with the `decided-in` relation, and then traced back from both ends. Every command below is a real governed CLI verb, and every one of them is
replayed verbatim by the hermetic proof `tests/e2e-governed-loop.test.mjs`, which
`pnpm test` runs — the tutorial and the proof are diffed against each other, so a
command that drifts here fails the build. The `verify:e2e` name that used to select
that one file retired in TCRN-CROSS-STORY-359; the proof did not.

The loop is:

**initiative → epic → story → minutes → decided-in → done → trace.**

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

A Story needs two things, its goal (`--goal`) and its acceptance (`--acceptance`); a free
`--body` is optional, and the engine checks nothing else about how you write it. A Story
missing either is refused with `WORK_STORY_FIELD_REQUIRED`, which names the field.
`<story-goal>` and `<story-acceptance>` stand for your own text (quote it in a shell);
this Story's goal ends `decider: Owner.`, which section 4 relies on. `work-draft` still
prints the old ten-block skeleton if you want a shape to follow, marked optional, and a
`--scope` in that shape still works: its Goal and Acceptance Criteria blocks are read as
the two fields.

```console
$ einzbern project-create --workspace ./flagship/.ether --at 2026-07-11T00:00:01Z --external-key FLAGSHIP-PROJECT --name Flagship
$ einzbern work-create --workspace ./flagship/.ether --at 2026-07-11T00:00:02Z --project-id <project-id> --external-key FLAGSHIP-INITIATIVE --kind Initiative --title Flagship-initiative
$ einzbern work-create --workspace ./flagship/.ether --at 2026-07-11T00:00:03Z --project-id <project-id> --external-key FLAGSHIP-EPIC --kind Epic --parent-id <initiative-id> --title Flagship-epic
$ einzbern work-create --workspace ./flagship/.ether --at 2026-07-11T00:00:04Z --project-id <project-id> --external-key FLAGSHIP-STORY --kind Story --parent-id <epic-id> --goal <story-goal> --acceptance <story-acceptance> --title Flagship-story
```

Each verb returns `WORKSPACE_COMMAND_COMPLETED` with the created `record`. The Epic
names the Initiative as its `--parent-id`, and the Story names the Epic — the graph
is validated on every append.

## 2. Move the story into flight

A story is planned when created. Walk it through the lifecycle to `active`; it
reaches `done` only once its deciding minutes are on the record (section 4).

```console
$ einzbern work-transition --workspace ./flagship/.ether --at 2026-07-11T00:00:05Z --id <story-id> --status ready
$ einzbern work-transition --workspace ./flagship/.ether --at 2026-07-11T00:00:06Z --id <story-id> --status active
```

## 3. Record the decision as minutes

A decision is written down in one command. `minutes-record` takes a title, a summary,
the decisions, who decided them (`--decided-by`) and the work records they bear on
(`--work-ids`), and numbers the decisions D1 to Dn in the order given. `--decisions`
is a comma-separated list; when a decision's text holds a comma, pass
`--decisions-file` with a JSON array of strings instead.

```console
$ einzbern minutes-record --workspace ./flagship/.ether --at 2026-07-11T00:00:08Z --project-id <project-id> --external-key FLAGSHIP-MINUTES-1 --title Decide-the-story --summary approach-ratified --decisions persist-the-decision-as-minutes --decided-by owner:governance --work-ids <story-id>
```

The receipt returns `MINUTES_RECORDED` with the minutes `id` (capture it as
`<minutes-id>`), its `externalKey` and the numbered `decisions`
(`[{"number":1,"text":"persist-the-decision-as-minutes"}]`). Without `--external-key`
the engine takes the next number after the latest key recorded in the library, so only
the first minutes of a library need one. `minutes-list` pages every minutes record —
those a retired conference close wrote included — and `--work-id` keeps the ones that
bear on one work record. The receipt also carries `knowledgeHint`: one line asking
whether the decision holds knowledge worth a card (`是否有可提取的知识；可能冲突的卡：…`),
and under `conflictCandidateIds` the cards a card about the minutes' summary could
conflict with — here none, since this library holds no card yet.

## 4. Name the minutes on the story and finish it

The story's goal names Owner as its decider, so it reaches `done` only once the
minutes that decided it are on its record. `work-annotate --decided-in` puts them
there; `work-create` takes the same flag when the minutes already exist.

```console
$ einzbern work-annotate --workspace ./flagship/.ether --at 2026-07-11T00:00:09Z --id <story-id> --decided-in <minutes-id>
$ einzbern work-transition --workspace ./flagship/.ether --at 2026-07-11T00:00:10Z --id <story-id> --status done
```

The transition to `done` answers the same `knowledgeHint`, scored against the story's
title and goal. A lesson worth keeping is written with `knowledge-create` (or the thinner
`knowledge-capture`): the card is active and retrievable the moment it is written, with no
lifecycle flag and no promotion step, and a card that replaces an older one names it with
`--supersedes`. `--scope user` files it in your own crest, which every project recalls.

## 5. Trace the chain

Finally, read both records and confirm that each names the other.

```console
$ einzbern work-show --workspace ./flagship/.ether --id <story-id>
$ einzbern minutes-show --workspace ./flagship/.ether --id <minutes-id>
```

1. **Work record → minutes.** `work-show` reports the story `done`, with the minutes
   id under `relations.forward.decidedIn` (the same list is the record's `decidedBy`)
   and its goal and acceptance under `fields`.
2. **Minutes → work record.** `minutes-show` returns the minutes with D1, the story id
   in `linkedWorkIds`, and the story again under `decides`: the reverse of
   `decided-in`, read from the work records rather than stored twice.

The proof hashes the two records into one digest, which changes if a single field or
edge changes. No link reads a host path or a hostname — the chain is carried entirely
by governed record ids, so it is reproducible on every machine. That is the whole
governed loop: planned, decided, recorded, done and traced.

Earlier versions of this tutorial held a conference, closed it into minutes, distilled
them into a knowledge candidate and promoted it. The conference verbs retired with
TCRN-CROSS-STORY-475; the minutes those closes wrote are still read by `minutes-list`
and `minutes-show`. The candidate and its promotion retired with TCRN-CROSS-STORY-476,
which is why the loop now asks for a lesson at `done` instead.
