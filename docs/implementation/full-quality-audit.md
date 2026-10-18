# Consolidated source-quality audit and repair scope

Date: 2026-10-18 UTC. This index supersedes the current-scope interpretation of the [post-PR25 index](post-pr25-audit.md), while preserving its historical receipts. The agreed source review completed before the consolidated repair batch began. PR26 repair integration and its accepted-candidate P1/P8/package verification are complete and merged; see the exact evidence identities below. This is not native acceptance, full PF-2/PF-3 closure or a claim that every original obligation is complete.

## Source-review coverage and limits

The review inventory is bound to intermediate commit `60ca59bc599aa69a647a897aefa9e4a32b888677`: 956 tracked paths, including 255 primary source/schema/contract paths. All 255 have explicit dispositions, with no remaining declared first-party source-review gaps under this method. The scope includes protocol/schema admission, storage/replay/cache, knowledge/artifacts, configuration/generated output, governance, setup/recovery/relocation, host/platform behavior, CLI/Portal, release/privacy, operational scripts and test infrastructure. Large CLI, Portal and workspace files were reconciled by their reviewed sections rather than assumed covered from a filename inventory.

This is a complete pass of the agreed first-party source-review scope, not exhaustive security or runtime proof:

- Vendored implementation internals remain outside the first-party review. Asset digests, consumer bindings and consumed bridge exports were checked; this does not certify all upstream code, rendered geometry or accessibility.
- The unserved historical design baseline's callable script was reviewed; its remaining reference visual markup/styles are explicitly excluded. Locale keys/placeholders/references were checked, not native-speaker fluency in every language.
- The 337 tracked paths under `tests/` comprise 257 behavioral test files and 80 helper/fixture/support paths. Systematic static suite-quality scanning, test wiring and selected manual assertion review do not mean every behavioral implementation was manually reviewed. Test helpers and controller contracts were reviewed separately. Portal's twelve behavioral tests and three helpers are a separate inventory.
- Native host/device behavior, live libraries, actual account/Owner decisions, two-device synchronization and representative-scale runtime performance remain unproved. Previously excluded custom Portal/symlink and dynamic race/crash/lifecycle probes were not performed or replaced with purported equivalent evidence.
- Storage declarations, validation helpers and mixed-clock import preflight received explicit read-only source review. That review did not add runtime proof. Subsequent repair regressions separately exercise a supported high clock and a non-rising clock on disposable copies; they do not establish every mixed-clock history.

The lightweight [gate receipt contract](../../packages/core/src/gate-run-record.ts) and [consumer bridge](../../scripts/lib/gate-run.mjs) added during repair have also been reviewed, including their package handoff. The original 255-path denominator describes the reviewed intermediate snapshot, not the final candidate's file count.

## Consolidated behavior and repair areas

The batch carries the earlier five intermediate corrections forward and groups the additional supported changes below. A source finding, deterministic reproduction and final packaged verification remain distinct evidence types.

