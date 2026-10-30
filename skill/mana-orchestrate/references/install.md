# Install Einzbern in a project

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

It is the wizard for a first installation, `setup --mode fresh`: one screen of questions, one final
confirmation, then the apply. Run the engine verbs below the way SKILL.md says to invoke the
engine. Supply two flags yourself: `--project <dir>`, the root of the project being set up (ask
only when it is unclear which project), and `--at <UTC>`, the current instant written
`YYYY-MM-DDTHH:MM:SSZ`.

## Choose the installation target first

The existing questions and hook workflow below are for `traditional` (the default), not dot.
For dot, use `--execution-target chatgpt-dot` and the independent-target workflow in this section.
This target is not a Claude Code, Codex or DSH host registration. It installs an independently
owned AGENTS document and its provenance, not a platform-native dot hook, collector, dispatcher,
background lifecycle manager or synchronization service. Installing files does not prove that an
execution session read them or that native admission passed. A rendered version is not release
certification; use the actual engine artifact and its verified installation source.

### Locate the installed input contracts

The actual engine bundle root contains `scripts/einzbern.mjs` and its sibling `specs/`.
The device's `engine/einzbern.mjs` launcher is not the bundle-root locator; resolve the actual
bundle in use. These contracts are not in this Skill's directory. Read the bundle's
`specs/dot-rules-v1.md`, `specs/dot-execution-v1.md`, `specs/native-tool-evidence-v1.md`,
`specs/shared-submit-v1.md` and `specs/config-backup-v1.md` for complete closed input shapes,
required/optional/null fields, enums and digest rules. Traditional process evidence uses
`specs/dispatch-admission-evidence-v1.md`. Command help supplies flags, not a substitute for
these JSON contracts; no TypeScript checkout or bundle reverse engineering is needed.
An absent contract is a packaging gap, not permission to invent fields or use another version.

### dot: collect observations and plan

Use the selected project's explicit root and existing compatible engine and Mana Skill files.
Do not search unrelated directories or create a library identity to make the plan work. Assemble
one private input file automatically from actual path, rule and source readbacks; do not ask the
user to hand-fill JSON, supply invented evidence, or approve each already-authorized dispatch.
Ask only for missing choices, permissions or material scope changes. Capability unknown is not
pass, and a repeated approval cannot make an unavailable tool available.

The `setup --dot-input` file is the closed input type
`Omit<DotAgentsOptions, "executionTarget" | "operation" | "at">` in the shipped
`specs/dot-rules-v1.md`. Do not insert those three excluded fields. Required fields are:

| Field | Actual source and meaning |
| --- | --- |
| `binding` | Explicit normalized absolute `root`, `agentsPath`, `provenancePath`, `backupRoot`; bound `projectReference` and `ownerId`. All belong to this authorized target, not inferred from a filename. |
| `source` | `engineVersion`, `engineCommit` (`unavailable` when unknown), `engineSourceRef`, `language`, `enabledRules`. Each rule has `id`, `version`, `bodyDigest`, `sourceReference` from the current scoped engine readback. Catalog membership is not enablement. `source: null` is allowed only for skip or uninstall. |
| `enginePath`, `manaSkillPath` | Explicit readable engine and Skill files, whose actual content digests are rechecked before apply. A path or claimed version alone is not authentication. |
| `preInjection` | `apply` or `skip`; skip performs no target write and never silently writes elsewhere. |

Read `rule-list --workspace <actual-library> --project-id <actual-project>` or the existing
registered `--project` form. Only `dotRuleSources.status: "available"` supplies the effective
`language` and `enabledRules` for this target: inherited enabled rules are included, disabled
rules excluded. Copy that machine output, including its source references and hashes, rather
than manually computing rule hashes. Missing language or unsupported recorded versions
leaves this projection unavailable; `DOT_SOURCE_MISMATCH` with `enabledRules: null` is not
an empty rule set. Keep the reason and stop the dependent plan; the original rule list remains
readable. Never substitute catalog entries or `[]` for unavailable source observations.

Optional `resolution` is `{kind: "keep"}` or `{kind: "review"}`, or an explicitly approved
`{kind: "merge", originalDigest, mergedBody, approvalEvidenceRef}`. Optional `uninstall` is
`keep` (default) or `remove`; `sharedRootAcknowledgementRef` refers to an actual decision about
sharing the target root, never an invented permission. Preserve user and other-host content.
The independent document retains the seven stable principles, both governance constraints and
any actually enabled `incremental-update` rule source. Registration of that eighth rule does not
enable it. Dynamic work, counters, errors and schedule state never belong in AGENTS.

