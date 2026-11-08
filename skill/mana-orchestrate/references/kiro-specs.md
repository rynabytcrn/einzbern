# Kiro Specs

Use the local Spec helper when a work item benefits from a current Kiro Feature Spec. The helper reads Einzbern's native work, decision, and project-context commands; it does not maintain a second requirements store.

```sh
node "<skill directory>/scripts/kiro-specs.mjs" init \
  --workspace <library> \
  --work-id work:<24-lowercase-hex> \
  --spec-dir .kiro/specs/<spec-name>
```

The helper creates `requirements.md`, `design.md`, `tasks.md`, and `source.json` under the relative Spec directory. It records real work revisions and digests. When the source is legacy text, it records the work revision and field digest instead of assigning a requirement version. `design.md` reports a missing design authority when the resolved project context has none; it does not infer one from the repository path.

## Check and update a Spec

Read the source before each task:

```sh
node "<skill directory>/scripts/kiro-specs.mjs" check \
  --workspace <library> \
  --work-id work:<24-lowercase-hex> \
  --spec-dir .kiro/specs/<spec-name>
```

`SPEC_CURRENT` means the managed projection matches the current engine sources. `SPEC_STALE` means a work, decision, or resolved design source changed. Draft proposed content to a new relative file without changing the owned Spec:

```sh
node "<skill directory>/scripts/kiro-specs.mjs" draft \
  --workspace <library> \
  --work-id work:<24-lowercase-hex> \
  --spec-dir .kiro/specs/<spec-name> \
  --draft-out .kiro/specs/<spec-name>/change-draft.md
```

Update formal work through the engine's existing decision and writeback path. After reading back the new work revision, refresh with the decision locator that the current work record now links:

```sh
node "<skill directory>/scripts/kiro-specs.mjs" refresh \
  --workspace <library> \
  --work-id work:<24-lowercase-hex> \
  --spec-dir .kiro/specs/<spec-name> \
  --approved-in minutes:<24-lowercase-hex>#D<n>
```

The helper refuses refresh when the decision is missing, stale, or not linked from the current formal work record. It never writes work, minutes, requirements, design authority, or completion evidence.

## Ownership and local edits

`source.json` identifies the files the helper owns. Initial generation refuses an existing target file without that ownership stamp. The helper only replaces the marked section and preserves text outside it. An edit inside a managed section causes `SPEC_EDIT_CONFLICT`; resolve it in a draft and apply any approved source change through Einzbern before refreshing. A local task checkbox is retained as local progress only. It never changes the formal work status or counts as completion evidence.

The helper refuses incomplete source contexts, empty goal or acceptance text, unowned files, invalid paths, symbolic links, and unreadable or unwritable targets. A refusal leaves the affected file untouched. Inspect command results for the current source revision and reason code before proceeding.

## Native Kiro operation verification

<!-- KIRO-OPEN-OPERATIONAL-VALIDATION:BEGIN -->

### Native Kiro Spec Helper Operational Verification (C2 Isolated Continuation)

This section documents the actual operational behavior of Kiro Specs when invoked in an isolated C2 continuation context, using model claude-haiku-4.5 via kiro-cli default effort.

#### Context and Formal Source Distinction

**Formal Source:** Installed-engine C2 work revision 18
**Synthetic Record:** revision 2 (annotated work record, not created at this revision but promoted through engine operation)
**Workspace Scope:** Isolated unregistered synthetic library

#### Helper Source and Invocation

The Kiro Spec helper is sourced from the native Einzbern skill directory via mjs script invocation. Commands reference local workspace paths and work record identifiers. Example invocation structure:

```sh
node "<skill directory>/scripts/kiro-specs.mjs" <command> \
  --workspace <library-identifier> \
  --work-id work:<ID> \
  --spec-dir .kiro/specs/<spec-name>
```

The helper operates on local Spec directories (E-relative: `.kiro/specs/<name>`) without external service dependencies in isolated scope.

#### Native Write/Read/Recall Permission Outcomes

**Observed Permission Tests:**

