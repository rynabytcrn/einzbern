# Native acceptance checklist (not executed by this PR)

Current preparation note: [3.0.0 migration preparation](../releases/3.0.0-migration.md)
distinguishes one-time governed configuration from routine machine admission.
Do not interpret this checklist as a request for repeated per-dispatch approval,
hand-written evidence envelopes or manual account observations. Missing native
collectors/return fields are capability gaps, not facts an Owner signature can
supply. The historical candidate identities below retain their original meaning.

The code and Linux fixture receipts do not establish the state of a user's Mac, external host
capabilities, account usage, or a second synced device. Perform these checks only after reviewing
the final PR and the exact candidate archive. Do not replace these steps with old receipts.

## Mac acceptance preparation and approval boundary

Preparation status after PR26 merge: **not exercised on a real Mac**. The accepted
source head is `081a924a09bf1a1a2e438f6910b64f5d212c0a8d`; merge
`a32bbc60551e3d1caf7f19ebfe7e4034309f5e29` has the same tree. Retained P1/P8 and
isolated installation/setup/doctor receipts are summarized in the
[accepted-candidate index](full-quality-audit.md#accepted-pr26-verification-and-remaining-gates).
They are not permission to install, publish, modify a live library or change account access.

Use this sequence before the detailed acceptance below:

1. **Identify without changing state.** Confirm the intended Mac, host, library and
   registered project scope with the Owner. First collect a read-only baseline of the
   current engine identity/install inventory, library identity and health, configured
   hosts and policy revisions, and project settings. Record unavailable observations as
   unavailable. Inspect command behavior before use; if a check may repair, refresh,
   install hooks or write a cache, do not treat it as read-only or run it on the live
   library at this stage.
2. **Bind the exact package.** The retained 081a924a archive SHA-256 is
   `4ff29d6abdd5b28b051c995153265d8ec2c85c1d1c708e6d19dcb7e15aa5f23c`.
   Verify downloaded bytes and read the exact package manifest for version and
   install-tree digest. Stop on a mismatch or missing identity. A later rebuild or
   documentation commit must not silently inherit this archive's receipts.
3. **Prepare recovery before applying anything.** With authorization for the backup
   destination, preserve and verify the previous engine installation, original library
   and event history. Keep the only recovery copy intact. Record how the previous
   installation will be selected and how backup integrity was checked; do not assume
   rollback also reverses new history or that an older engine reads new setting keys.
4. **Use a disposable target first.** Review the setup plan and exercise the candidate
   against an isolated fixture or an explicitly authorized disposable library copy,
   with separate target bindings that cannot reach the live library, project outputs or
   sync folder. Do not register a copied library as a second live instance. Inspect the
   plan's complete write targets before applying it. Stop on unexpected writes or
   incomplete recovery evidence rather than bypassing refusal guards.
5. **Obtain the live-operation approvals.** Before real installation/setup, identify the
   exact package, target device/library and planned writes to the Owner. A model-policy
   write additionally requires the actual current Owner decision and actor described
   below, followed by exact readback; do not substitute fixture values or obsolete
   model availability assumptions. Host permissions, credential/access changes, real
   dispatch and cloud-sync/relocation writes require their applicable explicit approval.
   Documentation approval alone grants none of these operations.
6. **Retain a minimal receipt.** Record candidate identity, UTC time, target alias,
   command, exit status and passed/failed/not-exercised outcome for each approved step.
   Keep raw evidence private and review any exported report for sensitive values.
   Never include credentials, tokens, private library contents or unneeded account
   details in reports. A refusal or uncertain mutation outcome requires readback and
   review, not an automatic retry. Stop when approval, a required input or safe recovery
   is missing; list that blocker rather than claiming acceptance.

This preparation does not schedule another full CI run. Formal PF-2/PF-3 evidence
must first be reconciled with its original method and final candidate as described
below. Cloud sync and representative-scale performance remain separate deployment
checks, not prerequisites to declaring the already completed source repair merged.

## Candidate and rollback

1. Record the final commit, archive SHA-256, install-tree digest and version from the reviewed
   package manifest. Verify the downloaded archive hash before installation. Version 2.2.3 is
   a candidate identity, not a claim that it was published. Recheck tag/release collisions before
   any later publication; do not overwrite an existing version with different bytes.
2. Preserve the current installed engine and the original library/event history. Run
   `einzbern engine-list` and keep the readback. Do not delete the only recovery copy.
3. Use the documented installer for the reviewed archive, then inspect the setup plan before
   applying it. Require actual `SETUP_PLAN_READY`, `SETUP_APPLIED`, and a new `einzbern doctor`
   receipt for the intended device/library. An isolated Linux receipt is not a macOS receipt.
4. If rollback is needed, use `einzbern engine-rollback --at <actual-UTC-instant>` only after
   verifying the preserved previous installation. Keep the returned receipt and run doctor again.
   Do not rewrite events or assume the older engine understands newly declared setting keys.

## Governed host policy and exact readback

1. Capture `einzbern engine-model-policy-catalog --host codex` and the corresponding readback
   for every other configured host. Record the host application's default model separately.
2. Prepare a policy JSON using `specs/engine-model-policy-v1.md`. The approved Codex ordering is
   flagship gpt-6-astra/max (order 10), main gpt-6.1-sol/max (20), economy
   gpt-6.1-sol/low (30), gpt-5.6-terra/max (40), gpt-5.6-terra/medium (50),
   gpt-6-luna/max (60). Use
   escalation enabled=true, threshold=2, ceiling=main. This is not a hardcoded engine default.
3. Obtain an actual current Owner decision naming `models.engine-policy` from the intended
   library and identify the actual actor. Do not copy a test fixture decision, actor or library id.
   Apply with the real values:

   ```sh
   einzbern engine-model-policy-set --workspace "$LIBRARY" --host codex \
     --policy "$(cat "$POLICY_JSON")" --at "$ACTUAL_UTC_INSTANT" \
     --actor "$ACTUAL_ACTOR" --decided-in "$ACTUAL_OWNER_DECISION"
   ```

4. Read `engine-model-policy-catalog --host codex` in a new process. Compare all category/tier
   values, ordering, escalation, quota declarations, host revision and digest exactly. Verify
   non-Codex host entries and host application defaults did not change. For ALL registered live
   projects (the scope of original attachment 553), confirm the same device-host policy
   source/revision/digest rather than historical project model declarations. Future projects
   must inherit the policy without a copied table. This is pending native verification; a
   two-project sample is not acceptance of the full scope.

## Selection versus actual dispatch

For rejection counts 0 through 9, run the actual installed command, saving stdout, stderr and
exit status separately:

```sh
einzbern execution-policy-resolve --host codex --category economy --rejections "$COUNT"
```

Expected tuples are Luna/max at 0–1, Terra/medium at 2–3, Terra/max at 4–5, Sol/low at 6–7,
and main Sol/max at 8 onward. There is no automatic Astra step. Verify the policy digest and
revision on every result. An absent quota observation must remain unknown, not zero.

Before dispatch, request work-project-context with --execution-request as specified in
execution-admission-v1.md. Supply the actual host capability tuples, requested agent count and
timestamped account observation. Require dispatchAdmitted and the target admission status,
then have the real dispatch adapter invoke its selected runner/model/effort without substitution
and retain its native acceptance or explicit refusal. `capabilityStatus=unchecked`, generated
instructions and policy selection are not native acceptance. If a tuple is unsupported, stop
that dispatch; do not silently switch runners, models, effort or host defaults. Repeat with the
actual configured non-Codex host. Verify a project budget cannot raise the device concurrency cap
in the adapter's real scheduling behavior. Engine admission bounds one declared request, not
global occupancy across independent hosts. Bind actual host stdout, stderr and exit status to
the admission through the review-evidence dispatchEvidence contract; unavailable fields remain
unavailable and cannot be replaced by test-run streams.

Knowledge language receipts currently enforce the resolved economy model identity against a
bundle provider. Their legacy bundle format has no runner/effort fields, so those tests do not
prove a native runner/model/effort invocation.

## Hooks, shared configuration and sync

- Start actual supported host sessions and subagents. Capture the real event sequence and verify
  prompt/subagent recall reaches the host before the relevant work. Navigation prose alone is
  not recall evidence.
- Exercise the installed dedicated Read guard with ordinary fixtures: a file above 32 KiB with
  no line bound or more than 200 requested lines must refuse; valid bounded reads are allowed.
  Shell remains observational. Verify installation/update/doctor ownership of these hooks and
  that retired Stop/SSH hooks are not restored.
- Compare ALL registered live projects' own output/language/design settings while confirming
  their shared engine policy, and verify future-project inheritance without a copied table. Verify explicit variable exports and value-free withholding diagnostics, and verify
  generation=none does not erase existing owner text.
- Before cloud sync, explicitly migrate shared absolute declarations to portable references and
  configure bindings separately on each device. Verify alternating writes and merged content on
  two real devices using the intended sync service. Same-machine temporary directories do not
  establish this acceptance.

Record each item as passed, failed, or not exercised with its candidate identity and actual
receipt. Never roll these statuses into an unqualified claim that native acceptance is complete.

## Relocation recovery acceptance

Before any real relocation, preserve a verified backup. Use the reviewed relocation command
against fixture libraries first. A pending destination is intentionally write-blocked until
source publication and registry repoint finish. Retry the same source/destination command to
resume a published transaction; a returned historical receipt is not fresh verification of
later destination writes. For an unpublished preparation, inspect its transaction identity
and use `workspace-relocate-discard --workspace <source> --to <target> --transaction-id <id>`
only when the engine validates the unchanged source and exact attempt-owned entries. A refusal
must not be bypassed with recursive deletion, arbitrary tombstone removal or registry editing.
This checklist does not attest real cloud-provider rename/hydration behavior.


## Container-only heading follow-up

These are post-install edits to the owner's container AGENTS.md, not engine template
changes. Current read-only inspection confirms they remain pending. Apply only under
separate write authorization and in a separate container commit:

- `### 八、Owner 即时规则` becomes `### 八、Owner 即时规则（已迁入第三部分）`.
- `## 第三部分 受管段：内置原则与系统变量` becomes
  `## 第三部分 受管段：内置原则、系统变量与自定义变量`.

Preserve all managed markers and body bytes. Verify the managed-sections doctor is
okay with an empty pending list. The original acceptance method identifies these
as MIN-267 D1 / R10-N5; this source PR does not claim they were applied.

## PF-2 / PF-3 final evidence method

After package preparation commits, freeze the final HEAD. PF-2 H1 runs once in an
isolated build clone using the reviewed `--mode pf2-h1` adaptation of the supplied
original d1-runner.py observer, documented in `ci-p1-evidence.md`. Preserve complete controller stdout/stderr and outer
stdout/stderr/meta with input/output identities, sizes, hashes and exact test-file,
pass and fail counts. Prior generic test summaries are diagnostics, not substitutes.

PF-3 verifies identical HEAD and zero tests/portal-tests diff, then reuses that PF-2
controller stdout. Missing receipts cannot be replaced by an unrelated full rerun.
It also requires U18 dry-run and actual generation, four inventories bound to HEAD
and allOk, plus privacy-boundary, init053-owner-return and
staged-privacy-reviewed-paths consumer tests. The exact supplied runner/method must
be reviewed and adapted to the execution environment before this sequence begins.

### Unresolved method reconciliation

The BL-39 option preserves the four original verification inventories as immutable historical
snapshots. PF-3 separately calls for current-HEAD regeneration of four inventories. Choosing
historical retention does not waive that later requirement: current regeneration and the exact
method/input reconciliation remain pending. Do not overwrite the historical snapshots or label
summaries as regenerated inventories. Required U18 historical inputs and dry-run/actual-generation
receipts must be complete before claiming PF-3 closure.

The default CI observer described in `ci-p1-evidence.md` runs the existing single `verify:p1`
train. It is independent P1 evidence. Only an explicitly selected `pf2-h1` run executes the
literal H1 `script=test` command; its implementation or focused test pass is not an H1 receipt.
Neither mode replaces PF-3's reuse of its specified PF-2 receipt. Actual upgrade/setup dry-run receipts and final
package privacy evidence must also be bound to their exact candidate rather than inferred from
source implementation or an earlier package smoke.

## INIT062 dot native acceptance: separate, not executed

The dot implementation is not a claim about any live device, provider, shared library or
scheduler. The original DOT-R03 and DOT-E04 remain E4 obligations. Authored source and
sequential fixtures are not real execution evidence. The implementation-only batch exception
is not a product admission bypass and never turns a refused admission into an admitted one.
None of the historical Mac/host receipts above applies to dot by implication.

### Actual-session context scenes (B4 / DOT-R03)

Keep three distinct scene records: a new task, a resumed task, and an independently delegated
execution. For each scene, select an already authorized narrow task and record the actual
library, project, work revision and scope digest. The executing session itself must read:

- AGENTS: the independent body and its actual template/rule versions and digest.
- Mana Orchestrate: the generated skill's actual source version and digest.
- Work: the current work record through the supported engine read entry.

Use the `tcrn.execution-context-read.v1` structure with one actual `sessionRef`, `readAt`,
`workReference`, positive `workRevision`, `scopeDigest`, explicit `effectiveRoots`, and exactly
one of each logical file key `agents`, `mana-orchestrate`, and `work`. Each file needs a source
version, SHA-256, read method and reference to its actual tool return. Current expected values
come from real work/source/root readbacks, not a copied parent-session assertion.

`normalizeExecutionContextRead` only validates structure. `assessExecutionContextRead`
compares those observations and returns a context check compatible with the dot admission;
its context digest binds that check. Parent-session, patrol, unavailable and unverified
associations cannot pass this scene. File presence, install receipt S6, a matching hash alone,
or this checklist cannot establish S7. Source association is not provider authentication.

Scene status at source integration:

- New task: not executed; no actual scene-specific tool-return bundle supplied.
- Resume: not executed; no actual scene-specific tool-return bundle supplied.
- Independent delegation: not executed; implementation handoff and local source reads do not
  establish the native admission/attempt/result/writeback acceptance chain.

### End-to-end evidence (D2 / DOT-E04)

The independent acceptance role must associate the scene's context with the exact candidate,
formal dot admission, local attempt, actual native tool response, independent deliverable
verification, supported engine write and subsequent readback. Record missing capability,
permission or evidence at the stage it blocks. Do not request fabricated JSON or repeated
approval as a substitute for an unavailable provider observation.

Keep the five stage findings independent: G1 actual-session context reads above;
G2 current target repository/output/language/design/capability readiness and permissions;
G3 explicit native admission with actual occupancy including parent and platform cap;
G4 the pre-call local attempt, actual response and association/finality observations;
G5 independent deliverable verification, supported write and same-library readback.
Coordination-only context never invents a repository target. Self model/quota may be
not-applicable, but that does not waive G2/G3. Retry lineage, conflicts, late results
and unknown execution responsibility remain preserved. Every stage is not-exercised
here; the five names are acceptance stages, not new work packages.

A pending local attempt has no fabricated native response. Preserve actual provider fields
only when the raw response contains them, with their source reference and JSON pointer.
Keep accepted/running/reported completion, provider-confirmed execution finality and independent
deliverable verification separate. Verified deliverables do not prove the task stopped or that
its active-slot responsibility can be released. Native envelopes must not acquire process
`selectedTuple`, stdout, stderr or exitCode fields. Legacy process evidence retains its own
strict contract.

For shared publication, an old successful transaction is not permission for a new one. Require
the current full baseline, a submission-time complete refresh, supported semantic reapply,
current operation-specific serial handoff, segment-before-manifest publication, actual remote
byte readbacks and independent replay. Advisory state is not a lock; absence or age never proves
an available writer slot. Unknown publication or release remains unknown pending observation.

The independent E4 report must name the actual candidate and retain per-scene/per-stage
passed, failed or not-exercised findings with private source references. No source-integration,
generation or fixture result closes E4, DOT-S01's live-instance component, real backup enablement
or real provider terminality.

### Reserved storage consumer audit

This is a source-consumer audit, not a live cleanup or retention acceptance receipt.
The CLI's fixed advisoryStorageAuditEvidenceRef points here, never to a request flag.
Runtime path checks remain mandatory on every advisory operation.

- Config backup reserves config-backups, config-backup-staging and
  config-backup-recovery below one explicit external root. The CLI supplies actual
  source/registered library and project roots, device root, engine/helper source
  root and all registered effective generated-artifact roots, including canonical
  aliases. It uses resolveGeneratedArtifactsRoot, not the mkdir-capable assertion.
  Unknown registered generated roots refuse rather than disappearing from protection.
- Group bindings live in the separate device config-backup-bindings directory.
  device-clean examines only device trash/backups and recognized stale/version/skill
  entries. It does not recursively clean the device or this binding directory.
- Shared advisory is the fixed library-relative
  artifacts/coordination/shared-submit/advisory.json. Its consumer rejects device
  roots, dist ancestors, registered repository dist roots, links/nonregular files,
  and uses the actual local library lock plus readback. It is never a CAS/lease.
  Config backup root disjointness from every library excludes this advisory tree.
- artifact-store stages/removes only explicit digest blobs and lists top-level .gz
  entries, not a recursive directory sweep. safeCleanOutputRoot quarantines the
  explicit repository dist, and task build resets dist/build. These do not consume
  the external reserved tree or library advisory. Projection refresh writes only
  declared output files and preserves independent dot ownership as pending.
- Helper rendering reports extras rather than deleting them. Original G must still
  retain the handoff's create-skill-archive.mjs exact keep item and verify its own
  final generated directory; this source audit does not claim G's generation ran.

No generalized cleanup framework was changed. An explicit future cleanup target or
new consumer overlapping either reserved surface needs a new audit, not reliance
on this static description. No real reserve, advisory or device cleanup ran here.

### Candidate sourceVersion refinement and remaining E4

The backup candidate now uses the actual packaged bundle's observed install-tree
identity plus running version; absent commit is explicit unknown, not a developer
HEAD. See specs/config-backup-v1.md for the approved-v2 basis, two-read binding,
layout refusals and existing Owner-decision policy target. Independent acceptance
must inspect and execute this exact candidate rule, including the actual package
entry, not merely a directly injected core fixture. All such execution remains
not-exercised at integration. No real backup policy, schedule or persistent grant
has been approved by this implementation.
