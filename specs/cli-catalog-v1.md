# CLI Command Catalog V1

`tcrn.cli-catalog.v1` is the additive, machine-readable register of every governed
CLI verb. The `commands` verb emits it as canonical JSON so an agent can discover
the surface without out-of-band documentation. The catalog is descriptive of the
existing dispatcher; it introduces no new authority.

## Envelope

`commands` writes `{reasonCode: "CLI_CATALOG_READY", schemaVersion:
"tcrn.cli-catalog.v1", commands}` where `commands` is a canonically ordered array
of entries. Output is byte-identical across invocations.

## Entry fields

Each entry is `{name, availability, mutates, flags}`, optionally plus
`authorityBearing`:

- `name` — the dispatched verb.
- `availability` — `"cli"` for verbs invokable from the shipped binary,
  `"programmatic-only"` for verbs whose handler requires an injected authority the
  shipped binary does not supply (they fail with their authority reason code when
  invoked from the binary), or `"fixture-only"` for verbs the binary dispatches but
  which can only succeed against a synthetic Workspace. A caller reading this
  catalog to plan work needs to know the difference: a `fixture-only` verb invoked
  against a live Workspace fails by design, not by misuse, and no flag the caller
  can supply changes that.
- `mutates` — whether the verb appends a workspace event or writes store state.
- `authorityBearing` — present and always `true` on a verb that writes nothing but
  whose OUTPUT carries authority (currently only `adapter-activation-record`, which
  emits `host_observed_active`). It is a separate authorization category, not a
  weaker write: the operator bundle grants it through `authorityOutputCommands`, and
  a `writeCommands` grant never substitutes. An entry therefore never carries
  `authorityBearing` together with `mutates: true` — two categories for one command
  would leave no rule for which grant applies, and the dispatcher's write branch
  would silently win. The schema states the exclusion as a `dependentSchemas`
  constraint and the catalog refuses to load if a future entry violates it
  (`CLI_CATALOG_CATEGORY_AMBIGUOUS`).
- `flags` — each `{name, required, valueKind}`, where `valueKind` is one of
  `string`, `integer`, `boolean`, `json`, `list`, `instant`, `enum`. A flag that
  accepts an explicit null carries two optional descriptive fields:
  - `nullSentinel` — always `"-"`, the canonical spelling that means null (an
    omitted optional flag is also null). Present on `knowledge-create`
    `project-id`/`last-verified` and `work-create` `parent-id`.
  - `deprecatedAliases` — additional spellings still accepted this release but
    slated for removal. Carried by `knowledge-create` `project-id`/`last-verified`,
    and `work-create` `parent-id`, each `["null"]`,
    preserving the pre-unification `"null"` spelling for external callers. These
    are exactly the flags whose dispatcher accepts the `"null"` alias, so a caller
    can decide from the catalog alone which spellings a flag admits, and `work-list`
    `parent-id` resolves both spellings identically when filtering.

## Parity and stability

The catalog is the source of truth for the verb set: every dispatched verb has
exactly one entry and every entry dispatches. New verbs MUST add an entry in the
same change (enforced by the catalog↔dispatcher parity proof). Entries are
append-only; removing a flag or verb requires a new catalog version.

## Project-chain commands

`chain-identity` reads the explicit role or returns unclassified. `chain-declare`
writes an explicit role and coordination identity through the canonical engine
writer. `project-bindings-set --project-id --key --value` accepts the typed
`common-default` and `repositories` keys. `project-bindings-remove` explicitly
removes a project binding without changing unrelated configuration. These configuration changes have the
same Atelier-only CLI convention as other Owner configuration; the convention
is not authenticated-human identity.

`work-create` and `work-annotate` accept JSON `--involved-projects`; annotation
also accepts `--expected-revision`. `work-list --involved-project` accepts a
JSON stable reference. `project-context --reference` and
`work-project-context --workspace --id` are read-only and never acquire write
permission. The live command catalog specifies exact flags.

On an explicitly classified coordination chain, `gates-plan` / `gates-run` with
`--work-id` resolve each selected stable target and apply the existing gate
consumer to that target's own registered project root and local declarations.
Results contain one target result per work/reference, its work revision,
configuration version, effective settings and repository/build handoff. Runs
write to each target's own cache and pass the target's handoff, with the
repository and root the gates run in, to its gate process as
`EINZBERN_PROJECT_CONTEXT`; the relation grants no permission. A missing,
unavailable or refused target remains a failed target result, and the other
targets keep theirs. `work-project-context` gives each resolved context the same
`handoff` (reference, work revision, version, library, repositories, effective
settings, design, readiness, output places, enabled rules and variables) for a
native host dispatch to pass per target; a target that does not resolve has a
null `handoff`. Undecided work that the coordination library does not cover
refuses this operation; explicit coordination-only work needs no project run.
Without a Cross Project work subject the existing single-library form remains.

A work item that an enabled gate of the coordination library itself covers by
exact work id, in the scope of the item's own project, is planned and run in that
library as well (TCRN-CROSS-STORY-519): in the project root this device
registered for the library, under that project's declarations, one plan or run
per project, and the run records the project and the exact work ids, so the done
check of `work-transition` and `work-batch` reads it. These results are listed
apart under `library`: `projectId`, `workIds`, `projectRoot`, `ok`, and the
`plan`, or the run's `reds`, `requiredReds`, `run` and `recordPath`; a refused
one carries its `reasonCode` and the others stand. `targets` keeps its shape,
and `library` is absent when no item is covered. A covered item needs no decided
relation and gets no `PROJECT_SCOPE_UNDECIDED` or `COORDINATION_ONLY` result; a
selected one also runs per target, and the coordination library is never made a
development target. `--project-id`, when given, must name the project of every
covered item, or the operation refuses with `GATES_PROJECT_MISMATCH` before
anything runs; left out, each item's own project applies.

The gate root of a project in a coordination library, for these runs, for
`gates-plan` / `gates-run` with `--project-id` and for the done check of its
Stories, is the directory this device registered for the library. When no entry
holds that project, an entry registered for the library with no project, as
setup and migration write it, answers for any project the library holds and has
not deleted: the only such entry, or the one `--project` names. A project chain
still needs an entry for the stable project, or the root is `GATES_PROJECT_UNKNOWN`.
