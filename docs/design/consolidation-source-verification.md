# Consolidation source verification: device-local records

The materializer can reuse previously validated event projections on a narrowly
eligible macOS path. The public source-event API and genesis reader still read
source files. This is an implementation with explicit fallbacks, not a claim
that every filesystem, provider or release acceptance criterion has passed.

## Trust and storage boundary

`device-home.ts` keeps identity, registry and installed engines in `deviceHome`.
`storage-location.ts` redirects `runtimeHome`; `storage-configure.ts` moves only
cache, locks and backups. Consequently an existing runtime cache can share a
provider and writer with the library. Its checksum cannot establish prior
verification. The C2 forgery below remains a valid counterexample to that design.

The materializer places a small record at
`<deviceHome>/source-verification/<library>/<segment-key>.json`, alongside the
existing local authorities, bypassing `runtimeHome`. Compressed event projections live
at `<cachePath>/verified-segments/<segment-key>.bin` and remain untrusted. No
secret, credential service, account, issuer, key store, permission change or
resident process is involved.

Before reading or writing records, the engine resolves actual device, library,
configured library/runtime and cache paths. A record directory inside a source
or configured synchronization/runtime subtree, an alias into the record store,
a linked record directory, an invalid/missing device identity, or an unresolved
boundary disables this optimization. Record names come only from engine-hashed
library/source/stream/segment identities; event bodies, source metadata and cache
payloads cannot supply a destination. Normal source/sync ingestion and runtime
relocation have no write path into this separate directory.

This uses the same integrity assumption as local identity, registry, engine and
configuration. It is **not an OS permission boundary** against a process or user
already able to edit those local authorities, including an arbitrarily
compromised synchronization process. A checksum detects accidental record damage;
it is the independent placement and writer scope that distinguish the record
from the untrusted cache. Local record loss is harmless: full verification
rebuilds it. Engine/projection/device/boot/mount changes invalidate matching
records. Cache loss or corruption also requires full reads. Entries are bounded
by segment keys, overwritten after re-verification, and never transported by the
storage relocation API. Removing this local record directory disables reuse
until the next successful verification; it contains no unique source truth.

## Proof used by the reader

The system JXA host runs the packaged, core-owned
`packages/core/src/darwin-source-identity.mjs` in short-lived
batches covering the operation's held source objects. A metadata-only pass
opens at most 128 Node descriptors; larger inputs retain the complete original
reader. Two helper invocations cover the operation, including all sources. The
helper opens metadata descriptors with `O_NOFOLLOW | O_NONBLOCK`, uses file and
volume attributes from that same descriptor, then closes it. Its real device,
file ID and length must exactly match the original Node FD. That original stays
open throughout the operation; final name, descriptor stat and native generation
checks must still agree. Pipe-only stdio transfers no caller output or source FD
and satisfies the unchanged test controller. It uses Foundation and a C bridge to
`fgetattrlist` and `sysctlbyname`. The normal build copies the helper and the
release bundler carries its bytes through the normal relative resource URL.
The normal build places this resource beside its core consumer; the same local
URL works in an ordinary build and in the release bundle. Runtime does not
compile code or require Python, developer tools or a service.
A missing resource, failed host or five-second timeout returns to the original
reader; after a host failure the rest of that operation does not repeat it.

Both descriptor queries must agree on a real boot UUID, filesystem/mount
identity, nonzero volume UUID, file object ID, nonzero generation, length, flags,
provider resource identity and download state. Returned attribute masks and the
volume's supported masks must satisfy the exact requested fields. Only a local
volume, a single-link regular source, a name still identifying that held object,
and a stable descriptor stat qualify. Generation zero (including active mmap),
dataless flags, unsupported attributes and network volumes do not qualify.