Plan with `setup --mode fresh --execution-target chatgpt-dot --project <root> --at <UTC>
--dot-input <absolute private JSON file>`, without `--yes`. `--project` must match the bound root.
The engine returns `SETUP_PLAN_READY`; inspect `dot.status`, changes, ownership, original/source
hashes, backups, warnings and blockers, not only the top-level reason code. Keep pending user
edits visible. Same inputs and content are a no-op; a changed original/source invalidates the old
plan. Present the concrete file changes and recovery locations together for installation approval.
Save that preview's `dot.planDigest` automatically with the exact planned inputs.

### dot: apply, maintain and read in the actual session

After approval, repeat the same mode, project, at and dot-input with `--yes true` and
`--approved-plan-digest <saved-digest>`, carrying the previously reviewed `dot.planDigest`
unchanged. Do not compute a new digest at apply time and call it approved. Missing/mismatching
digest or changed source/input/original returns a new preview and refuses before writing;
review and authorize that new preview separately. The user does not hand-fill JSON or hashes.
The apply rechecks source and original digests, preserves recoverable originals and reports
each file independently. Read the
actual `dot.files`, `fileVerification` and status; `SETUP_DOT_PENDING`, `SETUP_DOT_PARTIAL`,
`SETUP_DOT_SKIPPED` and `SETUP_DOT_KEPT` are not successful installation claims. A dot receipt
has no traditional hook self-check. `sessionRead: "not-verified"` remains until separate actual
execution-session evidence exists; neither file verification nor a parent read changes it.

For maintenance use the same explicit target/input route with `--mode update`, `repair` or
`uninstall`, previewing before an approved apply. Update changes only the pinned independent
rule source, not the engine release. Unknown ownership or user edits stay pending; do not
silently follow the latest template, append generic managed sections, change other hosts' files,
or remove another Skill. Uninstall removes only proven target-owned content when explicitly
selected and approved; otherwise keep it. Dot does not support `migrate` or `restore` setup
modes, nor traditional `--artifacts`, `--cloud`, `--language`, `--navigation`, `--archive`,
`--rollback`, `--managed-sections`, `--mapping` or `--restore` flags. Do not fall back to a
traditional setup or doctor self-check to fabricate dot coverage.

For shared device/library health, use `doctor --project <root> --execution-target chatgpt-dot`.
Its six applicable checks exclude traditional hooks and Skill copies explicitly; it does not
replace the dot file, provenance and actual execution-session readbacks above.

Before each new task, resume or independent delegation, the actual execution session reads
AGENTS, Mana and its current work. Machine-assemble `ExecutionContextRead` with the actual
`sessionRef`, `readAt`, `workReference`, `workRevision`, `scopeDigest`, `effectiveRoots` and
three file observations (`agents`, `mana-orchestrate`, `work`), each with `sourceVersion`,
`sha256`, `readMethod`, `evidenceRef`. Compare to actual current tool responses, not a hash
self-report. Parent/patrol observations cannot substitute. Installation, these reads, native
admission, a real tool return, execution finality and independently verified delivery are separate.

For native work the public commands are `execution-native-prepare`, `execution-native-record`
and `execution-native-evidence`. Prepare requires `--workspace`, `--request`, `--tool`,
`--tool-contract`, `--arguments`, `--output`; the request is `DotExecutionRequest` including
actual-session `contextRead`, the tool contract is `{ref, sha256}`, and arguments are the actual
tool parameters. Record takes `--binding`, `--output` and optional `--response`; absent response
means pending attempt, never an empty provider response. Use the saved prepare `--output`
file, the full `tcrn.native-dispatch-preparation.v1`, as `--binding`; do not pass stdout's
outer object containing `reasonCode`. Omit `--prior` only for the first record of an attempt.
Every later observation supplies the previous full saved output through `--prior`, including
its history, and a new create-only `--output`; never overwrite the predecessor. Evidence takes
`--from-file` and optional `--work-id` / `--work-revision`. Inspect the revalidated merged
`history` / `normalized` result from evidence/review, not only the last return or cached pass.
Inputs must be collected by the calling environment;
these commands do not install a platform collector or invoke a native tool. Follow the shipped
`specs/dot-execution-v1.md` and `specs/native-tool-evidence-v1.md`. Preserve real source,
association, failures and unknown finality, without a fabricated model, provider ID or process
streams. An unavailable exact-model interface blocks that specific delegation, not unrelated work.

