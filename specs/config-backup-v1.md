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
engineVersion, engineCommit, templateVersions, selectionDigest, manifestDigest,
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

The caller resolves an explicit existing reserved root disjoint from the actual
library, project, device, generated-artifact and destructive-output roots. Its only
three areas are config-backups, config-backup-staging and config-backup-recovery.
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
Mutating commands are create/resume/retire/restore-apply; all other commands are reads.
The eight closed command names are the ones declared in the module catalog.

Portal exposes only GET /api/config-backups. It calls public config-backup-list with
the explicit server startup --config-backup-root; browser requests cannot nominate
paths. No startup root yields not-scanned. The existing Storage settings surface
shows active/transaction/recoverable counts separately, measured package bytes,
completedAt separately from scannedAt, integrity and unknown sync. Empty, unreadable,
missing-index, corrupt and unscanned remain different. There are no restore/upload
controls or remote-online panel. All five existing locales and existing design-system
component families are reused.
