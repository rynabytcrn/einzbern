# Independent dot rules and installation v1

SPDX-License-Identifier: Apache-2.0

## Scope and boundaries

`chatgpt-dot` is an installation target, not a `HostHookHost`, execution mode,
actor or native provider identity. Omitting `SetupOptions.executionTarget` keeps
the traditional setup path and its receipt shape. The explicit dot path supports
fresh, update, repair and uninstall. It rejects migrate and restore rather than
expanding non-Codex migration or calling traditional hooks or skill copies.

The caller must already have a readable, authorized engine and Mana entry. Dot
setup references those exact files; it does not fetch/install an engine, register
an identity, initialize/restore a library, copy a skill into another host, write
host permissions, install hooks, enable a rule or dispatch work. Engine updates
remain separate authorized engine operations. No `dot.adapter` framework is
introduced. A supplied source or local digest is an observation, not platform
identity authentication or proof that code ran.

## Explicit target and source

`DotAgentsOptions` has a closed validator. `executionTarget`, supported
`operation`, UTC `at`, `binding`, `source`, `enginePath`, `manaSkillPath` and
`preInjection` are explicit. The binding contains one existing canonical `root`,
its `AGENTS.md`, separate absolute `provenancePath` and `backupRoot` within it,
`projectReference` and `ownerId`. The caller selects these paths, not a filesystem
search. Symlink components, traversal, mismatched roots, overlapping output and
recovery paths, and metadata/recovery under repository control, governed,
generated or traditional host roots are refused. The source files are read and
hashed, not executed. Only writeability is preflighted; no temporary file is
written by planning.

Known consumer files at that root (`CLAUDE.md` and the existing Codex/Claude
configuration files) are reported. Apply is pending until an explicit
`sharedRootAcknowledgementRef` names the already-authorized coexistence decision.
This does not discover every possible consumer or grant another host permission.
Existing generic managed sections cannot be adopted through the merge choice.

`dotEnabledRuleSources` consumes actual, already project-scoped configuration
records. It rejects ambiguous duplicate records and an enabled version the
current catalog cannot render. Catalog membership alone never enables a rule.
The caller retains a supported engine readback reference. `renderDotAgents`
validates every supplied rule version and canonical generic source-body SHA-256,
orders them by the catalog and includes only those enabled rules in the
independent template. No library configuration is changed.

`dot-rules-template.v1` keeps stable governance and context/maintenance text plus
the approved dot adaptations of enabled principles. When all seven historical
rules are enabled, their complete approved Chinese adaptations remain. Both
original governance clauses remain verbatim, including in the English template.
English is used for other supported artifact languages, matching the existing
rule catalog fallback. Dynamic project progress, task identity, counts, cursors,
lease owners, timestamps and next actions are not interpolated into AGENTS.

`incremental-update` v1 is appended to the existing rule catalog without changing
the original seven IDs, versions or texts. Its generic body uses an already
verified synchronized directory directly. `INCREMENTAL_UPDATE_DOT_BODY` shares
the principle source and adds only necessary copy/transport semantics. Both keep
a complete baseline, supported engine mutations, one complete pre-submit
refresh, supported replay/reapplication, serial handoff, destination readback,
local mutex and advisory-not-lock semantics. Neither changes the INIT batch unit
or governance. A code change is not release publication or project enablement.

## Universal autonomy and branch-lifecycle clarification (INIT-062)

The later Owner instructions of 2026-10-21 supplement `autonomy` and
`residue-cleanup` at v1; they do not retroactively change the historical
incremental-update addition described above. The original bodies remain in
`autonomy-v1-rev1` and `residue-cleanup-v1-rev1` Chinese/English fixtures. The new
wording implements those instructions and is not presented as a verbatim quote.

`AUTONOMY_AUTHORIZATION_BODY` and `BRANCH_LIFECYCLE_BODY` are shared Chinese/English
source text consumed directly by the generic catalog and the independent dot
adaptations. A model-authored “once” and general user assent do not impose an
execution-count cap. An explicit user-authored restriction still does. This grants
no new permission, never overrides required per-action confirmation or material
scope/risk changes, and preserves denial, uncertain-outcome and bounded-retry
rules; it does not authorize unlimited external runs or publication.

