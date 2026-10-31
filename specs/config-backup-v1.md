<!-- SPDX-License-Identifier: Apache-2.0 -->
# Allowlisted configuration backup and restore

This is a new shared protocol, not the retired full-home backup. Creating a package,
restoring a real device, scheduling a daily job and approving retention are separate
actions. Nothing in the implementation enables a scheduled task. No production
retention numbers or cleanup authorization are supplied by this specification.

## Authorities and selection

`collectConfigBackupPayloads` reads only explicitly selected logical keys from a
registered library/project pair and that device's machine-settings file. An explicit
`declarationScope` selects local project declarations or library declarations. It
never turns an inherited effective value into a new declaration. The source label
is preserved in the package; restoration to another declaration scope is unmappable.
The selection does not contain arbitrary filesystem paths.

The initial closed collection is:

- AGENTS user-owned outside fragments, identified by parsed outside-fragment index.
  Managed markers, the independent dot generated marker, mixed unseparable content,
  absolute paths and secret-shaped content are excluded. Generated bodies are not
  an alternative source of rule or variable values.
- Selected scalar keys in `CONFIG_BACKUP_SETTING_KEYS`. This conservative list
  excludes historical model/quota declarations, execution runtime, registry, identity,
  trust, leases, admission, arbitrary storage paths and all unknown keys.
- Selected variables, validated by the existing typed variable validator, including
  explicit type, value, description, export targets and optional order. An unsafe
  variable name or value is excluded whole, never echoed into exclusion diagnostics.
- Built-in rule IDs with version, enabled state and optional order, not their rendered
  text. Only actual local declarations are collected, never a fabricated disabled
  declaration for an absent or inherited rule. Unsupported rule versions are not
  guessed at restore time. Restoring a disabled declaration to an absent target is
  incompatible when the existing disable setter cannot create that declaration.
- Exactly portal.defaultLocale, portal.defaultPartition, portal.defaultTheme and
  portal.port. The existing machine-setting validators remain authoritative.
- paths.artifacts and paths.knowledgeArticles are logical remapping markers only.
  No old absolute path is copied. Remapping is a separate explicit operation, not a
  guessed destination. A partition absent from actual target discovery is unmappable.

Identity, credentials, OAuth, tokens, account authorization, cache, generated output,
whole machine-settings files, runtime ledgers and prior backup formats cannot be
included by expanding a request or approving a policy. Content screening is a
conservative refusal mechanism, not a promise to recognize every possible secret.
The operator must still select non-secret inputs.

## Canonical package

The immutable manifest uses `einzbern.config-backup.v1`, projectRef, random 128-bit
backupId and backupGroupId, hostnameLabel (display and safe), actual createdAtUtc,
sourceVersion (engineVersion, engineCommit, engineCommitStatus, artifactIdentity,
templateVersions), selectionDigest, manifestDigest,
state=verified and files. Each file records its logical key, relative member path,
category, bytes, SHA-256, permission description, mapping version and source digest.

Member names are `members/<logical-key-sha256>.json`. Duplicate keys/paths, alternate
case aliases, noncanonical paths, traversal, backslashes, control characters,
non-regular files, hard links and symbolic links are refused. Ancestors and opened
file identity are checked. No operation scans arbitrary home directories. This is
not a claim of hostile concurrent-filesystem atomicity or distributed exclusion.

Canonical JSON is UTF-8, recursively code-point-sorted object keys, compact syntax,
finite JSON values and array-order preserving. Files are sorted by member path.
manifestDigest hashes canonical JSON excluding only manifestDigest. selectionDigest
hashes the selected key/category/mapping/source-digest tuples. Payload digests cover
actual canonical payload bytes. Hashes detect corruption, not authorship.

A planning result has `integrity=not-verified`: its manifest is the proposed immutable
manifest, not evidence that an on-disk backup exists. Only actual member and manifest
readback, exact size/hash checks, semantic whitelist checks and absence of extra
files make `verifyConfigBackup` return `integrity=verified`. A manifest declaring
verified is never accepted on that declaration alone.

## Roots, binding and publication

