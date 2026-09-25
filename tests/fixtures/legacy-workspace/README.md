# Frozen old-layout workspace

This directory freezes one workspace in the old layout, written
by the engine before any event was written in the `einzbern.*` namespace. The read-only
reader (`packages/core/src/legacy-workspace.ts`), `chain-validate` and the later import
into a library are tested against it. Nothing here may be regenerated: the event bytes are
the evidence. `<control>` below is the old-layout control directory; its name is in
[the alias table](../../../docs/wiki/Glossary.md) and in `LEGACY_CONTROL_DIRECTORY`.

## Layout and how a test restores it

| In this directory | Restored to | Bytes |
| --- | --- | --- |
| `control/events/*.ndjson` | `<root>/<control>/events/` | copied byte for byte |
| `control/workspace.json` | `<root>/<control>/workspace.json` | stored pretty-printed for the format gate; restored as `canonicalJson(JSON.parse(...))`, which is the byte form the engine wrote |
| `control/events/manifest.json` | `<root>/<control>/events/manifest.json` | the segment sidecar, restored the same way; the reader never trusts it |
| `expected.json` | not restored | the replay facts every test compares against |

The five roots in `workspace.json` are the placeholders `<fixture>/<kind>`. Event
identities derive from the workspace id and creation instant only, so the placeholders
change no event byte and no hash. The repository keeps `control/` rather than a dot
directory so the fixture stays visible to review.

## How it was written

Generated once, with the engine at commit `029ab56` (TCRN-CROSS-SUB-264), whose write path
was the one every 1.x chain was written with. `initializeWorkspace` created a storage
version 2 workspace with 4096-byte segments, so the 36 events span ten segments. Then the
CLI ran, in order: `project-create` (twice), `project-update`, `project-delete`,
`work-create` (Initiative, Epic, Story with its full scope, three Subtasks), `work-transition`
(the Story to active, one Subtask to done), `work-annotate`, `work-delete`, `work-batch`
(two creates and a transition), `gate-create` (twice), `gate-delete`, `conference-open`,
`conference-append-position`, `conference-close --execution-form independent`,
`conference-open` and `conference-cancel`, `settings-set` (twice), `settings-remove`,
`dispatch-tiers-set`, `dispatch-classes-set`, `dispatch-mode-set`, `template-admit`,
`attestation-enable`, and one `work-create` carrying an actor after attestation. The
generator script is not committed.

## Operation families not covered

These need an outside authority file or a record kind the CLI no longer writes, so this
fixture cannot carry them; replaying them unchanged is proved on the real chain, read-only,
at acceptance:

- a gate transition carrying an identity decision (needs the identity authority file);
- a work transition carrying a telemetry evidence reference;
- persona, profile binding and host configuration events (their verbs were retired before
  this fixture was written);
- a `relocations` ledger in `workspace.json`;
- storage version 1 JSON segments.