Provider eligibility is **per file**. A positive Foundation ubiquitous-item
response requires `DownloadingStatusCurrent`, `isDownloading=false`, a resource
identity and no download/resource error on both queries. Foundation normally omits
iCloud-only keys for ordinary files. Those files use the descriptor's supported
nonzero generation, resident-data flags, per-file resource identity and stable
before/after checks. No known download/error indication is allowed. Missing keys
do not establish that a provider is absent: native unchanged-resident-data proof
is the basis, independent of which provider may manage that file. Missing resource
identity, an actual resource lookup error or unsupported native proof retains the
full reader. No global FileProvider assertion is introduced.

A local record binds the device identity, root library and source IDs, archive
position, stream/device/segment identity and event identity scheme, committed length/digest and coverage,
root/source manifest digests, prior stream manifest/head/vector, a digest of the
complete verified index/head/vector metadata tree, native identity, engine and
projection versions, and the compressed event projection's length and SHA256.
The cache must have its recorded length and hash under that independent record. A shared writer can
recompute an ordinary cache checksum but cannot update the record through its
source/cache input paths.

First verification still performs canonical segment parsing, source digest,
event identity, payload/event hash, chain and clock checks. Only that parsed
result can become a projection, and only after the complete stream head and
full authority replay succeed. On reuse the independent local record authenticates
the compressed projection; its digest is checked before decompression and parsing.
Repeated canonical serialization and per-event hash rebuilding inside that same
unchanged segment are unnecessary. Every cross-segment link/clock, current stream
head, index, source vector/head and authority binding remains checked. The native
descriptors stay open through the operation and must match both their names and
their before identities afterward; a mismatch reruns the original full reader.
New records are never issued from a replay checkpoint alone. A read that stages any new record bypasses prior
replay seeds throughout that materialization. Rejected authority does not issue
records. Cache/record failures do not suppress a source error.

On append, a segment descriptor or native generation that changes forces a full
read of that entire segment, including its old prefix. New segments are read
whole. Unchanged old segments can reuse their independently verified projections;
the current segment boundaries, stream head and index/authority checks still run.
The record keeps the metadata context under which verification originally
succeeded, while append does not require the *old* stream head to remain the
current head. The actual reader's stream ID and identity scheme must also match
the prepared descriptor binding; metadata changes between preparation and reading
cannot reuse an older identity contract. A new flat consolidation generation changes its root binding and
requires verification before it can establish new records.

## Evidence and resource accounting

Native regression tests exercise the complete materializer with real held-object
FD/native attributes and a clearly controlled provider response on local
fixtures. They cover unchanged reuse, append/rollover, relocated runtime, unsafe
device placement, record/cache loss and corruption, device/library/source/
engine/projection/boot/mount/volume/generation/coverage mismatches, unsupported
attributes, generation zero, network/download/unknown-provider fallbacks,
helper absence/failure/timeout, tampering, replacement, rename, hardlinks and
concurrent change. Controlled provider or boot/mount tests are not real
hydration, reboot or remount experiments.

The preserved C3 actual provider-backed reads through a private device directory and
truly independent processes observed 83 eligible segments: a cold read consumed
134,522,127 source bytes; each of two restarts consumed zero source bytes and
153,966,535 cache bytes. Complete normalized states matched the full genesis
reader. These are actual byte-reuse hits, with cached history explicitly counted.
C3 did not skip parsing or validation and regressed total wall time. These
historical samples are not C4 measurements, a production SLA, a P50/P95 claim or
proof of every platform branch. C4's paired measurements are retained separately.

Observation separates source bytes delivered to the process by stream/scope, cache
bytes, local record bytes, helper script/request/response bytes and helper wall
time. Reducer/operation/process CPU and elapsed spans are separate and must not
be added to overlapping spans; helper child CPU/RSS requires independent process
measurement. OS I/O, network traffic, provider-daemon CPU, real OS reboot,
unmount/remount and controlled partial hydration remain unknown unless a
specific experiment measures them. Source byte reduction is not automatically a
reduction in total bytes: this path reads cached history and record metadata.
Private raw evidence stays outside the distributable source and contracts.