The caller resolves an explicit existing dedicated reserved directory. It may be a
strict descendant of an actual project or generated-artifact root, or a disjoint
external directory. Project, library and generated roots themselves and their
ancestors are never reserved directories. Inside a library, only a strict descendant
of its actual generated-artifact root is eligible; library control, device, installed
engine, VCS, identity and credential trees remain excluded. Fixed library artifact
namespaces for shared-submit coordination, consolidation and relocation evidence are
also excluded, including before their writers create them. These are actual library
paths, not a global ban on same-named user directories. The CLI derives these
boundaries from the actual registry and effective artifact settings, never from
request-provided exclusions. Canonical paths and every ancestor reject symbolic links.

An in-tree reservation must be dedicated: it contains only the canonical
`.einzbern-config-backup-reserved.json` marker and the three backup areas (or is
initially empty). The existing policy decision still binds the exact reserved root;
no new configuration or approval source is introduced. After that policy is checked,
the writer creates and reads back the marker before creating areas, indexes or
packages. This marker is protection metadata, not authority, identity or a backup
member. A corrupt, linked or conflicting marker is never overwritten. Existing
external stores remain readable and receive protection on their next authorized
write; nothing relocates old packages automatically.

The repository's output reset/clean and output writers honor this explicit reservation,
preserving the marked root and its contents while cleaning unrelated output. Cleanup
does not rename a containing tree or recursively remove it: it rechecks reservation
ancestors and directory identity before individual removals, and new unplanned entries
fail closed. Output writers recheck before replacement. Format check/write likewise
preserve only canonical, closed backup-protocol members; unknown mixed source content
refuses that exemption. General source discovery and privacy auditing do not hide
reserved content. Invalid markers and unmarked legacy backup areas fail closed instead
of being deleted. An
external generator must likewise exclude the reserved directory; this protocol does
not control arbitrary third-party deletion, share a lock with every writer, or claim
hostile concurrent-filesystem or distributed atomicity.
Collection reads selected logical keys, never recursively walks the source tree, so
backups, staging, recovery and the marker cannot recursively enter another package.

The three areas are config-backups, config-backup-staging and config-backup-recovery.
Each uses `<safe-host-label>/<full-random-group-id>/<UTC-backup-id>/`. Full random IDs
avoid shortened-prefix aliasing. Hostname is a display label, never identity.

The device-local `config-backup-bindings/<group-id>.json` binds projectRef, group ID,
writerBindingRef, executionEnvironmentRef and display label. It is not packaged or
synced as part of a backup. An existing group with a missing/mismatched local binding
is unbound. Supplying the same hostname or copying an index does not recreate it.
The binding's environment reference comes from the caller's actual execution context;
it is provenance, not a claim of cryptographic identity authentication.

The group index is `einzbern.config-backup-index.v1`. It separately records active,
transaction and recoverable IDs and their metadata, policy reference/digest, revision,
updatedAt, lastError and syncStatus. Only unknown sync is currently emitted; no
remote verification transport is implied. The immutable package is never rewritten
to express publication/rotation state.

A local file lock serializes the one bound environment. It is not a cross-device
fencing token, lease or distributed lock. Untracked/conflicting entries refuse new
work. Before creating another package, an existing transaction must be reconciled.

Creation reserves a bounded staging transaction, writes unique private files, reads
all bytes back, publishes by a same-root rename, verifies the published package,
reads the updated active index, then moves an eligible old package into recoverable
storage and verifies that move before settling. Old packages remain until the new
one is verified and published. Unknown outcomes remain pending with the same ID.
`resume` reads the existing transaction rather than allocating a replacement.

An explicit `recover-failed` resume mode can preserve a nonpublished incomplete
staging directory in a bounded recovery slot. It inventories and reads back the
same ordinary files before/after moving, keeps its failure origin and never labels
it a verified backup. An absent source, ambiguous publication or unsafe boundary
stays pending. It is not permission to delete bytes or guess that a write never ran.

## Explicit retention policy

`einzbern.config-backup-retention.v1` requires every field:

- activeLimit, transactionLimit, recoveryLimit;
- maxPackageBytes, maxTotalBytes;
- retentionDuration, recoveryDuration, expressed as positive safe integer milliseconds;
- noChangePolicy, exactly skip or create;
- atLimitAction, exactly stop-new-and-report;
- retirementMethod, exactly verified-recovery-move;
- approvalEvidenceRef.

