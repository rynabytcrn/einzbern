# Consolidation source verification: Story 648 C2

This investigation does **not** implement or accept Story 648. The normal CLI,
Consolidation reader and source event API continue to read and verify source
bytes. A replay checkpoint hit is not an incremental source read hit.

The source baseline is `a97217705a2f0f5bebaa288f1e9da83496cb315d`. C1's
Story 647 delivery, its incomplete Story 648 history, and the earlier B/645
failures remain separate historical results. C1's 25-event whole-process CPU P95
remains **10,929 us with checkpoint versus 10,236 us from genesis**. Reducer work
saved by 647 does not establish a whole-process CPU benefit.

## Native attributes and actual per-file observations

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

## The receipt authentication gap

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

## Actual behavior and resource evidence

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

## Validation and unfinished acceptance

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

Private evidence is rooted at the platform workspace, under
`.tcrn-artifacts/initiatives/init090-takeover-20261111/c2-incremental/`:

- `worker-*-live*.json`: this worker's installed-engine reads.
- `native-fd-matrix-final.json`: native attributes, per-file provider observations,
  bridge artifact digests and complete-child resources; earlier samples and the
  bridge source are retained beside it.
- `unsigned-credential-counterexample.json` and `fixtures/unsigned-credential-counterexample/`:
  rejected experiment, original/corrupt input and honest/forged receipts.
- `matrix-results.json`, `matrix-samples/`, `fixtures/cases/`: all differential
  results and inputs; invalid fixture setup attempts are retained separately.
- `resource-summary-selected.json`, `per-source-resource-summary.json`: physical
  bytes, component spans, replay and complete-process resources.
- `c2-focused-regressions.json`, `required-*.json`, `source-runtime-emission.json`:
  commands, output, failures and the distinct runtime preparation basis.