1. **Protocol and configuration admission.** Preserve legal historical names through own-property-safe model conversions; remove accidental recursion-depth limits; enforce Unicode scalar and safe-integer representation contracts; align portable exchange paths. Reject malformed new identity/reference values and drive-prefixed shared path declarations at their intended admission boundaries. Tighten retained public legacy validators without restoring retired execution interfaces. Keep withheld exported variables visibly pending through full managed refresh.
2. **Storage, import and knowledge consumers.** Correct segment-aware root containment and reader compatibility with already-produced segmented indexes. Derive imported clock metadata from actual events and check the intended destination stream contract before writes. Treat malformed derived knowledge caches as rebuildable rather than authoritative; validate profile timestamp types. Bind in-process recall caching to its project scope, and consume complete paginated knowledge listings in language/evaluation tooling rather than silently omitting later records or expansion inputs.
3. **Governance and recovery.** Preserve structured member attribution for work-batch refusals. Validate required template binding digests, including replay, while retaining valid historical/unbound records and the Story prose exemption. Carry verified project binding through restore, distinguish an absent old copy from unreadable or invalid metadata, and retain duplicate-live-copy rejection. Preserve primary installer refusal details when staging cleanup also fails.
4. **CLI, Portal and host boundaries.** Put coordination gate execution inside heavy-run admission. Share canonical gate receipt validation and precise instant ordering across core and Portal. Report unreadable prose as unavailable, not matching. Bind variable-rename continuation to its original target and selection epoch, stop before a cross-target deletion and disclose partial completion. Preserve valid UTF-8 across host-output chunks; improve structured request/mutation failures, control recovery, prose selection offsets, missing translation coverage, knowledge pagination and filter focus.
5. **Gate, build and operational evidence.** Refuse silent compiler failures, dirty or unreadable final checkout status, missing/contradictory success markers and failed Git observations. Preserve measured failed gate receipts without converting them to success or dropping execution evidence. Validate closeout manifests/options and require actual child completion plus nonempty incident evidence; child transport failures are not expected product refusals. Correct impact-input aliases, process-state classification, check-mode drift reporting and unsupported host-observation claims. Repair synthetic compaction/benchmark contract mismatches without claiming measured production performance.
6. **Retained callable maintenance and proof tools.** Keep deletion safeguards dependent on an actual retained snapshot; avoid cross-filesystem temporary archive publication; reject future-dated freshness receipts. Correct legacy diagnostic result interpretation and intended-red attribution where those helpers remain callable. Restrict proof command sources to their supported repository contract. Obsolete dispatch proof tooling is explicitly retired rather than used to restore deprecated product features.
7. **Release and privacy evidence.** Keep rejected origin diagnostics value-free, align P8/SBOM producer and consumer contracts, and include the new gate bridge in extracted-package construction. Correct evaluator dependency identity where required. Historical public merge metadata is classified only through the existing exact reviewed commit/full-line-digest mechanism: individually reviewed subjects for the upstream and fork verification contexts, not a broad account-identifier exemption. All other lines remain scanned.

## Compatibility and upgrade boundaries

No live data migration or event-history rewrite is part of this batch. Existing valid historical reads, names, bodies and event bytes remain preserved. Where malformed but canonical array-valued identity fields could previously pass readers, the correction is explicitly new-write admission, not silent tightening of historical readback or coercion of old values. New shared-path guards likewise do not rewrite historical declarations. Required template-digest consistency is a documented replay contract, not a new policy.

New refusals should expose the actual malformed input, unavailable observation or stale target through existing structured boundaries without revealing private values. They do not authorize automatic repair of user history, registry edits, deletion of recovery copies or retries of an uncertain mutation. Stepwise setup, generation and variable rename are not represented as globally atomic transactions.

Explicit-ID coordination selection versus global uniqueness and the forward-slash UNC/privacy-heuristic ambiguity remain contract decisions, not automatic fixes. Supplied preverified publication evidence remains an offline consistency contract, not independent authentication. Deprecated host/dispatch/DSH features are not revived to clear an old backlog.

## Accepted PR26 verification and remaining gates

PR #26 merged on 2026-10-18 at 13:18:24 UTC as `a32bbc60551e3d1caf7f19ebfe7e4034309f5e29`. Its tree, `f20e70043baa65851aafced71f44a12a9ebbca49`, equals accepted head `081a924a09bf1a1a2e438f6910b64f5d212c0a8d`. Tree equality identifies the merged code; it does not relabel executions as runs on the merge commit or this later documentation closeout.

Independent reviews closed the Portal malformed-response/pagination and closeout option-validation gaps. The final P2/P3 pagination repair preserves distinct full canonical records, including legitimate unresolved versions, and streams the canonical list digest. Its sixteen focused regressions are diagnostic evidence, not an extra aggregate total.

Retained verification for **081a924a**:

- P1 run `39126873193` in the upstream repository passed all twelve legs. Core recorded 270 test files and 2,345 tests: 2,343 passed, zero failed and two recorded pipe-truncation-condition skips. Skips are not passes. The 973-source identity inventory and original stream digests were checked.
- Actual P8 and its strict consumer passed. The CI package matched the locally verified P8 archive, SHA-256 `4ff29d6abdd5b28b051c995153265d8ec2c85c1d1c708e6d19dcb7e15aa5f23c`; isolated installation/setup/doctor passed, including all eight doctor checks. This is not real Mac, live-library or native UI acceptance.
- This final repair used one automatic integration CI run. The unrelated earlier 52-invocation package diagnostic and formal H1 were not repeated. Formal H1 run `39122349184` in the contributor fork belongs to historical candidate `d0985199caaa00fecd02d170bacf62f51cf47d0d`, not 081a924a. Ordinary P1 is not literal H1.

The earlier P8 and P1 failures remain failed historical evidence; later success does not rewrite them. Focused checks overlap, and results from different heads must not be added or transferred. This documentation closeout records retained evidence; it does not run new tests, build a new package or attest the documentation commit as a newly executed candidate.

## PR27 and actual merged-main verification

PR #27 merged on 2026-10-18 at 15:41:47 UTC as
`8c6af763c338e815922036391a481fe58bc7d713`. Its tree equals reviewed candidate
`84d4382ccc982acb55011981a689f496ac0ef3ba`. The candidate's complete fork P1
`39136802820` passed before the existing contribution branch was fast-forwarded
to that same SHA; upstream P1 `39138432791` then passed separately.

The actual merge subsequently passed main P1 run `39141643115`.
Independent raw-artifact checks covered all twelve legs, including full reachable
history privacy, 974 source hashes and 271 core test files: 2,354 tests, 2,352
passed, zero failed and two explicit pipe-truncation-condition skips. The merge's
package smoke independently verified archive/install/setup and all eight doctor
checks. Its archive SHA-256 is
`4ff29d6abdd5b28b051c995153265d8ec2c85c1d1c708e6d19dcb7e15aa5f23c`.
Identical archive bytes do not change the source identity of any prior invocation.

This is current evidence for that merged baseline, not merely an old PR26 receipt
or a green-page assertion. It is not a new formal P8/H1 receipt, native acceptance
or evidence for a later release version. The initial fork candidate's privacy
failure and the old main failures remain historical failures. No historical
commit was rewritten and no blanket identity-payload exemption was introduced.

The [3.0.0 migration preparation](../releases/3.0.0-migration.md) additionally
records a dispatch-usability gap: caller-evidence validation and generated Skill
instructions alone do not provide native collection, launch or automatic storage.
Source-audit completion must not be interpreted as closure of that integration.

## Bounded next steps

1. Prepare [native Mac acceptance](native-acceptance.md#mac-acceptance-preparation-and-approval-boundary) with exact package identity, a read-only baseline, verified backup/rollback and disposable-copy checks before any separately authorized live write. Installation and publication are separate decisions; a candidate version is not a published release.
2. Reconcile PF-3/U18 original private inputs and method before scheduling any missing formal evidence. PF-3 requires its specified same-HEAD PF-2 controller receipt, dry-run and actual generation, four current inventories and consumer evidence without replacing immutable historical inventories. Historical H1 or tree equality does not waive those requirements, and missing inputs are not a reason for unrelated full reruns.
3. Before cloud-sync adoption, migrate shared declarations to portable references, configure each device's bindings and verify actual two-device alternating writes/merge behavior. Representative-scale performance remains unmeasured: the potential O(n²) concern is not a measured regression. Schedule that work against the intended deployment, not as an automatic broad audit restart.

The contract decisions above, container-only post-install headings and release authorization remain separate. Source-review closure and green candidate receipts do not attest an unexercised device, account or synchronization service. Preserve the historical indexes and inventories; do not treat their older pending statements as current PR26 blockers.