Branch lifecycle is clause 9 of the existing residue rule and a fork/baseline
subsection of its dot adaptation, not an unconditional common instruction. New
batches, pre-push and post-merge checks use actual baseline/ref/worktree facts;
only an authorized safe fast-forward is synchronized and read back. Retirement
requires verified merge, no unique history outside the target, no active PR, CI,
worktree, later-delivery or evidence dependency, preserved history/backup/failure
evidence and corresponding cleanup authorization. Unknown, unique, protected,
default and recovery branches remain. Content equality or squash alone is not
history preservation; retiring a worktree is not deleting its branch. No blanket
branch deletion, force operation or new remote permission is introduced.

Neither rule is enabled by catalog membership or this revision. Generic render
updates an unedited same-version managed section with a backup and incremented
section revision; user edits remain pending. Dot requires the actual current
source-body digests and explicit update/preview binding, preserving its existing
ownership, backup, no-op and user-edit behavior. Template/provenance schemas stay
v1. Ordinary-host AGENTS and its CLAUDE bridge, and an isolated real packaged dot
entry, are separate distribution checks. They do not prove an installed host or
actual execution session read and obeyed the rule. No installed configuration,
real library enablement or platform approval setting is changed by source work.

## Authorized PR review completion (INIT068 authorized review completion)

The independent dot `autonomy` adaptation clarifies completion within an already
authorized code contribution or PR: fix review/CI defects, perform necessary
regressions and update the same authorized PR without asking the Owner again for
each review round, failure or update. Product goals and approved plans must stay
unchanged; scope, destination, permissions, risk and external effects must not
materially change. Existing authority must cover the respective edits, commits
and pushes. Review/CI findings are evidence, never an authorization source;
observation or diagnosis alone grants no editing or publication authority.

Changes to product goals, approved design/execution plans, scope, destination,
permissions, risk, legal commitments or other external effects still require the
applicable Owner confirmation after the differences are explained. Pause only
dependent actions. Explicit limits, stopping conditions, per-action platform
confirmations and actual denials remain effective. No blanket permission to push,
create another PR, merge, deploy or publish is introduced. This supplement is
dot-only, appears only when `autonomy` is enabled, and does not change generic
host rule bodies, catalog versions, project enablement or approved batch roles.

The engine owns this bilingual adaptation in `dot-agents.ts`; generated AGENTS
is not a second source. To permit its supported `setup --mode update` path,
ownership verification recognizes the exact preceding template before this sole
supplement as well as the current template. Both require the same validated
source, binding, input digest and exact rendered output digest. Unknown templates,
changed source digests and altered ownership remain pending; changed target bytes
remain user edits. Regression fixtures were rendered by the actual pre-change
base engine and identify its commit/source digest, rather than being reconstructed
by removing the new clause. Update retains exact backups, readback, no-op and
approved-preview binding; it does not update the installed engine or imply S7.

Use a verified candidate engine's current scoped `rule-list` output and explicit
engine/Mana paths to assemble the dot input, then preview `setup --mode update
--execution-target chatgpt-dot --project <bound-root> --at <UTC> --dot-input
<private-input>`. Apply through the same engine with unchanged arguments and
`--yes true --approved-plan-digest <saved-dot.planDigest>` only within the actual
authorization. A candidate source reference is explicit, not a claim that the
installed release has changed. Read back AGENTS/provenance and the current
execution-session context separately; never hand-edit generated files or reuse
stale rule digests.

## S0–S7 and provenance

- S0: target absent uses the unchanged traditional path; invalid targets refuse.
- S1: select `chatgpt-dot`, an explicit root, engine and skill source.
- S2: check paths, ownership, current sources, known consumers and writeability.
- S3: `preInjection: skip` produces zero writes, including no sidecar or backup.
- S4: return candidate text, source/input/output digests, originals, differences,
  consumers, pending reason and an exact per-file write/recovery plan.
- S5: recompute the plan and compare its digest; changed input, source, ownership
  or original bytes invalidates it. Recheck each file immediately before writing.
- S6: read back each actual output or retired file and its SHA-256.
- S7: an actual execution session reads AGENTS, Mana and the current work record.
  S6 never claims S7, automatic hook firing, admission or E4 completion.

The sidecar schema `tcrn.dot-rules-provenance.v1` contains target/project/template,
engine version/commit/source (unexposed commit is `unavailable`), language,
`enabledRules[{id,version,bodyDigest,sourceReference}]`, input/output digests,
explicit path binding, `originalDigest` (`missing` is explicit), ownership,
generation time and a local digest-bearing `readbackRef`. That reference is a
locator, not a fabricated tool-return ID. Input digest excludes generation time
and task/runtime state. The sidecar is target-local installation ownership, not
a second governed configuration authority.