## Preserved C1/C2 history

The following is the earlier C2 investigation and its limitations at that time.
It is retained as history; its unimplemented/gate-failure statements describe C2,
not the current normal build or this implementation.

The source baseline is `a97217705a2f0f5bebaa288f1e9da83496cb315d`. C1's
Story 647 delivery, its incomplete Story 648 history, and the earlier B/645
failures remain separate historical results. C1's 25-event whole-process CPU P95
remains **10,929 us with checkpoint versus 10,236 us from genesis**. Reducer work
saved by 647 does not establish a whole-process CPU benefit.

### Native attributes and actual per-file observations

Apple's [getattrlist contract](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/man/man2/getattrlist.2)
permits descriptor queries, describes volume attribute support, and defines
nonzero generation equality for the same object. Zero cannot prove unchanged
data; mmap makes the generation unavailable. The extended option is required.
The SDK's `sys/attr.h` and the returned attribute sets must also agree with the
request. A successful syscall alone is insufficient.

C2 used the host's existing Command Line Tools to compile a short-lived C
bridge. Node inherited already-open descriptors into that bridge. It queried
`ATTR_VOL_ATTRIBUTES`, checked complete returned fields, and queried generation,
file ID, filesystem identity, flags and length on those descriptors. The tested
APFS volume returned the requested attributes. An in-place edit changed
generation 2 to 4; an active mmap returned 0, and unmapping returned 4. A held
descriptor retained the old object's identity during a same-name replacement;
its directory entry no longer identified that object. Hard links failed the
single-link condition. These are actual observations, not an unsupported-volume
assumption.

