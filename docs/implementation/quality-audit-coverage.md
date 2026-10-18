# Code-quality audit coverage and closure register

Current status: see the [2026-10-18 post-merge audit index](post-merge-audit.md). This register preserves its historical review and verification statements; older pending statuses are not the current status of merged PR #24.

Date: 2026-10-17. Initial inspection basis: `7aee972`; subsequent fixes are recorded separately.
This is a repository-wide inventory with risk-prioritized, partial static control-flow review,
not an exhaustive line-by-line security audit. Passing tests, lint and type checks do not close
unreviewed behavior or establish native macOS, real host or multi-device sync acceptance.

## Confirmed findings and disposition

| ID | Finding | Source / correction | Evidence and remaining boundary |
| --- | --- | --- | --- |
| F1 | Segmented body rewrite replaced committed bytes before manifest switch | `store-backend.ts`: fresh immutable numeric generations, staged initial publication, manifest switch before cleanup, bounded per-operation manifest-change retry | New deterministic state/publication cases plus migration/backup regressions; no power-loss or custom concurrent probe claim |
| F2 | Written index digest/count witnesses were not reconciled | Validate canonical index digest, total/per-segment counts, duplicates and complete byte coverage before rewrite | Altered digest/count/records/omission fixtures refuse without writes |
| F3 | Caught lock initialization failure could leave malformed owner | `file-lock.ts`: cleanup only the exact acquired file identity after caught initialization failure | Existing lock regressions; unknown/malformed foreign locks remain fail-closed; process-death recovery is not inferred |
| F4 | Body mutation reread and hashed a segment once per body | Reuse validated bulk generation read for write/remove | Existing migration/recovery regressions; no representative-scale timing claim |
| F5 | One dependency override contradicted exact-version policy | Pin fast-uri override to the already resolved `3.1.8` | Offline frozen install passed, no dependency version upgrade |
| F6 | Portal and relocation acquired registry/library locks in opposite orders | Registry-to-library scoped transaction; Portal target pin preserved | Focused relocation/registry regressions passed; final candidate verification pending |
| F7 | Registry repoint could precede source tombstone failure | Identity-bound destination guard, source receipt, registry publication and same-command recovery | Sequential phase/state fixtures; no custom concurrent probe |
| F8 | Relocation failure cleanup exceeded attempt ownership | Exclusive created-entry ledger and identity-bound explicit preparation discard | Unrelated/changed entries preserved; focused cleanup regressions |
| F9 | Queued writer checked tombstone before, not after lock acquisition | Under-acquired-lock tombstone recheck before mutation | Focused regressions; final candidate verification pending |

| F10 | Prefix-only containment misclassified valid `..cache` descendants | Shared segment-aware `pathIsInside` in settings/artifact validation | Root, descendant, sibling and parent boundary fixtures |
| F11 | JSON null work-batch input dereferenced before validation | Preserve null for domain validation rather than raw property access | CLI refusal must remain WORK_BATCH_MALFORMED with unchanged history |
| F12 | Portal prose reads hid all I/O failures as empty successful content | Only ENOENT means absence; sanitized structured failure preserves editor state | Five focused Portal cases passed, including existing ambiguous-binding rendering |
| Q13 | Invalid I/O budgets lacked structured reason codes | Domain error retains original message and adds stable reasonCode | Invalid environment and explicit budgets, without echoing values |
| F14 | A failed hook rollback stopped later restorations and hid the apply error | Attempt all restorations; retain primary cause/reason/details plus each rollback error and backup | Four deterministic disposable-fixture tests passed in the 101-case focused batch |
| F15 | Legacy model-plan unassign could retain orphan effort entries | Correct new mutation state; exact historical replay transitions retained internally, normalized public projection | Nine new history/cache/refusal tests passed; original bytes/digests preserved; existing compatibility 17/17 passed |
| F16 | Setup rollback could apply a different target from its confirmed plan | Optional expected current/previous identities checked under existing engine lock; direct rollback unchanged | Sequential stale-pointer refusal and byte-preservation tests passed in the 101-case focused batch |
| F17 | Vendored bridge runtimes were outside lockfile SBOM/notices | Digest-bound React/ReactDOM19.1.0 inventory, official MIT notice and explicit vendored SBOM provenance | Validator3/3, archive12/12 and27-component SBOM diagnostic checks passed; bridge unchanged |
| F18 | A registry/report failure could reject after engine/current had changed | Build the complete report before atomic pointer publication under the existing engine lock | Engine/setup focused19/19 passed, including invalid-registry/no-pointer-change cases; final frozen method remains pending |

The storage focused suite initially found an idempotent interrupted-migration regression.
The implementation now validates and reuses an already complete manifest before removing
identical flat duplicates; the original assertion was retained. The rerun passed 34/34.
This is focused evidence, not a frozen whole-repository result.

## Review coverage

T = targeted control-flow/specification review; S = sampled paths; I = inventory only.
No label means all paths in that area were reviewed.