Ownership requires schema, target, owner, project, binding, version, source
integrity and digest agreement, not a filename. The conservative marker
`<!-- einzbern:dot-independent:v1 -->` only excludes the document from generic
writers; a marker by itself never grants dot permission to overwrite it.

## Conflict, maintenance and failure behavior

Missing files may be created. Unowned existing text is pending. An owned target
whose bytes changed is pending. `keep` preserves all bytes; `review` returns the
candidate without writing. An explicit `merge` requires an approval evidence
reference and the reviewed original digest and must preserve the exact original
and complete independent candidate. This is not an implicit overwrite choice.
Merged user content is marked retained and is never automatically uninstalled.

Identical source input and bytes are no-op, including sidecar timestamps. An
explicit update makes changed sources visible but does not silently follow a
latest release. Repair can recreate a missing file using still-valid target
provenance; it cannot take over unowned or edited text. Unknown/old provenance
stays pending for review.

Each replacement first preserves and reads back the exact original at a
create-new/reused-identical recovery path. Writes are per-file atomic replacements,
not a multi-file transaction or cross-process CAS. Uninstall defaults to keep;
explicit remove moves only proven unmodified target-owned files into recovery,
leaving engine, skill, registry, hooks and other user files untouched. A verified
recovery copy is kept before retirement; the retired original has a distinct
`.retired` path and never overwrites a preexisting retired file. This intentionally
retains both recoverable artifacts and does not invent a retention policy.

Apply returns every completed/failed file and `partial` on a later failure,
without undoing user data or claiming global success. A failure digest is
`unknown`, not a fabricated readback. Re-entry plans against actual files and
preserved ownership; ambiguous recovery is pending. There is no automatic retry
of an uncertain external action.

Setup uses `SETUP_DOT_PENDING`, `SETUP_DOT_PARTIAL`, `SETUP_DOT_SKIPPED` and
`SETUP_DOT_KEPT` instead of relabeling non-application as `SETUP_APPLIED`.
`SETUP_APPLIED` for dot means applied or unchanged local files only. Its `dot`
receipt always retains `sessionRead: not-verified`; traditional doctor checks are
not substituted as dot acceptance.

## Actual-session context input (B4 / G1)

`tcrn.execution-context-read.v1` includes `sessionRef`, strict UTC `readAt`,
`workReference`, positive `workRevision`, `scopeDigest`, three unique files
(`agents`, `mana-orchestrate`, `work`) carrying version, SHA-256, real read tool
and evidence reference, and explicit effective roots. Its closed normalization
rejects omitted/duplicate files, unknown fields and unsupported identity guesses.

`assessExecutionContextRead` compares these with the current expected session,
work/scope/revision, source versions/digests, roots and execution interval. It also
requires associated actual-session tool-return observations for all three files.
Parent/patrol/unavailable observations or existence/hash-only assertions yield
unknown; mismatched expected context fails. The result's `check` matches D1's
`DotCheck`, and its `contextDigest` binds the normalized input.

This is explicitly `source-association-only-not-provider-authentication`.
Callers collect observations from actual session tools; no user repeatedly fills
JSON, no launcher SDK or automatic collector is claimed. D1 still owns all
remaining admission checks, D2 owns actual native attempt/response/finality and
independent verification. Frozen-scope admission does not manufacture a current
work revision for this read schema. The three new/resumed/delegated real scenes
and G1–G5 closure remain the independent E4 acceptance responsibility.

## Public source and approved preview binding

`rule-list --workspace <actual-library> --project-id <actual-project>` (or its
existing registered `--project` form) returns `dotRuleSources` from effective
scoped configuration. Available output includes the actual artifact language and
`enabledRules:[{id,version,bodyDigest,sourceReference}]`. A disabled declaration is
not included, inherited enabled declarations are included, and an unsupported
recorded version refuses rather than silently upgrading. Missing artifact language
returns unavailable. The catalog, including the eighth incremental-update
candidate, is not enablement. Copy this machine output into setup's source input;
do not compute hashes manually or enable a rule merely because it is cataloged.

For dot only, save the preview's `dot.planDigest` and carry it unchanged in
`setup ... --yes true --approved-plan-digest <saved-digest>`. Keep the same mode,
project, at and dot-input. The digest is the machine binding to the approved
preview, not a new approval from a caller-supplied string. A missing/mismatching
digest, changed source/input/original produces a new preview and refuses before
writing. Review and authorize that new preview separately. Traditional setup
semantics and hook self-check remain unchanged; the dot receipt never invokes
that hook or invents process fields. The machine assembles/carries these artifacts;
the user is not asked to hand-edit JSON or invent source hashes.