No count, size, duration or approval default exists. Schema validation returns
policy-valid or policy-unapproved; validation is not approval. A separately resolved
approval must match both the exact canonical policy digest and the evidence reference.
Test-only policy values in test source do not approve production operation.

retentionDuration is the minimum age before retiring an active original.
recoveryDuration is its explicit recoverability window. Recovery expiry does not
silently authorize deletion: an expired recovery or exhausted count/byte allowance
stops new creation and reports the needed safe exit. A move to recovery frees no
bytes and does not reset total occupancy. This protocol has no permanent-delete,
Trash-empty, age-based takeover or implicit old snapshot cleanup action.

`evaluateConfigBackupEnablement` is a pure prerequisite result for D4. It requires
actual whitelist/restore/retirement capability, bound group, exact approved policy
and separate enablement authorization. It creates no scheduler and asserts neither
future unlimited capacity nor remote synchronization. Each actual run still passes
the storage and capacity gates.

## Restore

`einzbern.config-restore-plan.v1` binds backup ID/manifest digest, exact target roots,
project reference and declaration scope, mapping version, actual target version,
permission digest, member bytes, target value/file digests, original-recovery location
and whole plan digest. Every item is unchanged, missing, conflict, unmappable,
permission-denied or incompatible. Exact engine/template identity is currently the
only supported mapping; other versions are incompatible, not silently migrated.

Apply requires the exact reviewed plan digest. It verifies the package and recomputes
the target/permission plan first, then rechecks each member and target before writing.
Original selected values are preserved through the same approved, bounded backup
protocol in an explicitly bound target-originals group. A source value that cannot
be safely preserved refuses that item. A missing target is recorded as missing,
not as an invented original. A pending original-backup transaction stops dependent
restoration. There is no bulk projection overwrite.

User fragments replace only their parsed outside slot, retaining all managed sections.
Governed scalar/variable/rule inputs call setWorkspaceSetting/removeWorkspaceSetting,
setVariable/removeVariable, enableRule/disableRule, and supported variable regeneration.
Device values call applyMachineSettingSet/applyMachineSettingRemove. Authority readback
follows the write independently; engine results retain actual event head/version.
Rules whose order cannot be reproduced by the supported setter are incompatible;
no temporary enable is inferred to manipulate a disabled rule.

The caller must preserve existing CLI model/Owner-decision permission checks per
logical item. Request JSON, a backup, a policy string and the approved plan digest
do not grant those permissions. A permission map is resolved from current authority,
not restored from a package. Existing supported managed writers may keep their own
ordinary original-file recovery copies under their existing contract.

Per-item applied/unchanged/skipped/pending/refused/failed receipts do not become
whole-plan success after partial work. A write exception is pending until readback,
not permission to blindly retry. Fresh planning is necessary after a target, version,
data, root, scope or permission change.

## CLI and Portal seam

`CONFIG_BACKUP_COMMAND_CATALOG` and `runConfigBackupCommand(command, values, context)`
are owned by config-backup-commands.ts. The integrated CLI retains strict parsing,
registry resolution, authority checks, output guards, canonical JSON and error mapping.
The handler never imports CLI index and cannot execute arbitrary commands.

Plan/create/resume/retire/restore take an existing private --request JSON file.
--output, when supplied, is private create-new only. Verify takes --package; list
accepts optional --root and requires --at. No root means not-scanned, not empty.
Mutating commands are create/prepare/commit/resume/retire/restore-apply; all other commands are reads.
The ten closed command names are the ones declared in the module catalog.

Portal exposes only GET /api/config-backups. It calls public config-backup-list with
the explicit server startup --config-backup-root; browser requests cannot nominate
paths. No startup root yields not-scanned. The existing Storage settings surface
shows active/transaction/recoverable counts separately, measured package bytes,
completedAt separately from scannedAt, integrity and unknown sync. Empty, unreadable,
missing-index, corrupt and unscanned remain different. There are no restore/upload
controls or remote-online panel. All five existing locales and existing design-system
component families are reused.

## Running source identity and policy authorization

The implementation review refines the candidate sourceVersion, not the approved
backup scope: Owner-approved v2 sections 9–10 require a source version and canonical
content digests, and explicitly say digests do not authenticate a publisher. A
mandatory 40-hex commit was a design-freeze engineering assumption, not an Owner
requirement. This candidate keeps commit when genuinely known; the existing release
format provides none, so public CLI records engineCommit=null and
engineCommitStatus=unknown rather than guessing a checkout HEAD.