| Area | Level / inspected material | Still outside a complete verdict |
| --- | --- | --- |
| Protocol and schemas | S/I: canonical/schema conventions and segmented witnesses | Every schema-to-TypeScript validator equivalence, Unicode/unknown fields |
| Storage, identity and replay | T/S: atomic files, locks, body generations, stream identity | Complete optimistic append/cache/replay matrix and real partial-sync behavior |
| Knowledge, retrieval and artifacts | T/S/I: migration/clear/recovery callers, recall cache, artifact staging | Ranking, all artifact durability paths, profile migrations, representative-scale measurements |
| Configuration and generated output | T/S: ownership/type/export inventory, device policy, portable paths, projection contracts | Native installed state and every external consumer's behavior |
| Governance, gates and leases | T/S: authorization, proposal approval and lease paths against current specifications | Complete assignment/conference/template/transition matrix |
| Setup, restore and relocation | T/S: relocation transaction, restore verification sequence, cleanup planning | Full install/update/uninstall interruption matrix and real sync recovery |
| Host/platform compatibility | S/I: path grammar, cloud hints, hooks and launcher source | Real macOS filesystem semantics, native hooks/trust and two-device synchronization |
| CLI and Portal | T/S: mutation target/token boundaries, lock ordering, selected render sinks | Exhaustive route/DOM/accessibility/cancellation/error behavior |
| Dependencies, release and privacy | S/T: pinned graph, bundle reachability, archive/CI paths, advisory and license metadata | Full release trust/archive threat analysis and every logging/network/process sink |
| Maintenance and test quality | S/I: TypeScript unused checks, syntax/style checks, test controller and fixtures | Whole-repository JS/HTML duplicate/dead-code analysis and broad exception taxonomy |

## Dependency snapshot evidence

The official npm advisory query returned zero advisories across 25 entries on the inspected
snapshot. All 25 installed dependency names/versions/license strings matched policy metadata,
and none of those manifests declared preinstall/install/postinstall scripts. This is a dated
metadata/advisory result, not a universal vulnerability-free or legal-compliance claim. Runtime
bundle reachability was sampled; final archive composition is verified by the packaging train.
The 25-package query excludes the shipped bridge’s two vendored React components. These
now have a separate digest-bound inventory and notices; the official bulk advisory query
for react/react-dom19.1.0 returned zero entries. SBOM explicitly distinguishes 25 lockfile
components from 2 vendored components instead of claiming one lockfile covers both.

## Investigated observations that are not confirmed defects

- Current gate proposal identity intentionally uses key/scope/timestamp, while the specification
  gives rules additional same-instant content binding. Do not silently impose a new gate contract.
- Current CLI decision validation is specified before the lock. No explicit commit-time revocation
  contract was found. Owner decision citations provide traceability, not authenticated proof that
  a human authored the decision. Commit-time freshness is a potential future contract decision.
- Artifact staging consolidation, persistent recall-cache budgeting and decomposition of large
  modules warrant further review, but source size or a different helper alone does not prove a bug.

## Verification discipline

Every final closure must name its exact candidate and actual command/receipt. Earlier passing
runs are never relabeled as final-HEAD runs. The original `7aee972` GitHub core leg reported
`TESTS_VERIFIED`, while that entire CI run remained red in Portal/privacy. Local doctor failures
were reproduced on the unchanged handoff baseline and the later clean GitHub core result is
separate evidence, not a reason to remove guards or alter assertions.

Custom runtime race/crash experiments that were not performed are not covered by ordinary
fixture tests. No real user library contents, macOS installation, host invocation or cloud-sync
state are attested by this audit. See `native-acceptance.md` for those independent obligations.

## Setup and installation source-review closure (2026-10-17 UTC)

The source review traced the bootstrap installer's argument admission, published checksum,
ustar path/type/duplicate checks, isolated unpack, engine self-update and stable launchers;
`setup-fresh` plan/apply and ordered wiring; `setup-maintain` archive/directory intake,
update, rollback and uninstall backup flows; `migrate-legacy` partition identity/head
comparison, registry/device settings and project-retirement orchestration; and
`install-tree-digest`'s normalized regular-file inventory. Existing engine copying,
re-digest, probe-before-switch and per-step backup behavior were read in context.

Two actionable ordering findings were confirmed: F16 binds a setup rollback to the
planned current/previous engine identities under the engine lock; F18 prepares compatibility
reporting before publishing `engine/current`, so a bad registry cannot turn a rejected
operation into an unreported pointer switch. Their deterministic focused regression
results remain in the candidate's external evidence, not a claim of native installation.

Together with the separate A/B/E semantic/governance/knowledge and F/G tooling/Portal
passes, and the configuration consumer review, the major source families now have
explicit control-flow coverage rather than only a filename inventory. This is a bounded,
risk-prioritized repository audit, not a proof of every execution path or absence of defects.
No new live-library migration, interrupted-install experiment, macOS/cloud-sync test or
host invocation was performed by this source review. Final-tree tests, archive identity,
CI, the prescribed packaging evidence sequence and native acceptance remain distinct gates.
