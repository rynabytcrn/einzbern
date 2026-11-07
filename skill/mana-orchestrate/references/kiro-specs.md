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
<!-- This section is intentionally unfinished for the authorized native Kiro Spec task. -->
<!-- KIRO-OPEN-OPERATIONAL-VALIDATION:END -->