The public CLI resolves its own import.meta.url, requires the real packaged
scripts/einzbern.mjs layout, and matches the running FRAMEWORK_VERSION to either
the adjacent existing release manifest or the device's current installed version
and its exact canonical tree. The installed tree deliberately has no retained
release manifest; no new installer metadata is introduced. The existing
computeInstallTreeDigest and verifyInstallTree perform two actual same-tree reads.
Only equal digests, including the actual running bundle, yield artifactIdentity
{kind: observed-artifact-identity, schemaVersion: einzbern.install-tree-digest.v1,
sha256}. This is local observed content identity and corruption/stability detection,
not signed release provenance or protection from a malicious runtime. Source and
dist/build modules, missing identity/version bindings, invalid layout and unstable
content refuse CONFIG_BACKUP_ENGINE_IDENTITY_UNAVAILABLE or the existing strict
filesystem/JSON failure. No uploaded request supplies this identity. Restore still
requires exact sourceVersion equality and preserves incompatible outcomes.

Retention approval reuses the existing valid Owner decision boundary, not a new
policy database. The policy approvalEvidenceRef is a minutes:<id>#D<n> citation.
Its current valid decision, decided with owner:governance, must name the exact
colon-separated target config-backup-policy:<policyDigest>:<scopeDigest>. The
scopeDigest is canonicalSha256 of {projectRef, backupGroupId, reservedRoot,
writerBindingRef, executionEnvironmentRef}; policyDigest covers the complete policy,
including its evidence reference. The executing device must already exist and the
executionEnvironmentRef must equal device:<deviceId>. No identity is created and
no request approved boolean is accepted. A missing, obsolete, mismatched or
non-Owner decision leaves policy-unapproved; this batch approves no production
retention values. Restore additionally checks each existing setting/rule/variable
write permission through --decided-in. Preview and the approved plan digest do not
grant write permission.

Independent acceptance must cover the actual packaged CLI positively and reject
source/dist, wrong-version, missing-identity and changed-tree cases. Authored source
or fixture coverage is not evidence of package execution or E4 completion.

## Review-round consumer clarifications

No-change skipping requires a freshly verified previous manifest with both the
same selectionDigest and compatible exact sourceVersion. Equal selected values
under a different observed engine artifact are not recoverable originals for
this running version. Restore re-verifies the retained originals' actual bytes,
selection and sourceVersion before any target write; capacity refusal stops the
restore rather than treating an incompatible prior package as protection.

Manifest identifiers, sourceVersion fields, enums and digests must have their
actual declared JSON types. A single-element array that string-coerces to a valid
identifier/hash is invalid even when its manifest digest has been recalculated.

Independent dot AGENTS is not a user fragment or a generic rule projection.
Restore classifies user/rule file operations against that target as unmappable;
supported setting/variable declarations can be restored through the existing
authority but full projection refresh reports independent-dot maintenance pending.
No generic writer appends blocks or changes dot provenance. Traditional scalar,
variable and rule restoration refreshes the affected registered projection set;
unavailable/disabled/independent/user-decision targets remain pending, not rendered.

Existing transaction/index updates retain bounded safe machine reason codes on
pending/capacity failures. A failed reason persistence/readback is itself unknown,
not success. List results expose transactionPhases separately from integrity,
counts and synchronization unknown. Portal shows those phases, actual project
reference and retained errors in its existing read-only definition list. Hostname
is only a label and cannot collapse different project/group identities.

During `rotation-pending`, an active index entry named by `retirementBackupId`
may still be in active storage or may already have moved to recovery before the
index settles. List resolves these two permitted locations, requires exactly one,
and verifies/measures that physical package once. It does not settle the index:
counts and transaction phases still describe the parsed durable index, and
pending remains `discovered`, not `verified`. Missing/duplicate locations or bad
bytes remain errors. After parsing and binding the index, later package errors
retain its project, counts and phases; incomplete byte measurement stays null.
This does not relax no-symlink reads or change resume/retirement authority.

## Explicit remote-staged publication