Retry preparation requires both `--retry-from <previous-saved-record>` and
`--reconciliation <private-json>`, never either alone. Query unknown outcomes first.
The reconciliation is either `{outcome: "confirmed-terminal", record: <saved record>}` for
an associated confirmed failed/cancelled predecessor, or an actual confirmed-not-executed
query carrying `queryTool`, `queryRef`, `queriedAttemptId`, `responseValue`, `observedAt`,
`notExecutedPointer`, `notExecutedValue`, `contractRef` as specified in the native contract.
Completed, conflicting or unresolved predecessors cannot retry merely under another filename.
Preserve the full predecessor and reconciliation; new attempts have new local IDs, not invented
provider IDs. History is explicit and bounded, not automatically discovered from other files
or a global attempt database. Source association and digests are not provider authentication.
Traditional `execution-evidence --from-file <json>` likewise validates read-only, not authenticates.

### Two independent optional schedules

These are guidance and pure engine state contracts, not an installed scheduler. Check the actual
scheduler's supported create/query/update/readback capabilities first. If missing or unknown,
report that gap without enabling a substitute service. Use a saved real ID and scope, not a
matching name; query uncertain outcomes before retrying. Schedule state stays outside AGENTS.
Discovery groups receipts by actual `automationId` and uses each ID's newest valid observation
before matching scope, not array order or receipt count. Conflicting fields at the same newest
time require a fresh query (`same-instance-observation-conflict`), not another instance.
Malformed observations refuse; do not fall back to an older favorable receipt.

Context patrol runs every 20 minutes only over authorized tasks. New-task/session reads remain
mandatory. Two distinct successful checks at least 20 minutes apart must see the same completed
or `blocked_terminal` state and fingerprint before considering pause. Ordinary blocked or active
work is not terminal; unknown or failed observations cannot count. Re-read tasks before disabling
the same ID, then read tasks and disabled state back. Received new work resumes that same ID
and needs enabled readback; failure retains `pending-resume`, actual error and work references.
Ordinary terminal checks do not clear pending resume/pause or erase its error. Only matching
actual scheduler state readback after the actual action observation can resolve that pending action.

For the existing pure patrol state contract, machine-assemble `action-observed` only from the
actual scheduler update return/error observation: `action` (`pause` or `resume`),
`automationId`, `returnedAt` (actual UTC observation time) and `evidenceRef` (its real source).
It must match the pending same-instance mutation. The task's `before-pause` time, invocation
start, old readback and JSON assembly clock are not an update return; never fabricate a boundary.
An observed action is not successful pause/resume. Preserve the returned `pendingMutation`
with its `action`, `requestNotBefore`, `priorReturnedAt` and nullable `observation`.
`requestNotBefore` freezes the current request's maximum known prerequisite time, including
the real check/readback that creates it; actual `returnedAt` cannot be earlier. `priorReturnedAt`
is only a prior actual lower bound: a new action observation must be strictly later than it.
Neither bound proves the request was sent or the action completed, nor replaces an actual return.
Also preserve state `knownObservationAt`, the maximum supplied real time of accepted check,
readback and action events. It constrains future new requests, never retrospectively moves the
current request's bound or redates an already associated action. A new pause/resume retains all
known prerequisites but starts with no action observation. Untimed `new-work` preserves existing
bounds without inventing a receipt time. Keep this dynamic state outside AGENTS, not as a setting.

An `action-failed` event carries the actual `action` and `error`. When its failure belongs to
the recorded observation, carry that exact source as `actionEvidenceRef` and retain its mutation.
A mismatched reference refuses; an unlinked failure clears the current observation and retains
and combines known request prerequisites and the prior actual lower bound, error and work
references, without reusing an earlier action's proof. Unknown, missing-source and terminal-reset
transitions do not discard those bounds.
Do not invent a reference to avoid unknown. Both `readback` and `after-pause` require the same
actual instance/scope/20-minute interval and a readback `observedAt` strictly later than the
pending observation's `returnedAt`. Equal/earlier observations, even later than the old readback
or pre-pause check, cannot confirm the action. Obtain an actual post-action query/readback.
Missing current request prerequisites or missing/unassociated action evidence keeps unknown/query
and received work/error intact, including legacy states; a late readback cannot supply either.
Post-pause task reads remain required; disabled readback with new work or keep-enabled retains
same-ID resume responsibility, with a new resume observation and subsequent enabled readback.
These are state-event fields, not CLI flags, a scheduler/controller or permission to mutate one;
the calling environment collects real observations without asking users to hand-fill them.

