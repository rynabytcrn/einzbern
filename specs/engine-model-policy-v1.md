# Engine Model Policy V1

## Status and scope

The model policy is engine/device state. There is one file at
`<deviceHome>/engine-model-policy.json`; it is not copied into project or library settings.
The top-level `hosts` object separates policy records by host id. A host policy contains its
categories mother table, ordered tiers, and escalation `{enabled, threshold, ceiling}` tuple.
An absent file is an empty store: the engine does not invent a model choice.

This contract covers storage, validation, provenance, and the CLI/Atelier read and write surfaces.
The catalogue identifies the policy source and preserves project `models.*` values as
read-only compatibility inputs with their recorded source. A project value does not override a
configured device policy. No write to the engine policy changes a project event or its old value.

## File schema

The closed file shape is:

```json
{
  "schemaVersion": "tcrn.engine-model-policy.v1",
  "revision": 1,
  "hosts": {
    "codex": {
      "revision": 1,
      "categories": [
        { "id": "flagship", "name": "Flagship", "description": "", "order": 10 },
        { "id": "main", "name": "Main", "description": "", "order": 20 },
        { "id": "economy", "name": "Economy", "description": "", "order": 30 }
      ],
      "tiers": [
        { "order": 10, "category": "economy", "runner": "codex", "model": "gpt-6-luna", "effort": "max", "note": "" }
      ],
      "escalation": { "enabled": true, "threshold": 1, "ceiling": "main" },
      "digest": "<sha256 of the canonical policy fields>",
      "updatedAt": "2026-10-17T00:00:00Z",
      "actor": "agent:codex",
      "decidedIn": "minutes:<24-hex-id>#D1",
      "decidedInLibraryId": "library:<24-hex-id>"
    }
  }
}
```

`categories` and `tiers` use the existing closed record formats from
`specs/settings-catalog-v1.md`. Every tier's `runner` must equal its enclosing host, and each
tier category and escalation ceiling must exist in that host's category table. The threshold is
a safe positive integer no larger than the engine's existing models escalation bound. Host ids
are lowercase ids. The file rejects unknown fields, invalid host partitions, impossible revisions,
invalid actor/decision/library identities, malformed UTC instants, and digest mismatches.

The digest is SHA-256 of canonical JSON for `{host, categories, tiers, escalation}`. Each host
revision increases on replacement of that host; the file revision increases on every successful
write. Writers serialize through the device lock for `engine-model-policy.json`, replace the
single file atomically, and validate the persisted file again before releasing the lock. A write
receipt is built from that lock-held snapshot, so a later write cannot mix its host row or audit
metadata into the earlier receipt.

## CLI and Atelier

- `engine-model-policy-catalog [--host <id>]` reads the device store. With `--host`, it returns
  either that host's configured record or an explicit `unconfigured` status.
- `engine-model-policy-set [--workspace <library>] --host <id> --policy <json> --at <instant>
  --actor <id> --decided-in minutes:<id>#D<n>` validates an Owner decision naming
  `models.engine-policy`, writes only that host record, and returns the stored policy readback.
  The workspace locates the decision; if omitted, the device registry resolves it from the current
  directory under the CLI's existing rules. It does not scope the resulting policy.
- `settings-catalog` keeps its existing project/library setting rows and adds `modelPolicy`, the
  device-engine catalogue plus the legacy model setting values and their source/declaration
  provenance. When both sources contain values, both remain visible and the device host record is
  identified as the model-policy source; the compatibility values are not silently rewritten.
- Atelier exposes the same engine catalogue and governed write through `/api/model-policy` and
  an **Engine model policy** page. Its host selector queries the device catalogue, displays the
  selected host's revision, source, audit decision, and legacy-precedence statement, and never
  changes the selected project configuration target. The page reuses the portal's save and undo
  controls; saving requires a cited Owner decision and sends the portal's actual actor through the
  governed endpoint. Reads and writes do not require a selected project target.

## Portal interaction contract

The settings compatibility rows for `models.category`, `models.tiers`, and the escalation keys
identify their historical / non-Codex source and link to the engine-host editor. They do not render
project-setting write controls for a compatible Codex policy. The category and tier pages use the
same editor, table, choice, numeric-entry, focus, keyboard, and receipt behaviors as the portal
collections; they are projections of the selected engine host rather than copies of project
configuration.

Every route that reads a model policy, including a full portal refresh, captures the requested
host, selected library identity, library epoch, and monotonically increasing read sequence. A
response is accepted only if all four still identify the same target. Switching hosts leaves an
old host's save unavailable while its replacement reads; switching libraries clears the old
library's drafts. A valid host id is an engine contract value, so per-host drafts and pending
writes use own-entry maps rather than prototype-keyed objects.

An unconfigured host can start with an empty category table. The editor can create the first
category and then complete every policy field: category `order`, `id`, `name`, and `description`;
tier `order`, `category`, `runner`, `model`, `effort`, and `note`; and escalation `enabled`,
`threshold`, and `ceiling`. Reset / undo discards an unsubmitted draft only; it never invents a
policy-delete operation.

The portal permits one write per host at a time. It records the exact draft version sent, keeps
Save unavailable until that request settles, and shows either the governed receipt or a failure
receipt. A success clears a draft only when the draft is still the exact sent version. Edits,
Owner-decision changes, Undo, locale changes, and refreshes made after send retain their newer
draft. A write also names the library that resolved its Owner decision; the endpoint rejects a
request if that library changed before the write begins.

## Compatibility

Historical `settings.updated` events and existing `models.*` records stay readable through the
ordinary settings catalogue and replay paths. This storage change does not migrate, delete, or
re-emit them. The engine policy file is the only new global source. Consumers must report their
effective source and may not substitute a project's old Codex value when the device policy for
Codex is unconfigured or invalid. Other host behavior remains attached to its own host-specific
policy and existing consumer until that consumer is explicitly connected.