`config-backup-create` keeps its local immediate publication contract. It does not
establish remote durability. Use `config-backup-prepare` when remote raw-byte
verification must precede promotion and retirement. Its closed request is `{selection, store, backupId, expectedSelectionDigest, plan}`.
Plan is the complete original `config-backup-plan` result retained in this existing
private request before any transaction writes. The CLI recomputes the plan from the
actual selected declarations and running source identity, using the original plan's
backupId and createdAtUtc, and requires exact canonical equality. No supplied
sourceVersion or payload can override the real source. Future plan times refuse.
The immutable timestamp remains the original snapshot-plan observation time;
physical preparation/verification/commit times are separate. Plan accepts optional
backupId to reproduce an explicitly retained ID; omitted IDs remain random. Do not
call a new plan with a new ID to replace an unresolved transaction. It writes
and verifies the canonical package in staging, retains the old active unchanged,
and returns pending with `remote-verification-required`. The transaction records
`remote.phase=prepared`; ordinary resume cannot promote it. Duplicate preparation
queries the same ID, requires verified bytes and the exact original manifestDigest,
selection and source version, and never allocates a replacement. Different in-flight work remains pending.

`config-backup-commit` takes `{store, mode, evidence}` with mode `begin` or `complete`
and the normal request/at/output/timeout flags. These are mutating commands. They
reuse the existing policy and binding authority; evidence grants no authorization.
There is no provider SDK, transfer, authenticated remote session, background job,
new identity, distributed lock or synchronization claim in either command.

### Evidence and trust boundary

Begin evidence has the exact fields:

- schemaVersion=`einzbern.config-backup-remote-begin.v1`;
- backupId;
- locations: `{destinationRef, stagingAreaId, activeAreaId, recoveryAreaId}`;
- replacement: package observation in the transaction/staging area;
- original: package observation for the eligible old active, or null when none.

Area IDs must be distinct. Each package observation has exactly `packageRoot`
(absolute local directory containing downloaded original bytes), `backupId`,
`manifestDigest`, `packageId`, `packageParentId`, `membersDirectory`, `areaId`,
`files`, `verifiedAt`, and `evidenceRef`. MembersDirectory is exactly
`{id, parentId, name}` with name=`members` and parentId=packageId. PackageParentId
must equal the expected concrete group-area parent ID (not merely an area label).
Every file observation has `path`, `id`, `parentId`, `bytes`, `sha256`, `publishedAt`,
and `downloadedAt`. Include each manifest member and `manifest.json` exactly once,
without extra/duplicate paths or IDs. Manifest parentId equals packageId; each
`members/<hash>.json` parentId equals membersDirectory.id. Package, members directory,
file IDs and all area IDs must not alias; original and replacement IDs are disjoint.
Names, sizes
and hashes must match the downloaded bytes. The manifest must have been published
no earlier than its members. Publication precedes download, download precedes
verification, and all readbacks fall after the applicable transaction/action
boundary and no later than the command's `at`.

The engine runs `verifyConfigBackup` itself against packageRoot, verifying whitelist,
manifest semantics, exact member set and byte integrity. It does not trust a supplied
`integrity=verified` flag; that field is not accepted. IDs, destination, observations
and their association are still caller-reported evidence, not provider authentication.
A successful validation detects inconsistent evidence and bad bytes; it cannot
prove an external action took place or distinguish an honestly downloaded file from
a local copy. The authorized caller must retain actual tool returns and downloaded
original bytes, not manufacture observations from desired state. Raw receipts remain
caller-owned evidence, never automatic public or backup-package content.

### Begin, remote action, complete

Begin rechecks local originals/stage, approved policy, retention age and capacity,
validates the fresh remote observations, then durably records `commit-pending`,
`beginDigest`, `begunAt`, locations and compact package/file identity digests. It
returns pending `remote-commit-query-required`, not transfer success. Identical
begin is idempotent; a conflicting receipt cannot replace its intent.

Only after this explicit intent may the authorized caller move the verified old
remote active into the bounded recovery area and verify/read it back, then promote
the verified remote transaction package into active and verify/read it back. If
there is no original, promote only. Use the recorded package/member IDs; do not
re-upload under new identities to conceal unknown outcomes. The engine does not
perform these actions. A plan or receipt does not expand the caller's permissions.