Respect an explicit scoped keep-enabled override. Pausing patrol neither cancels work nor stops
children. Delays collapse to one current check; there is no atomic or invisible-event guarantee.

Daily configuration backup is a separate optional instance at fixed 00:00 Asia/Shanghai
(UTC+08:00), independent of patrol and travel timezone. Do not enable it until all of the following
are verified: actual whitelist and restore support, bound group/writer, complete approved retention
policy, safe recoverable retirement, scheduler deduplication/readback and explicit runtime
enablement authorization. Missing policy forbids enablement, never supplies guessed defaults.
Unknown actual enabled state stays unknown after eligibility loss or repeated evaluation, not
disabled. Query, disable through the authorized scheduler, then obtain a fresh matching false
readback after the current action boundary; historical disabled state cannot confirm this request.

For the pure daily contract, preserve `lastReadbackAt`, `lastActionAt` and
`pendingReadback { desiredEnabled, boundary }` between evaluations. Machine-assemble
`scheduler.actionObservation { automationId, desiredEnabled, returnedAt, evidenceRef }` only
from this request's actual same-instance query/update return or error observation. It is a causal
boundary, not success or authentication; old task/readback times and the assembly clock are not
substitutes. The actual return cannot predate the latest accepted readback or reuse an earlier
action for a new request. Re-evaluating the same unresolved request retains its binding; changing
the desired state or policy clears that binding but preserves `lastActionAt`.
Readback must match the original ID, group, selection and fixed schedule, and be strictly later
than both `lastReadbackAt` and the current boundary's `returnedAt`. Older/equal reads refuse;
a fresh opposite enabled state retains the request and error. Missing boundaries, including
legacy unknown state, stay unknown rather than treating a late read as proof. These are pure
state/input fields, not new CLI flags or an installed scheduler/controller; actual enablement
still needs the policy, capabilities and separate runtime authorization above.

Cancelling this schedule neither deletes packages nor changes patrol. A delayed run stores one
current snapshot with actual time; it cannot reconstruct midnight contents.

The policy requires explicit `activeLimit`, `transactionLimit`, `recoveryLimit`, `maxPackageBytes`,
`maxTotalBytes`, `retentionDuration`, `recoveryDuration` (durations in milliseconds),
`noChangePolicy`, `atLimitAction`, `retirementMethod`, `approvalEvidenceRef`. Policy structure is
not approval: the existing Owner decision must authorize the exact policy digest and library,
project, group, reserved root, writer and environment scope. A nonempty reference is not proof.
No retention amounts or cleanup permission are supplied by this guide. Policy changes, real
backup operation, restoration and external publication keep their own approval boundaries.

### Configuration backup and shared submission boundaries

The public backup verbs are `config-backup-plan`, `config-backup-create`, `config-backup-verify`,
`config-backup-list`, `config-backup-resume`, `config-backup-retire`, `config-restore-plan` and
`config-restore-apply`. Use their current `--help` and shipped `specs/config-backup-v1.md` for
closed request envelopes. Plan/create/resume/retire/restore use `--request`, `--at`, optional
`--workspace`, `--project`, `--project-id`, `--output`; write verbs also accept `--timeout-ms`.
Verify uses `--package`; list uses optional `--root` and required `--at`. Restore additionally
requires `--package`, `--actor`, optional `--decided-in`, and apply requires the exact reviewed
`--approved-plan-digest`. Private output is create-new, never overwrite. A timeout is not a
retention policy. Previews and digests grant no permissions; restore reuses the existing per-key
write authority and returns per-item outcomes with readbacks and recoverable originals.

Independent dot user fragments and rules are unmappable by generic restore. Authorized
settings/variables may change their declarations, but a full configuration refresh preserves
the independent AGENTS and provenance bytes and reports the dot projection pending, not
rendered. Use the separate dot maintenance plan for that document; never overwrite it through
a traditional managed-section or generic restore path.

