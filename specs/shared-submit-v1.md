# Shared submission v1

The scope is supported engine semantic work and one serial publication operation,
not a storage SDK, continuous synchronization service or distributed lock.

A complete baseline records identity, format, minimum engine, required closure,
included roots, explicit exclusions, complete path/size/digest inventory, unfollowed
link representations, optional archive witness, source version/head/vector and
capture/refresh times. Its inventory digest uses engine canonical JSON bytes.
Coverage unknown refuses submission. A bounded listing alone proves no closure.
These are supplied evidence observations, not an authentication of remote storage.

The ordered assessment is complete baseline, local engine semantic receipts,
one fresh complete baseline after local work, supported replay/reapplication,
current operation-specific writer handoff, segment publication, actual segment
bytes readback, manifest-last publication, actual manifest bytes readback,
independent complete-copy replay and record readback, then observed release.
A changed baseline requires re-evaluating revisions and supported semantic
reapplication. Stale parent hashes are never spliced or rewritten, and already
present results are not created again.

The module assesses receipts; it does not invoke arbitrary commands or synthesize
engine replay. Every producer remains the existing supported engine entry.
Publication member IDs, parents, exact paths, bytes and hashes must match actual
returned remote bytes. Unknown outcomes require querying the exact operation
before any retry. Local success does not imply destination success. A failed or
unknown release is pending-release, not free.

`artifacts/coordination/shared-submit/advisory.json` is one library-wide logical
locator, distinct from canonical events and configuration projections. The
supported read/write functions serialize on the existing local engine lock and
read back their own bytes. Reserved-root audit evidence is required. Roots inside
device storage or generated `dist` output refuse. The generic artifact store only
lists its top-level compressed blobs; this reserved child is not its blob member.
No new cleaner is introduced. Integration must preserve this root and classify it
outside generated outputs and configuration backups before exposing the writer.

An advisory communicates announced/waiting/submitting/released/unknown only.
Missing or old markers do not establish free/expired ownership. `previousDigest`
is a local observation consistency check, not remote compare-and-swap, fencing,
lease ownership, or atomicity. A different unreleased writer refuses. Only explicit
current handoff evidence can authorize a new operation; no timeout takeover or
marker deletion exists. No real advisory or remote publication was performed by
this implementation package.

The verified merge receipt also supplies the complete engine-output member plan.
Every published path, byte count, digest and segment/manifest kind must match it;
missing planned members cannot be silently omitted to declare completion.
Identical repeated provider returns can be retained idempotently. Conflicting
returns preserve the prior member set and the conflicting source for inspection.

## Installed complete closed JSON input

Both `shared-submit-plan --from-file <json>` and `shared-submit-evidence --from-file
<json>` consume SharedSubmitInput below. `shared-submit-advisory-write --workspace
<actual-library> --from-file <json> --actor <actual-actor> --handoff-evidence <ref>
[--timeout-ms <nonnegative-integer>]` consumes SharedSubmitAdvisory only. Readback
uses `shared-submit-advisory-read --workspace <actual-library>`. Paths and return
references come from actual engine/provider observations, not guessed names.

Notation is JSON shape, with primitive definitions from adjacent
`dot-execution-v1.md`: Sha, Ref, Instant, Int, RevisionBinding. `?` denotes an
omittable property; otherwise all fields are required, null only as shown. Every
object is closed except explicit maps. Counts are nonnegative safe integers.
Missing stages are explicit null/empty arrays and produce pending, never success.

