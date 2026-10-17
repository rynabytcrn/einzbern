# Configuration projection refresh v1

## Scope and authority

`planConfigurationProjectionRefresh` reads only the current device's registered libraries (or an explicitly selected home for a read-only plan). It validates each reachable library identity and rejects tombstoned, ambiguous or unreadable locations. Coverage is always `known-device-registry-only`, not discovery of all devices. Unreadable registered libraries appear as unavailable inventory gaps because their dependency relationships cannot be determined. Unknown source targets remain unavailable.

A source is a stable library ID and optional stable project ID. The dependency graph contains library-default dependencies, declared same-library parent edges, and effective scoped `chain/common-default` references. Reverse transitive closure includes descendants and common-default dependents across libraries. Invalidation is deliberately conservative: an overriding field may not change, but its target is still included. Cycles cannot loop indefinitely. Coordination output is a library target, not a fabricated project. Unregistered output roots remain unavailable; no root is inferred from names or directories.

## Explicit execution

`refreshConfigurationProjections` is an explicit mutation, not a side effect of saving declarations. It rebuilds the plan immediately before execution and accepts only generated output keys as selectors, never caller-provided output paths or an old executable plan. Missing selectors mean all affected registered outputs; an explicit empty selector list means none. Unknown/unaffected selectors are refused. Selected execution against an alternate home is refused because the existing renderer resolves its dependencies and bindings through the current process device home.

Direct refresh pins the device registry before acquiring any library lock. Portal declaration
writes call only read-only impact discovery, never this explicit refresh transaction, so they
do not reacquire the registry pin held by Portal. No skip-lock flag exists.

Each selected available output uses the existing `assertLibraryWritable` and `renderAgentsSections` entry points, preserving their actor/authorization handling, append-planned-write locking, file-change checks, backups, rollback on commit failure, generation policy, and user-edited section protection. There is no force option and no automatic rule-resolution decision. Existing managed output remains governed by the same renderer contract, not a second writer.

Outcomes are per output:

- `refreshed`: the managed renderer completed with no outstanding user-owned/pending sections. This can be a byte-preserving no-op when already current.
- `pending`: not selected, generation disabled, or a user section decision is required. Disabled generation does not delete existing files and is not reported as refreshed.
- `unavailable`: unknown source, no registered output, inaccessible output or invalid dependency metadata.
- `refused`: the normal managed writer refused, a selector was invalid, or execution requested another device home.

Inventory gaps remain in the receipt even when selected outputs succeed. A partial result never means all devices refreshed. Refresh appends the renderer's ordinary records; it does not rewrite event history, copy machine model policies, or move files. Runtime/canonical projection state continues to be reported by the existing library-config contract independently of managed file refresh.

## Historical shared-path diagnostics

`diagnoseLegacySharedPaths` examines stored declarations for `workspace.generatedArtifactsPath` and `knowledge.articlesPath`. POSIX and Windows absolute values receive `migration-required`, the declaration's stable target, its field name, the appropriate local binding name, and the instruction to configure that binding before explicitly updating the shared declaration. Diagnostic payloads never contain the original path or an exception message that might repeat it.

Relative declarations and logical bindings are not flagged. Reads preserve legacy resolution behavior. The API neither reinterprets an old absolute path nor moves any file nor changes settings/history. Real user migration remains a separate explicitly authorized operation.

## Regression evidence

`tests/configuration-projections.test.mjs` exercises same-library descendants, transitive cross-library defaults, unknown/offline inventory, normal managed refresh, user-edit preservation, unknown/selective output execution, disabled generation, unavailable outputs, coordination-only refresh, alternate-home refusal, and value-free diagnostics. These are ordinary isolated fixtures, not custom concurrency or filesystem race experiments. Full same-candidate build/test receipts are recorded by integration; this specification does not itself assert a test run.