Source identity is obtained asynchronously from the executing packaged bundle's actual version
and two stable content-tree observations, not from request JSON, cwd or stale compiled output.
Commit may remain unknown; content identity is not release certification. Source-tree commands
cannot pretend to supply packaged-engine identity. Verify rereads all package bytes; a planned
manifest is not verified storage. The list distinguishes active, transaction and recoverable areas,
not-scanned/errors/empty states, and unknown synchronization. The Portal is read-only here.

Use only explicitly selected safe user fragments, governed inputs, device preferences and
regeneration inputs. Never copy the whole home, credentials, identities, runtime state, advisory,
locks, admission records or generated projections. Reserved backup/staging/recovery roots must
not overlap actual library, project, device, artifact or generated-output roots. Retain failed or
uncertain transactions and query them before retrying; no safe old-package exit means stop new
packages, not unbounded accumulation or implied deletion.

Shared submission uses `shared-submit-plan` / `shared-submit-evidence --from-file <private JSON>`
and `shared-submit-advisory-read --workspace <library>`. The constrained advisory writer requires
`--workspace`, `--from-file`, actual `--actor`, `--handoff-evidence` and optional `--timeout-ms`;
there is no acquire, force-expiry or remote CAS flag. Read `specs/shared-submit-v1.md` for
`SharedSubmitInput`. Obtain a complete canonical baseline, work through supported engine verbs,
refresh completely once before submission and reapply semantic changes through the engine.
Never splice events, edit hashes or overwrite projections. Current serial writer handoff and the
same-library advisory are prerequisites, not a distributed lock; absent or old means unknown,
not free. Publish segments then manifest, verify actual remote IDs/parents/paths/bytes/digests,
replay the complete destination copy and read records back; release unknown stays pending.
Supply `merge.observedAt` and `writerHandoff.observedAt` from actual phase readbacks, or null
when unavailable. The order is local completion <= fresh refresh <= merge observation <=
handoff observation <= advisory observation <= every publication. Missing times stay pending;
reversed observations refuse. Never fill phase timestamps with JSON assembly time. Segment
readback must precede every manifest publication; complete destination replay precedes release.
Synced-folder hosts skip unnecessary manual transfers but retain those consistency obligations.
These commands assess evidence and store a constrained local advisory; they do not transfer files,
provide a storage SDK or implement background synchronization. Local write queues are not
cross-device exclusion. External transfer/publication requires the corresponding authorization.

## Traditional target workflow

The remaining sections describe the unchanged traditional target and its real host hooks.

## Use another reference when

- The user already has a library, from another device or a backup: `restore.md`.
- The plan reports an installation from before the rename: `migrate.md`.
- Einzbern already runs here and the user wants a newer engine, a repair, or a rollback:
  `update.md`.

## Before the plan: an engine on this device

The wizard installs from the engine that is current on this device. When
`<device directory>/engine/einzbern.mjs` does not exist, or a plan reports the blocker
`SETUP_ENGINE_NOT_INSTALLED`, put an engine there first with this skill's fetch step:
`node <skill directory>/scripts/install.mjs --archive <local archive>` installs a release archive
the user already has and fetches nothing, and `--version <version>` downloads that release. The
download is the only network use of the whole installation, so ask the user before it. The step
answers `INSTALL_ENGINE_READY`; then plan as below.

## Questions (one screen)

Ask the whole list at once, in one message. The list is the same on both hosts: Claude Code asks
it in one AskUserQuestion call, Codex asks it in the conversation as one numbered message. Ask
only the questions the plan reports as open, offer the plan's suggestion as the first choice,
never ask again for an answer the user already gave, and never guess an answer.

1. Library location. The shared library holds the projects' records under their stable project identities.
   The folder is named `Ether`; the user chooses its parent on any filesystem. The plan suggests
   the saved shared-library location, or `Ether` next to the device directory on a first install.
   `--artifacts` selects the complete library path. Subsequent projects reuse that location;
   cloud-provider detection does not constrain it.
   Flag: `--artifacts <library path>`.
2. Cloud drive. Is the library's folder synced by a cloud drive? The plan suggests an answer from
   the location. Flag: `--cloud true` or `--cloud false`.
3. Language. The language of the text Einzbern writes into the project's instruction files, as a
   language tag the plan lists among the question's choices, such as `en` or `zh-CN`.
   Flag: `--language <tag>`.