Complete evidence has exactly `schemaVersion`=
`einzbern.config-backup-remote-complete.v1`, `backupId`, `beginDigest`, `replacement`,
`original`, `retiredAt`, and `promotedAt`. Its package observations use the same
shape, but replacement is now in active and original in recovery. RetiredAt is null
only when no original exists. The old recovery readback/verification must precede
new promotion; each new download is at or after its corresponding action. Actions
cannot precede begunAt. Original and replacement package/members-directory/member identities and
bytes must match begin. The engine re-verifies downloaded bytes and retained local
originals/stage, records `complete-validated`, and only then permits local promotion,
retirement and index settlement. No caller can set syncStatus to success; it stays
unknown because package receipts do not certify whole-store synchronization.

Resume before complete validation returns pending without promotion. After complete
validation, resume can reconcile interrupted local publication, rotation and index
writes under the existing same-ID transaction. Both source and target present is
ambiguous, never success. `recover-failed` refuses all remote-staged transactions, including prepared: a
prepared marker does not prove uploads never started. There is no remote abort or
authorization to delete remote bytes. Partial/unknown uploads retain same-ID query
responsibility rather than being quarantined to admit a replacement. Unknown
remote effects require querying the recorded IDs before submitting new evidence;
missing response is not permission to create another backup.

Compact begin/complete digests and completedAt remain on the resulting stored
package row; identical repeated complete is unchanged, and conflicting completion
is pending. Records follow the existing bounded active/recovery lifecycle, with
no append-only evidence history or sidecar directory. Each remote transaction
reserves 4096 bytes of metadata capacity before staging. Before begin is persisted,
the engine measures canonical UTF-8 bytes (including JSON escapes) of the worst-case
complete-validated intent plus its coexisting compact completion row. Completion
uses the maximum accepted UTC timestamp precision and digest lengths. Their sum
must fit that reservation; oversized evidence leaves the same prepared transaction
pending. Loaded intents enforce the same bound, so complete cannot add unreserved
metadata. A matching compact row during a local interrupted settlement is covered
by its transaction reservation; after that transaction is removed its actual bytes
count separately. Matching same-ID package records during settlement count physical
package bytes once; inconsistent duplicates refuse. Stored historical compact
completion metadata continues to count actual canonical bytes toward maxTotalBytes. Raw request evidence has a 1 MiB structural limit. These are protocol
bounds, not production retention defaults or approval.

Existing v1 indexes without remote fields are unchanged. New optional closed
transaction `remote` and package `remoteCompletion` fields make old engines reject
these new indexes rather than silently lose the barrier. Downgrade does not migrate
or erase the fields; use a compatible reader. Immutable package format/sourceVersion
is unchanged. List continues to expose a pending transaction as discovered rather
than claiming remote synchronization. Configuration packages are not whole-machine
or account/identity recovery.


### Same-ID incomplete local preparation repair

`config-backup-resume` also accepts `{store, mode: "repair-staged", plan}`. The
original plan is read from the persisted private prepare request, not lost process
memory or a fresh selection. It must reproduce the exact original manifestDigest,
backupId, group, sourceVersion, selection and reserved byte count. The mode applies
only to remote prepared/staging transactions, never a commit-pending publication.
It first inventories the existing package and verifies every existing expected
file against the canonical plan. Extra files, changed/partial bytes, links, wrong
plans or ambiguous active/recovery locations refuse before the first new write.
Only missing directories/members/manifest are created, with create-new semantics;
no original is overwritten or deleted. Repeated complete repair is idempotent.
The official verifier runs after repair and the result remains pending remote
verification, not active, synchronized or externally unpublished.

Current source changes cannot silently replace missing historical values. Initial
prepare rejects a plan that no longer equals current declarations/version; repair
instead uses the exact already-bound original plan, even if current source has
changed. The plan carries only the original validated whitelist payloads; it is
private request/evidence content and must not be published with code. No durable
plan sidecar or extra payload copy is added to the backup group, and repair cannot
increase the existing transaction's package reservation. The caller preserves its
existing private original request through settlement. This is not permission to
accumulate unbounded plan snapshots outside the retention contract.

Loss/corruption of that original request, conflicting partial files, changed
approval/binding or an ambiguous external commit remains pending with the original
failure. This version cannot fabricate lost values or overwrite conflicting bytes.
It offers deterministic missing-file recovery, not automatic recovery from every
possible corruption; preserve those cases for a separately supported recovery path.
