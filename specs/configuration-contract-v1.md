# Configuration Contract V1

`configurationContract()` enumerates every key from the existing project/library and machine
registries. The original inventories contained 27 governed entries and 7 device entries; newly registered
portable-path bindings, device agent concurrency and project generation choices are included
automatically and require explicit consumer metadata. Defaults,
limits and enum choices are read from those registries, never copied into a second value table.
The contract distinguishes semantic type from historical string storage and UI control type.

Each row identifies registered storage scope, authoritative scope, value owner, schema owner,
storage source, effective source, inheritance, sharing, export, consumer, effect and compatibility.
Legacy `models.*` and `quota.*` rows remain event-backed diagnostics; their current execution
policy authority is the device's explicitly selected host, not a project's old declaration.
Metadata does not migrate events, install policies, mutate defaults or refresh generated files.
The pre-existing `readKnowledgeLanguagePolicy` public API remains deprecated and read-only
for historical source compatibility; engine consumers use `readRuntimeKnowledgeLanguagePolicy`
and must not treat the historical reader as execution authority.

`annotateConfigValue(key, rawValue, valueOrigin)` validates using the existing key validator and
returns both raw and semantic values plus contract metadata. Booleans accept only true/false
text; integers must be safe and respect catalog ranges; collection values use the existing
closed JSON validators. Language lists use the same normalized parser as their consumer.
Every annotation explicitly separates value provenance from the family authority in
`contract.source`. Historical `models.*` and `quota.*` values carry
`valueRole: historical-declaration` and `valueSource: project-compatibility`, including absent
null declarations. Other annotations carry `valueRole: resolved-setting` and
`valueSource: caller-supplied-setting`; the caller is responsible for resolving their scope.
The adapter never labels a historical value as effective runtime policy and does not fill an
`effectiveRuntimeValue` field. Display these historical rows as compatibility diagnostics;
obtain live host values separately from `execution-policy-resolve` with its revision/digest.
Absent null is preserved, distinct from an invalid empty string. Unknown keys are explicit
`CONFIGURATION_KEY_UNKNOWN` errors. A source label is caller-supplied provenance, not independently
verified evidence. Historical readback never writes a replacement event.

Independent entries describe structured host policies, variables, rules, gates, managed sections,
identity/trust, leases, proposals, local bindings, quota observations, projections, browser
preferences and installed-engine state. These are not generic editable string settings.
Configuration projections and AGENTS output are not authority; device credentials, identities,
absolute path bindings, locks and account observations are not portable project declarations.

Registered setting descriptors are complemented by runtimeInputs: the supported environment,
browser, startup and installation controls, with operational command flags adapted from the
canonical CLI command catalog. See runtime-input-contract-v1.md for classifications and limits.
Consumer labels identify source integration, not live account, native host, installed release or
cross-device acceptance. Request-bound dispatch admission is specified separately in
execution-admission-v1.md; it is neither a native caller nor a global scheduler.

## Portable paths and generation migration

New shared path writes accept relative paths or `binding:paths.artifacts` and
`binding:paths.knowledgeArticles`. Configure the corresponding absolute location
with the device machine-settings command before consuming a binding. A portable suffix
(such as `binding:paths.artifacts/project-a`) selects a child; empty, dot, parent,
backslash, colon and control-character segments are refused. Machine settings are
validated with the same schema as the device catalog before resolving. Missing
bindings fail with `PATH_BINDING_UNCONFIGURED`; no directory is guessed or moved.
Historical absolute-path events remain readable and retain their original runtime
meaning for compatibility. They are not portable: migrate explicitly to a binding
before copying a library to another device. No migration rewrites old events.
`EINZBERN_HOME` is an absolute device directory. The legacy CLI `--home` argument
on machine-settings/device-clean remains the user home, not the device directory.

`agents.generation=none` stops future managed output creation/updates; it never
silently deletes existing files. `agents.sharedNavigation` controls the portable
navigation declaration; device `agents.navigation` only selects host integration.
New general-group display orders are 20 and 21, after existing design fields.
Other existing managed sections are preserved according to the normal user-edit
and explicit-removal rules. Re-render affected targets explicitly after changing
shared declarations; write receipts list potentially affected descendants and do
not claim that every remote device has refreshed its projection.

## Generated public inventory

`docs/implementation/configuration-inventory.json` is the complete, deterministic
output of `configurationContract()`, including every registered setting descriptor,
all independent entries and the contract's coverage limits. It is a generated
review artifact, not a second catalog or runtime configuration authority. It contains
catalog defaults and schema metadata only, never resolved local runtime values or
absolute device bindings. The original 34-entry inventory is not a fixed final count;
new registrations appear automatically.

After building the current source, regenerate from the repository root:

```sh
node --input-type=module -e 'import { configurationContract } from "./dist/build/packages/core/src/configuration-contract.js"; import { COMMAND_CATALOG } from "./dist/build/packages/cli/src/index.js"; process.stdout.write(JSON.stringify(configurationContract(COMMAND_CATALOG), null, 2) + "\n");' > docs/implementation/configuration-inventory.json
```

Review generated changes alongside the source registries and contract metadata. The
consumer fields identify implementation wiring, not evidence of live-host acceptance,
account access, remote refresh, or installation state.

The global descriptor registeredScope is the default registry scope, not a promise about
every target role. settings-catalog typedValues additionally expose effectiveScope and
effectiveSource from the presented contextual rows. Coordination-owned runtime settings,
including agents.generation and agents.sharedNavigation, are library-scoped there; they
never implicitly become development-project defaults. Historical host-policy rows still
separate declaration ownership from their device-host authority.

## Explicit projection refresh and legacy diagnostics

Settings and variable write receipts discover known registered downstream targets, including
transitive cross-library common defaults. They do not claim eager success on unavailable devices.
Use configuration-projections-plan and configuration-projections-refresh to execute the existing
managed writer with per-output refreshed, pending, unavailable or refused outcomes. The plan is
recomputed before execution and accepts registered output keys, never arbitrary output paths.
Catalog migrationDiagnostics names legacy absolute-path keys and the recommended local binding,
without copying the private path. No file is moved and no historical event is rewritten.
