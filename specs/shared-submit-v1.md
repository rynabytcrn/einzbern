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
