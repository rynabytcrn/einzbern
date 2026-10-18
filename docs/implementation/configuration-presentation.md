# Configuration presentation closure

## Navigation decision

The approved configuration proposal's section 8 recommends top-level destinations
for Device and hosts, Libraries, Projects, Custom variables, and Compatibility /
diagnostics. This implementation deliberately retains Atelier's existing topic
navigation (General, Models, Execution, Knowledge, Retrieval, Storage, Atelier)
and its dedicated model-policy and variable pages. It uses the approved equivalent
presentation rather than a wholesale navigation redesign.

Topic grouping is not ownership. Every row from the settings and machine-settings
catalogs displays its effective scope and sharing rule outside the disclosure.
Historical model and quota rows also visibly say that they are read-only. Their
controls remain the existing compatibility view with a link to the engine-host
editor, not an alternative policy write path. A project's selection does not
select or change the engine-host policy's authority.

## Catalog rows

The engine-owned configuration dictionary remains the source of ownership,
storage, sharing, export, inheritance, compatibility and effect metadata. The UI
does not create a second configurable dictionary or infer authority from a topic.
The row's disclosure shows:

- The concrete selected library/project identity, or the device/host target.
- Effective scope, owner, authority source and declaration persistence source.
- Sharing and export rules separately. Library sync is not project export.
- Declared value, effective readback, source, value role and inheritance status.
- Catalog default, inheritance rule, effect timing and compatibility role.

Readback scope takes priority over the registered scope. A coordination library
can therefore display an actual library-owned declaration without being mislabeled
as project configuration. The target uses stable identities, not directory names.
Absent metadata produces an explicit unavailable message rather than silently
omitting the contract.

Machine catalog rows contain saved declarations, not the final resolved values of
all consumers. The UI labels the declaration and catalog default separately and
states that effective values and sources are consumer-resolved, including startup
and browser overrides. It does not fabricate effective device values from defaults.
The browser theme and locale controls also have localized titles and accessible
descriptions identifying browser localStorage, immediate effect and no library
sync, distinct from device defaults.

Historical model and quota records retain their declaration scope and source. A
separate authority field names the device host policy, while the historical-source
field names the shown old record. The effective-value field explicitly says that
the historical record is not effective host policy. Historical typed values remain
inspectable without becoming editable or being advertised as runtime choices.

## Dedicated editors

Both engine-host editor entry points share one contract renderer. It identifies
host ownership, local persistence, sharing/export policy and saved policy readback.
It distinguishes unsaved controls from the persisted declaration and explains that
runtime policy resolution occurs on the next read. An unconfigured host is shown
as unconfigured, not as an inherited project policy.

The variables section displays its dictionary contract, including library sharing
and explicit export semantics. Each variable has target, declared/effective value,
source, inheritance state and current export readback. New variables report no
persisted value and no exports; inherited variables show no local declaration;
historical records without exports retain the established AGENTS compatibility
meaning. Explicit empty export lists remain empty. Existing replace/patch and
save behavior is unchanged.

This narrow closure does not relabel governance, installation or runtime-state
surfaces as generic settings. Their dedicated operations remain separate. It does
not introduce a new navigation tree, alter persistence or execution, mutate DSH,
rewrite historical events, or deploy anything.

## Verification

- `node --test portal/tests/configuration-presentation.test.mjs portal/tests/agents-read-errors.test.mjs portal/tests/theme-preference.test.mjs`: 16 tests passed, including nine ordinary presentation tests.
- `node portal/scripts/i18n-proof.mjs`: all eight proof legs passed across English,
  Simplified Chinese, Japanese, Korean and French; no new dynamic-key exemptions.
- Focused tests execute shipped render helpers with ordinary readback fixtures and
  inspect the resulting DOM. They cover inherited/local/device/coordination and
  historical sources, host identity, absent metadata, drafts, and variable exports.
- The existing failed-prose-load guard was preserved and its five tests passed.

These focused results are not a claim of live-host or browser visual acceptance.
The shared build, full Portal suite and required proof regeneration are serialized
by the integration task against the complete candidate.