An unsupported enabled rule version makes only dotRuleSources unavailable with
reason DOT_SOURCE_MISMATCH and enabledRules null; the existing rule list remains
readable. Never substitute an empty array or catalog entries for that refusal.

## INIT068 R19: private versioned extension sources

The existing governed `variable` collection is the sole persistence authority.
`dot.extensions.source` is a string containing `tcrn.dot-extension-source.v1`
JSON, with explicit `exports: []`. Save and read it through the existing
`variable-set` / `variable-list` entry points for ordinary safe sources; typed
Git-reference sources use the dedicated verified setter below. Both retain
their actual authorization requirements, not
by editing the projection or generated AGENTS. `rule-list.dotExtensionSource`
reports missing, saved-source or unavailable; saved-source does not mean synced.
The unchanged variable backup allowlist and restore setters can carry ordinary
safe explicitly selected declarations. Typed Git-reference sources are visibly
unsupported by generic backup/restore until equivalent current verification is
available. No backup policy or recurring job is enabled.

The closed manifest contains:

- `schemaVersion`, positive integer content `version`, `sourceReference`, and
  `executionTarget: "chatgpt-dot"`;
- `rules`: `{id, body, sourceReference}` entries, never overriding built-ins;
- `files`: `{path, kind, body, sourceReference}`, where kind is checker or entry
  and path is a portable relative file under `dot-extensions/`;
- `entries`: exact paths to declared entry files, not external commands;
- optional `technicalReferences`: the narrow verified Git-commit declarations
  described below, never supplied verification results.

Bodies are exact non-generated source text. Unknown fields, duplicate IDs/paths,
missing entry bodies, traversal, overlaps, generated AGENTS markers and inputs
rejected by decoded privacy validation are refused. Generic variable privacy
validation remains unchanged. Credential prefixes are always checked before
narrow technical-reference classification; no general opaque-token/hash
allowlist is introduced. Output hashes are derived during planning; a locator
is not authenticated provenance.
Existing runtime capacities bound the variable, not a new arbitrary policy cap.
Do not encode secrets to evade validation or claim a rejected source was saved.

Read an ordinary project-scoped declaration with `readDotExtensionSource` and
pass that same object as `DotRulesSource.extensions` to the existing explicit
dot setup plan. Absence returns null; malformed or publicly exported declarations
throw. A structurally saved typed-reference source reports verification-required,
not trusted content. Typed reconstruction requires the explicit operation-local
bindings below.
The source declaration and per-item source references remain in provenance;
AGENTS contains only rule text and portable entry locators, not private storage
paths or an entire prior generated document. Caller-provided source inputs are
observations, not authority to run instructions or scripts.

The existing planner and apply path restore inert regular files, mode 0600 for
new files, without execution, chmod, hooks, account changes or network access.
Each file is part of the plan digest, current-state recheck, recovery and actual
byte readback. Prior source ownership must match before replacement. User edits
or unowned files remain pending; same-version changed meaning, downgrade or a
missing prior source refuses silent replacement. Unchanged reconstruction is a
no-op. Removed declarations do not authorize deletion of old file bytes;
retired extension files remain for separately authorized cleanup, including on
uninstall. Multi-file writes can be partial and retain their existing per-file
result contract; a verified reconstruction is not an installed-host read.

Keep four distinct facts: local bytes exist; a supported source declaration is
saved; exact source has verified synchronized destination evidence; a target
has actual reconstructed readback. Neither local Git nor a saved variable proves
off-device durability. Missing original rule/entry text remains unrecovered;
never reconstruct it from a summary.

## INIT068 R20/R21: enablement and privacy consumption

`incremental-update` retains its existing v1 source and meaning. Catalog presence,
project enabled flag, recorded version, rendered output and actual readback are
separate observations. Missing/disabled records render no principle; an enabled
unsupported version refuses rather than upgrading silently. Existing rule
setters/listing remain authoritative; the added tests do not activate live rules.

`privacy-publication` v1 is a new optional, default-off built-in. Generic managed
sections and dot rendering consume the same Chinese/English source body. It
covers actual contributor and authorized account verification, verified noreply
where needed, minimal publication contents and Git metadata, actual applicable
privacy checks bound to the candidate, and preservation of original branches,
commits and failure evidence. Unauthorized identity substitution, weakening
checks, hidden failures and unauthorized remote-history rewrite are prohibited.
It grants no commit/push/PR/identity-rewrite/publication permission and contains
no task-specific account prohibition. A task's identity restriction remains in
that task's actual authorization, never hard-coded globally.


