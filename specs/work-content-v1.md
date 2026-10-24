# Native minimum work content v1

Native structured work content, template binding and acceptance contracts.

`advisory:work-content` is the single native structured source. Its shape is
`schemas/work-content-v1.schema.json`; existing work records, template registry,
admission receipts and required template bindings are reused. `tcrn.template.v2`
selects this content contract. It is not another dispatch receipt. V1 templates,
legacy scope and goal/acceptance/body are read unchanged. Typed records project
those fields on read; independent writes to the mirrors are rejected. Free body
has no heading count, order, four-anchor floor or ten-section requirement.

## Minimum content and phases

All four kinds carry goal, sources, scope/constraints, requirements/acceptance and
completion result. Completion is required only for done. `workContentDraft`
returns empty fields, not invented answers. Planned is the draft state; ready is
formal structure, active is execution, done needs actual evidence. Drafts may be
incomplete; missing information remains visible via `workContentMissing` and the
context. Information collection and lease coordination are not implementation.
No new readiness ceremony or universal gate is introduced.

Type details: Initiative has boundary, approvalBasis, allocationPlan; Epic has
deliverables, interfaces, dependencies, childResponsibilities; Story has behavior
and discretion; Subtask has assignedRequirements, deliverables, dependencies,
verificationOwner. Constraints are inherited, not editable suggestions. A defect
is a Story variant adding expected, actual, reproduction, affectedVersion,
fixBoundary and regression. Empty or unknown prose is not proof of sufficiency.

## Requirements, sources and responsibility

Requirements have stable ids and positive content versions. Sources name their
kind, exact locator, content version, extraction state and accurately transcribed
text. Partial/unavailable is allowed to be saved, never silently called complete.
Each formal requirement refers to its sources. Parent allocations name the exact
requirement version, a direct child and implementation or verification role.
Parents with children, Initiatives and Epics report both missing responsibility
allocations as unresolved. Shared requirements and constraints flow to descendants;
local requirements flow only along allocated child branches. Effective references
keep the originating work id. Child notes cannot overwrite the inherited object.

Acceptance has its own stable id/version, requirement reference, scenario, expected
result and method. Evidence names acceptance id/version, requirement id/version,
codeVersion, actual result and locator; kind distinguishes machine,
source-behavior-review and owner-visual. Done requires evidence on the completion
candidate and no unresolved result for that candidate. A bare passed/ok label is
insufficient. Evidence of older versions remains stored history, not proof of a
new meaning. Machine linkage is **not semantic verification**; existing independent
review compares original source, actual behavior and assertions. Source extraction
claims and decision meaning still require that review; the engine cannot certify
their truth merely from a boolean, hash, summary or matching identifier.

## Changes and history

`workContentChangeImpact` derives affected live work and acceptance ids. Changed
requirement text, disposition, sources or constraints require fresh versions;
acceptance method/scenario/expected changes require its new version. Preserve a
removed requirement with disposition/decision rather than erasing its identity.
An approved content change needs `changeDecision`, an existing Owner-decided
`minutes:<id>#Dn` locator. Decision-source locators are resolved in the same project;
a reference proves linkage, not authorization semantics. Title/progress changes
never modify evidence. Terminal content is immutable; create a linked defect or
follow-up instead. Replay does not reapply today's live completeness policy.

## Scoped rollout

`work.contentPolicy` is an explicit project setting using existing settings-set
and readback. JSON shape: `schemaVersion: tcrn.work-content-policy.v1`, `enabledAt`,
`decision`, `scopeWorkIds`, `inFlightWorkIds`, `defaults` (all four kinds, each
`{templateId, templateVersion}`). Defaults must already be admitted v2 templates.
Empty scopeWorkIds selects all new work in that project; otherwise selected roots
and descendants only. New work after enabledAt receives the default binding even
when the caller omits it. Typed content is required, so old-style creation cannot
bypass policy. Explicit in-flight ids adopt content only on a related annotation
or continuation; unrelated metadata updates do not backfill old records. Terminal
history is never migrated. Unenabled projects keep their old writes and reads.
No production setting is changed by this implementation.

Actual old pre-INIT068 3.2.0 was independently observed accepting an enabled-project
new write when it omitted content/binding (CORE-01); explicit v2 refusal did not
protect that path. Therefore old-writer scoped compatibility is **failed**, not
established by this setting or template extension. No global minimum-version lift,
unrelated-project disablement or claim that all devices upgraded is made. The
upgrade-prerequisite amendment/architecture decision remains outside this repair.
Production rollout stays unverified. Existing old 3.1.0 behavior is not verified.

Core lifecycle checks are shared by create, annotate, work-batch and ready/active/
done transitions. Native implementation dispatch consumes the same start check;
legacy dispatch contracts lacking action retain explicit status-based semantics.


## Structural content versions and native change readback

