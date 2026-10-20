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