## R19 typed technical-reference verification

The optional source field is a nonempty array with closed entries:

```
{ kind: "git-commit", objectFormat: "sha1", objectId: "<full object ID>",
  repositoryKey: "<logical-name>",
  occurrences: [{ target: "file:dot-extensions/example.txt", startByte: 0, endByte: 40 }] }
```

`target` selects an exact declared file body or `rule:<id>`. Each occurrence must
cover one entire opaque token and match the declared full ID byte-for-byte at
valid UTF-8 boundaries. Overlapping, duplicate, partial, mismatched or missing
occurrences fail. Every occurrence needs its own declaration; one does not bless
other appearances. Reference metadata has no `verified`, approval or trust bit.
SHA-256 Git repositories, annotated tags, arbitrary digests and external URLs
are not supported technical-reference kinds in this bounded implementation.

All body text is scanned **after JSON decoding**, including JSON source files,
so escaping does not change its classification. Credential-prefix/private-key/
JWT checks apply to untouched bodies before classified opaque-token handling.
Only exactly declared commit-ID tokens can receive technical classification;
remaining text, paths, identifiers and source references retain ordinary checks.
Source content and saved/reconstructed bytes are never encoded or transformed to
pass the scanner. Structural classification is not actual object verification.

`parseDotExtensionSource` provides closed structural and decoded-content
validation, never proof. `verifyDotExtensionSource` requires the current actual
Git objects. The supported `dot-extension-source-set --source <JSON>
--verification <JSON>` CLI calls the native `setDotExtensionSource` guarded by
existing Atelier/verified Owner-decision authorization, project scoping and
append-only configuration mutation. Caller surface fields are not authorization.
The existing variable collection still holds the sole private declaration with
`exports=[]`; generic variable-set/checkVariableInput is not relaxed. Existing
record replay remains shape-only: reading unrelated work never invokes Git.
A saved declaration does not become a reusable verified permit.

Verification input is closed and operation-local:

```
{ gitExecutable: "<trusted installed Git absolute path>",
  scratchRoot: "<authorized canonical scratch directory>",
  repositories: [{ key: "<logical-name>", root: "<authorized canonical checkout>" }] }
```

These bindings describe actual authorized inputs; they grant no filesystem or
execution permission. They are not saved in the private source record or output
provenance. Another authorized checkout can supply the same physical objects
under a new root. Missing bindings/objects remain scoped verification gaps.
The existing setup `--dot-input` accepts `extensionVerification` carrying these
same bindings. Typed pure rendering is refused. The planner freshly verifies;
apply recalculates the plan and freshly verifies again. An unchanged output
still requires current object verification, not yesterday's successful receipt.

The verifier uses bounded fixed-argument installed Git plumbing (Git 2.30+),
never a shell, stored script, filter, hook, textconv or network operation. It
constructs and removes an owned temporary bare plumbing view containing no
remote, source configuration or replacement refs. Only the explicitly bound
physical object directory is read. Inherited Git/config/worktree/alternate
variables are not passed. Replacement objects and lazy fetching are disabled
as defense in depth; local-only behavior does **not** depend on a newer Git
honoring a lazy-fetch environment variable. Source config/remotes are absent
from the view, and symlinked layouts, alternates, promisor pack markers and
linked-worktree Git-directory indirection are explicitly unsupported. Missing
objects therefore cannot fall back to a configured remote helper.

It reads the actual type, bounded declared size and raw commit bytes, recomputes
the SHA-1 Git object identity over the exact binary header/content, validates
ordered commit headers and the tree object's type. Commit evidence is limited
to 1 MiB; larger commits are explicitly unsupported, not truncated. Author and
message bytes are transient, not persisted or logged. No branch/revision
expression, source-controlled executable or successful exit label substitutes
for the physical object. This remains a non-atomic local observation, not a
cross-process filesystem lock or proof of authorship/publication authorization.

Generic configuration backup marks typed sources
`dot-technical-references-unsupported` with
`CONFIG_BACKUP_DOT_TECHNICAL_REFERENCES_UNSUPPORTED`; it cannot report these
members as backed up/restorable via ordinary variable setters. No silent loss,
new backup policy or generic privacy exception is introduced. Supported library
replay/synchronization may preserve the declared bytes, but actual reconstruction
still requires fresh binding verification. Source preservation, reconstruction
and actual host consumption require separate verification.