- **Allowed path write:** Filesystem write to private approved inert allowed path completed successfully with content marker.
- **Denied path write:** Filesystem write to private approved inert denied path denied by permission rule from `~/.kiro/settings/permissions.yaml`. This is the expected negative probe outcome — no fallback attempted.

#### Bridge Command Execution and Child Behavior

Three bridge commands executed in isolated execution context:

**1. Recall Command:**
- Exit status: 0 (success)
- Knowledge stores: empty (0 cards each, project and user)
- Schema version: tcrn.recall-agent.v1
- Records indexed: 1

**2. Write Command (Bridge Fixed Write):**
- Exit status: 0 (success)
- Work record: Initiative, revision 2, status active
- Record type: fields (legacy-unverified source)
- Engine version effective: 4.4.0
- Workspace binding: isolated synthetic library

**3. Read Command (Bridge Fixed Read):**
- Exit status: 0 (success)
- Work kind: Initiative
- Source: fields (legacy-unverified)
- Content rollout readiness: NOT READY — problems include missing rollout observation, missing library setting floor, unverified capable delivery
- Write authority: not-granted
- Scope binding: matches formal C2 source

#### Native RunAll Sequence

When executing tasks via Native RunAll workflow:

1. **queue-all:** Queue all tasks in spec without specifying taskId
2. **task_list(status=ready):** Query ready tasks to obtain exact full task ID string
3. **task_get:** Retrieve task details using exact full ID and absolute tasksFilePath
4. **task_update(status=in_progress):** Mark task in-progress using native tool; successful tool result confirms state transition, not process exit code 0
5. **invoke spec-task-execution:** Dispatch worker with full specTask object (including exact tasksFilePath); child dispatch must follow successful task_update result in a later internal model response with exact returned taskId and tasksFilePath in specTask
6. **Completion marking:** Local task checkbox is retained as local progress only; it does not change formal work status and does not count as completion evidence

#### Independent Verification Method (New Session)

To verify results in a fresh independent session:

1. **Select Execution Model:** Parent session exported model claude-haiku-4.5; child inherits parent model but does not separately expose provider/model identity
2. **Execute Bridge Commands (Separate Invocations):**
   - Issue bridge read command with Code-relative approved absolute fixed bridge path `.tcrn-artifacts/initiatives/init-085-kiro-specs/implementation-c2-global-guard/worker/sample-bridge`
   - Resolve against Code workspace base
   - Execute `read` as exact command literal, then `recall` as exact command literal separately
   - Compare each absolute path literal to the approved YAML before execution
   - Note: The relative display string is not an executable allowlist literal
3. **Compare Results:**
   - Return value: synthetic revision 2 summary field
   - Return value: head event identifier
   - Compare against original write receipt captured in first execution
4. **Inspect Bridge Arguments:**
   - Verify persisted bridge argv includes `--actor agent:kiro` if requested
   - Note: engine work-show/event-list synthetic samples do not expose persisted actor field; bridge request argument establishes intent, separate persisted actor attestation requires external verification mechanism not exposed in synthetic sample output
5. **Report Method:** Document method and comparison results; do not claim independent run was already performed

#### Account and Benefits Clarity

**Distinction of Terms:**

- **Displayed estimates:** CLI command output estimates
- **Session credit measurement:** Measured credits for this session; token usage and actual account delta unknown
- **Benefits realization:** Established value outcome — unmeasured

**Status in This Work:**

- No comparable baseline measurement exists for this isolated execution
- Benefits to broader workspace state are unknown
- CLI command results do not establish IDE model consumption, Skill resource consumption, or Owner formal acceptance
- Bridge write receipt confirms command execution but not content propagation or downstream value

#### Method Notes

This verification used native filesystem write operations (no shell wrapping), exact bridge command invocation, and retained all reported tool outputs. No completion evidence was constructed; operations are reported as directly observed. Synthetic revisions are distinguished from formal source revisions. Path labeling distinguishes Code-relative artifact paths from E-relative Einzbern-rooted paths.

<!-- KIRO-OPEN-OPERATIONAL-VALIDATION:END -->