```typescript
type SharedBaseline = {
  schemaVersion:"tcrn.shared-baseline.v1", libraryId:string, format:Int /*>=1*/,
  minEngine:string, canonicalRootRef:Ref, completeInventoryRef:Ref,
  completeInventoryDigest:Sha, requiredRoots:string[], includedRoots:string[],
  exclusionsWithReasons:{path:string, reason:string}[],
  inventory:{path:string, bytes:Int, sha256:Sha, kind:"file"|"link-raw",
    linkRepresentation?:string}[],
  archiveWitness:{ref:Ref, sha256:Sha}|null,
  sourceVersion:Int /*>=1*/, head:Sha, versionVector:{[streamId:string]:Sha},
  capturedAt:Instant, refreshedAt:Instant, coverageStatus:"complete"|"unknown",
  atomicSnapshot:false
};
type SharedSubmitAdvisory = {
  schemaVersion:"tcrn.shared-submit-advisory.v1", libraryId:string, operationId:string,
  holder:{actor:string, environmentRef:Ref},
  state:"announced"|"waiting"|"submitting"|"released"|"unknown",
  baseDigest:Sha, handoffEvidenceRef:Ref|null, observedAt:Instant, updatedAt:Instant,
  previousDigest:Sha|null, releaseEvidenceRef:Ref|null
};
type OutputMember = {exactPath:string, bytes:Int, sha256:Sha, kind:"segment"|"manifest"};
type PublicationMember = OutputMember & {
  providerId:string, parentId:string, actualReceipt:Ref, publishedAt:Instant
};
type SharedSubmitInput = {
  schemaVersion:"tcrn.shared-submit.v1", operationId:string, libraryId:string,
  actor:string, deviceStreamIdentityRef:Ref,
  workRefs:{workId:string, revisionBinding:RevisionBinding}[],
  baseBaseline:SharedBaseline, refreshedBaseline:SharedBaseline|null,
  localWorkCompletedAt:Instant, semanticChangePlanDigest:Sha,
  engineReceipts:{verb:string, actor:string, intentDigest:Sha, baseDigest:Sha,
    status:"applied"|"already-present"|"refused"|"unknown",
    receiptRef:Ref, readbackRef:Ref|null}[],
  merge:{kind:"engine-replay"|"engine-reapply", refreshedBaselineDigest:Sha,
    semanticChangePlanDigest:Sha, engineOutputMembers:OutputMember[],
    receiptRef:Ref, readbackRef:Ref, status:"verified"|"unknown"|"refused",
    observedAt:Instant|null}|null,
  writerHandoff:{libraryId:string, operationId:string,
    status:"confirmed"|"occupied"|"unknown", writerScopeRefs:Ref[],
    evidenceRef:Ref, baselineDigest:Sha, observedAt:Instant|null}|null,
  advisory:SharedSubmitAdvisory|null,
  publicationMembers:PublicationMember[],
  remoteReadbacks:{exactPath:string, providerId:string, parentId:string,
    contentBase64:string, observedAt:Instant, evidenceRef:Ref}[],
  replay:{libraryId:string, operationId:string, status:"verified"|"unknown"|"failed",
    receiptRef:Ref, readbackRefs:Ref[], memberSetDigest:Sha, observedAt:Instant}|null,
  release:{status:"observed"|"unknown", evidenceRef:Ref, operationId:string,
    observedAt:Instant}|null,
  lastError:{phase:string, message:string, outcome:"not-executed"|"unknown"|"failed"}|null
};
```

Library IDs are `library:` or `workspace:` followed by 24 lowercase hex digits.
Inventory/root/member paths are normalized relative paths: no empty, `.` or `..`
components, backslashes, colon or control characters. Required roots and inventory
are nonempty; required roots must be included and cannot be excluded. Link-raw
requires the unfollowed linkRepresentation; do not substitute target content.
completeInventoryDigest is SHA-256 of the engine canonical JSON inventory, not a
provider listing token. Obtain complete closure and actual source metadata from
the supported engine/library representation. A listing limit is not completeness.

Digest references use engine canonical JSON (sorted object keys, original array
order, compact JSON with exactly one terminal LF). semanticChangePlanDigest identifies the
actual semantic change plan, engine receipt intentDigest its actual operation,
and baseDigest identifies the complete base object. Use actual supported engine
operation results/readbacks for receiptRef/readbackRef; do not edit event hashes,
splice projections, fabricate a successful replay, or create existing IDs again.

The fresh baseline has the same library/format/minimum engine, nondecreasing
sourceVersion, and completes after localWorkCompletedAt. Merge observation comes
from actual replay/reapplication completion/readback, then the current writer
handoff is observed. Missing merge/handoff time remains pending. Required order:
local completion <= fresh refresh <= merge observation <= handoff observation <=
advisory observation <= every publication. Old or reversed receipts refuse;
never fill missing timestamps with the time this JSON was assembled.

The complete merge output plan includes both segments and manifests. Published
members match that plan exactly, under `akasha/`, with segment `.ndjson` and
manifest `/manifest.json` paths. Provider IDs and parent IDs are actual returned
identities, not local IDs. remoteReadbacks.contentBase64 is the actual returned
byte sequence, canonical base64; verify exact identity/path/parent/size/hash.
Every segment's readback follows its publication and precedes every manifest
publication. Every manifest is read back. Replay observes a complete consumable
destination copy after all remote readbacks; memberSetDigest binds the exact
publicationMembers array. Release must follow replay, match operation/evidence,
and agree with the actual released advisory. Unknown release is pending-release.

An announced advisory permits only preparation, not publication. Submitting needs
handoffEvidenceRef, released needs releaseEvidenceRef. Holder actor/environment,
library, operation and fresh baseline must match. Read the prior advisory before
writing: previousDigest binds only that local observation, not remote exclusivity.
Do not deduce current writer ownership from hostname, age, missing markers, local
lock acquisition or the existence of a prior successful operation. These commands
assess/persist bounded local evidence only; actual remote operations remain the
existing authorized tools and supported engine entries.