4. Navigation section. Add a short section that points agents to Einzbern in the project's
   instruction files? If not, the section is left out and the hooks point agents to Einzbern
   instead; the skill and the hooks are installed either way. Flag: `--navigation true` or
   `--navigation false`. The answer belongs to this device, not to the project, and each project
   registered here follows it only once it is repaired: when the answer changes, repair each
   other project `library-list` names with the same `--navigation` answer, as `update.md` says.

## Model groups for the selected host

Use the setup plan's `modelPolicyOnboarding` guidance and
`engine-model-policy-catalog --host <actual-host>` to open that host's onboarding
draft. Offer main (main decision model group), economy (batch coordination model
group), and flagship. Flagship is optional; do not invent a model or effort for
any group. Preserve existing and custom categories and configured tiers.

For Codex's independent-conversation workflow, main and economy must each resolve
to a usable group before that mode is ready. Ask the user to choose actual models,
efforts and escalation policy together; a selected escalation ceiling also needs
a usable tier. Save through the existing governed `engine-model-policy-set`
entry (or its Atelier editor), with the actual actor and recorded Owner decision.
Catalog/onboarding drafts are not persisted model selections. If the user defers
configuration, state that Codex peer mode is not ready; ordinary installation and
other hosts remain available. Do not manufacture a decision or silently migrate
another host's groups. See `specs/engine-model-policy-v1.md`.

Claude Code and DSH retain their single-conversation workflow. Codex-specific
batch recovery uses `docs/codex-native-controller.md`; no collector or stop-hook
activation is needed. Updates/repairs must preserve user-edited hooks and groups.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode fresh --project <dir> --at <UTC>`, with a flag for each answer already
   known and without `--yes`. It writes nothing and returns `SETUP_PLAN_READY`: the decided
   answers, the open questions, the files it would write, the originals it would back up first,
   any warnings, and any blockers. A plan with blockers is refused on apply (`SETUP_BLOCKED`): show
   each blocker and resolve it before going on. A warning does not stop the apply:
   `HOST_WRITABLE_ROOTS_TRACKED_BY_GIT` names a project host file, `.claude/settings.local.json`
   or `.codex/config.toml`, that Git tracks and that the apply writes this device's library path
   into, because the library sits outside the project; committing that file would publish the path.
   When the user's home has DSH profiles, the plan also carries `dshPlugin`: for each profile,
   whether the `dsh-mana-orchestrate` plugin is installed, its version, and whether the launcher it
   would run is this device directory's (`hookPathMatches`). Show these facts; the wizard has no
   step that writes a DSH profile, so a missing plugin or another launcher is set up in DSH.
2. Ask the open questions on one screen, then plan again with the answers until none is open.
3. Final confirmation. Show the decided answers and every file the plan would write, as the plan
   lists them, then each entry of `warnings` with its file and message, and ask once whether to
   apply. Whether such a file stays tracked is the user's call: say so, and change nothing in Git.
   Continue only on a clear yes; a changed answer goes back to step 2.
4. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: the files written,
   the backup directory, the same `warnings`, and `selfCheck`.
5. Knowledge store. A new library has none yet: until it has one, no card can be written to it,
   `knowledge-list` refuses with `KNOWLEDGE_PATH_INVALID`, and `recall` reports the project's
   store that way under `knowledgeStores`. Create it once with
   `knowledge-init --workspace <library path> --acknowledge-disposable true`, the library path
   being the one the plan decided; it answers `KNOWLEDGE_STORE_INITIALIZED`. A library that
   already has a store answers `KNOWLEDGE_ALREADY_EXISTS`, and that store stays as it is.
6. Report the files written, the backup directory, each warning again, and the self-check: the
   eight checks in `selfCheck.checks`, and what the hook added when it ran once with the project's
   name as the prompt (`selfCheck.injected`; nothing is added until the library holds something
   that matches). Handle any check that is not ok with `doctor.md`.

## Flags

| Answer | `setup` flag |
| --- | --- |
| Library location | `--artifacts <library path>` |
| Cloud drive | `--cloud true` or `--cloud false` |
| Language | `--language <tag>` |
| Navigation section | `--navigation true` or `--navigation false` |
| Yes at the final confirmation | `--yes true` |

Check the installation again at any time with `doctor --project <dir>`.

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task. Whether a library inside the project is committed or ignored is the user's
call; say so if it comes up and change nothing.