Evidence has an optional `meaningDigest` while drafted or read as old history;
completion requires the exact per-acceptance structural content-version digest.
It covers the acceptance, its effective requirement/source and direct/inherited
binding goal, scope, constraints and type details. Unrelated requirements, title,
summary, progress and free body are excluded. This is a deterministic version link,
not a semantic verification hash. The engine computes an absent digest for newly submitted observations. An explicitly
supplied digest is never overwritten, including when stale or attached to changed
reference/candidate labels. Retained observations without a supplied digest retain
their stored binding; changing meaning does not automatically rebind evidence.
An actual new observation remains subject to independent source/behavior review.

Scope/constraint/type-detail changes list affected live descendants and evidence.
Identity comparisons include additions. Prior approval flags and source rows must
remain as provenance; append a superseding decision rather than erasing approval
to bypass later change protection. Terminal content remains immutable.

Native content annotations persist `advisory:work-content-impact` in the same work
event: prior/current content-write revisions, prior/current structural digests and
the authoritative impact list. It is read-only derived metadata, not another
requirements or acceptance source. Subsequent title/progress changes retain that
last content-change record; its currentRevision denotes the content-write revision.

New current-engine writes evaluate enabledAt against admission-time runtime clock,
not the caller's event timestamp. Existing historical records retain their recorded
timestamps and exemption; a future scheduled policy is inactive until its time.
This current-engine correction does not repair the observed actual old-writer gap.

## Library floor and project content opt-in

The prior actual old-3.2 omitted-binding failure remains a failed v1 requirement;
this amendment does not relabel it passed. `work.contentPolicy` v2 adds `rollout`
with the `tcrn.work-content-rollout-observation.v1` shape exported by
`work-content-templates.ts`. New setter writes of v1 refuse; v1 history reads
unchanged and is not asserted rollout-ready. Production rollout remains unauthorized
by this source change. No capable release V has been assigned here; current candidate
and observed old binary both report 3.2.0, so readiness cannot distinguish them by a
version floor. The factual unsupported 3.2.0 baseline cannot be omitted by a caller's
inventory. A higher number is not itself evidence of capability.

The existing library `engine.requiredVersion` setter is the only floor transport
used here. Its replay check runs after event materialization and before returning
an effective state, including fresh append preparation. The existing library
manifest `minEngineVersion` check runs in openLibrary before cache/append handling.
Readiness observes both, reports their maximum as effectiveFloor, and does not
require their values to be equal or rewrite the manifest. A synthetic future floor
also excludes the current candidate: that mechanism test is not actual V acceptance.
Unenabled projects keep legacy content rules but share the library access floor.

Rollout observations contain actual delivery/version/build evidence, an explicitly
complete writer/entry inventory, upgrade evidence and separate old-entry restriction
evidence, old-writer refusal plus no-effective-state-change evidence, and manifest
inspection evidence. Unknown writers, unresolved offline copies/direct sync, missing
observations or stale accepted boundaries keep enablement not ready. These are
structural evidence links, not authentication or proof that unseen writers do not
exist. Actual observation validity and inventory completeness still need independent
review; no platform control is fabricated.

The native setter refreshes the current library, checks the proposal against the
actual running FRAMEWORK_VERSION, manifest observation and current pre-enable
head/vector under its append planning/revalidation path. That exact accepted boundary
is stored in the native policy event, not inferred from caller-created timestamps.
V2 future activation requires a fresh boundary at the activation instant; a preview
is not a future permit. Existing v1 future-policy history remains unchanged.

Final native library reads additionally audit post-boundary stream sequences. An
unknown/below-capable post-boundary writer, or scoped post-boundary creation lacking
canonical content, refuses the effective candidate with WORK_CONTENT_BOUNDARY_CONFLICT.
Timestamps never grandfather such increments. The raw events are retained: diagnostics
require preserving the increment/conflict evidence, refreshing and semantically
reapplying on a clean accepted baseline through supported engine paths before shared
submission. No event is silently rewritten/discarded and this is not a cross-device
lock. A stream's recorded version is evidence, not authenticated execution provenance.

Removing a project policy does not alter the library floor. Historical v2 policy
boundaries retain the writer-version audit even after opt-out; scoped content checks
apply to enabled projects. Removing/lowering engine.requiredVersion below a historical
v2 capable requirement refuses with WORK_CONTENT_FLOOR_DOWNGRADE_UNVERIFIED; actual
new-data downgrade compatibility needs separate verification and authorization.
Actual capable-release, full host/writer/offline-copy and late-delta production
acceptance remain pending until suitable genuine artifacts and observations exist.

CORE07 correction: an explicitly supplied evidence.meaningDigest is preserved,
including reintroduced evidence or changed candidate/reference labels; it is never
automatically replaced with the current binding. An absent digest on a genuinely
new observation may be derived. Reusing a stable locator/result is not forbidden.