A separate short-lived Foundation/FileProvider bridge queried the actual
archive and actual device cache. Both positively resolved to the **same Google
Drive provider domain**. Both reported downloading status `Current`,
`isDownloading=0`, and nonzero generation values. Provider metadata was available
for these particular files. No global absence of provider activity was required
or inferred. The local fixture's lookup failed and its download keys were
absent; that result remained unknown. The
[FileProvider lookup contract](https://developer.apple.com/documentation/fileprovider/nsfileprovidermanager/getidentifierforuservisiblefile%28at%3Acompletionhandler%3A%29?language=objc)
does not turn a lookup error into evidence that another provider cannot manage
the item.

These observations do not establish an atomic provider/download barrier or a
permission to skip reads. No OS reboot, unmount/remount, real partial hydration,
or unsupported-volume experiment was performed.

### The receipt authentication gap

The existing writer scope is concrete:

- `device-home.ts` resolves library caches through `runtimeHome`.
- `storage-configure.ts` can relocate those caches into the configured runtime
  under the shared library; `shared-library-v1.md` documents that placement.
- `library-cache.ts` writes derived snapshot state and a header naming its
  SHA256. Its reader verifies shape, library identity and that digest. It does
  not authenticate a writer of a prior source-verification receipt.
- Native per-file lookup confirmed that the live snapshot header is actually
  provider-managed alongside the archived source. Both had the same uid and
  ordinary writable-by-owner mode. This is an observed shared writer scope,
  not an inference from a folder's name.

C2 reproduced a failure on isolated copies using the existing runtime relocation
API. A deliberately rejected experiment first fully validated a source and
stored its old valid bytes and a receipt. The receipt bound library, source,
segment, boot, mount/fsid, volume, descriptor/file identity, generation,
length/digest, manifests, index, head, vector, projection, engine, cache format
and checkpoint. A source/cache writer changed the same source object in place,
restored mtime to the exact nanosecond, updated the public generation/stat
binding, and recomputed the receipt checksum.

The real full reader rejected the source with `AKASHA_EVENT_CORRUPT` /
`payloadHash`. The rejected receipt reader, exercised through the real
`materializeLibrary`/Akasha `ReadBytes` seam, matched those public bindings before
and after its read and accepted the old cached events. It returned the original
state while concealing corruption in the physical source. No permission was
changed and no private writer authentication was involved. This experiment
isolates receipt authentication; it does not assert provider eligibility or ship
an alternate reader.

Hashing cached history does not repair the false claim that old bytes describe
the current source. Nor is that read free: the experiment read 2,775 history
bytes and 2,142 receipt bytes to conceal one 2,775-byte source read. Its five
complete helper processes used 6,716 CPU us and 10.484 wall ms. This is a
counterexample, not a performance result.

The derived cache cannot become a source-verification credential issuer on the
strength of its checksum and public generation fields. A new authenticated,
device-local issuer would need an explicit writer/secret-read boundary and a
storage/lifecycle/recovery contract. Neither source synchronizers nor another
writer of the existing cache may silently acquire that authority. C2 introduced
no key store, permission change, trust switch, service or platform extension to
create that boundary.

### Actual behavior and resource evidence

C2 compared the real CLI parser/output and `materializeLibrary` with the existing
genesis reader on identical fixture libraries. The 29 scenarios include warm and
cold device caches, independent process restart, active append, a new segment,
additional live source streams, a supported new flat consolidation generation,
cache damage/identity/version/projection mismatches, same-length tampering with
exact mtime restoration, replacement/rename/hardlink/mmap, truncation,
head/vector/index mismatch, and mutation after descriptor open. Successful
normalized states and CLI results matched; negatives rejected in both readers.
Direct source event API coverage additionally verifies that its actual archive
bytes are still read after a warm checkpoint.

All 648 credential hit counts were **zero**. The warm three-source fixture read
38,205 source bytes in both modes: 9,192 live bytes plus archive reads of 9,192,
9,915 and 9,906 bytes. Its CLI physically read 21,383 cache bytes and 12,480
metadata bytes. The full-replay CLI read 1,453 cache bytes and 12,836 metadata
bytes. An independent restart of the new flat generation read 39,672 source
bytes even though its 647 checkpoint avoided replaying events.

One warm CLI pair measured 40,904/43,967 operation CPU us, 33.988/28.711 operation
wall ms, 157,977/157,352 complete-process CPU us and 138.742/128.128 lifecycle wall
ms, checkpoint/genesis respectively. This is one instrumented fixture pair, not
a P50/P95 claim or a production speed improvement. `wait4` measured process peak
RSS separately; OS I/O bytes and network traffic were not measured. Per-source
hash/validation CPU, inclusive metadata spans, cache hashing and replay CPU are
retained separately. Per-source wrapper spans include probe overhead and must
not be added to their enclosing operation/process spans or equated to the
narrower internal observer counters.

The final bridge-digest-bound three-descriptor query used 1,010 complete-child
CPU us and 1.667 wall ms, returning 2,584 protocol bytes. The provider query used
8,609 CPU us and 60.337 wall ms, returning 1,524 protocol bytes. `wait4` includes
startup and termination. Executable-page I/O and the existing provider daemon's
CPU were not measured. Earlier helper samples remain separately retained. These
were diagnostic executions; production invoked neither helper.

### Validation and unfinished acceptance

The focused consolidation/cache/authority/Recall tests passed **48/48**, including
two new regressions for a checksum-valid cache claim and the source event API.
Required build, format, lint and release-packaging entry points each failed
before their gate because this new worktree has no `typescript` dependency. No
dependency was installed or borrowed. Node's native type erasure produced a
separately labeled runtime for behavioral tests and the normal CLI; it does not
replace the required typecheck/build or packaging checks.

The matrix is full-read preservation evidence. It is not proof of an incremental
credential consumer, helper discovery/failure/timeout fallback, controlled
boot/mount credential mismatch, or real provider partial-download handling.
Story 648 R01/AC01 remain unmet: no authenticated persistent receipt was
established and no source-byte fast path survived a process restart. R02's full
verification is retained; safety checks are not weakened to claim completion.
