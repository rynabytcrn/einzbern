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
write to each target's own cache and pass the same handoff to its gate process
as `EINZBERN_PROJECT_CONTEXT`; the relation grants no permission. A missing,
unavailable or refused target remains a failed target result. Undecided work
refuses this operation; explicit coordination-only work needs no project run.
Without a Cross Project work subject the existing single-library form remains.
