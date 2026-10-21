# Engine Model Policy V1

## Status and scope

The model policy is engine/device state. There is one file at
`<deviceHome>/engine-model-policy.json`; it is not copied into project or library settings.
The top-level `hosts` object separates policy records by host id. A host policy contains its
categories mother table, ordered tiers, and escalation `{enabled, threshold, ceiling}` tuple.
An absent file is an empty store: the engine does not invent a model choice.

This contract covers storage, validation, provenance, runtime tier resolution, and the CLI/Atelier read and write surfaces.
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

A host entry may additionally declare `quota`, an exact object containing
`fiveHourParallelOffPercent`, `fiveHourWaitPercent`, `weeklyParallelOffPercent`, and
`weeklyWaitPercent`. Thresholds are integers from 1 through 100; `weeklyWaitPercent` also
accepts null (no weekly wait). A wait threshold must not be below its parallel-off threshold.
These are policy thresholds, never account usage or balances. Historical entries without quota
remain valid and are not rewritten. The resolver reports separate engine defaults
75 / 90 / 95 / null with `quotaOrigin: engine-default`; configured values report
`quotaOrigin: device-host-policy`. Projects cannot override these host thresholds.

The digest is SHA-256 of canonical JSON for `{host, categories, tiers, escalation}` when
quota is absent, preserving every existing digest. When quota is present, it is included as
the `quota` member in that digest object. Each host
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

## Runtime resolution and evidence boundary

`resolveEngineExecutionPolicy({host, category, rejections, home?})` reads the current device
file and delegates to the same ordered tier/escalation algorithm used by
`resolveEngineExecutionPolicyFromSnapshot(snapshot, input)`. The snapshot version validates
its complete input and binds the selected tier and origin to that single revision. Both return
`record`, `steps`, `atCeiling`, host/category/rejections, escalation, effective quota,
`quotaOrigin`, and origin `{kind: device-engine, path, revision, storeRevision, digest}`.
The file and host revisions are separate. This is a runtime handoff, not a portable project
configuration artifact, and does not alter a host application's default model.

Resolution starts at the selected category's largest-order tier, moves toward smaller orders
once per threshold rejections, and stops at the ceiling category's smallest-order tier.
All tiers remain within the requested host. Disabled escalation returns the base tier.
For a configured Codex table with flagship Astra, main Sol/max, and economy ordered
Sol/low, Terra/max, Terra/medium, Luna/max, threshold 2 and ceiling main yield:

- Returns 0–1: gpt-6-luna/max.
- Returns 2–3: gpt-5.6-terra/medium.
- Returns 4–5: gpt-5.6-terra/max.
- Returns 6–7: gpt-6.1-sol/low.
- Returns 8 onward: gpt-6.1-sol/max; no automatic Astra.

This describes a supplied policy, not an installed default or hardcoded fallback. Missing
hosts, blank selected model/effort, and a selected tuple absent from caller-supplied
`availableCombinations` fail with `ENGINE_MODEL_POLICY_UNAVAILABLE`. Invalid stores,
unknown categories, and malformed rejection counts retain their explicit validation errors.
No error substitutes another model, runner, or project's historical Codex policy.

Capability evidence is separate from policy validity. Without an adapter-supplied tuple list,
`capabilityStatus` is `unchecked`; a match reports `verified-by-caller`, not a claim that the
engine executed a live native tool. The resolver does not infer capabilities from a vendor roster.
Historical model-plan and settings events remain unchanged and replayable.

`resolveExecutionConcurrency(deviceLimit, projectLimit?)` computes the smaller positive
integer and reports its origin; a project budget never raises the device cap.
`evaluateExecutionQuota(policy, observation)` is a pure advisory decision with parallel,
serial, wait, or unknown results. Observations are separately supplied percentages; missing
windows are unknown, never zero. Known restrictions take priority in the order wait, serial, unknown, parallel; a missing
window never erases a known wait or serial restriction. The function does not retrieve account usage, attest its freshness, or dispatch work.
Tests of these helpers establish policy behavior, not actual account monitoring or native
host acceptance.

## Operator and dispatch integration

Before preparing an agent invocation, use the read-only command:

```
einzbern execution-policy-resolve --host codex --category economy --rejections 4
```

Use the returned `record.runner`, `record.model`, and `record.effort` verbatim. Keep the
returned origin revision and digest with the dispatch evidence, and retain the actual host
acceptance or refusal separately. An unavailable policy is a blocker, not permission to select
another model or use the host default. Rejection counts belong to the work's existing ledger;
this command neither increments nor resets that ledger.

`--project-budget <positive integer>` can tighten, never raise, the device
`execution.maxConcurrentAgents` cap. `--usage <json>` can pass separately observed
`fiveHourUsedPercent` and `weeklyUsedPercent`. The command returns the effective concurrency
and quota decision alongside `observationSource`: absent usage is unavailable, supplied usage
is caller-supplied-unverified. Do not interpret absent observations as spare quota. A returned
wait decision means the orchestrator must defer dispatch; the read-only command itself does
not acquire a slot, launch a process or wait for an account reset.

`work-project-context` and handoff carry the engine-host source separately from project
configuration. `settings-catalog` includes the configuration dictionary and typed declaration
readback; historical project model/quota values there are not the runtime selected tier.
Shared AGENTS content points to this runtime contract rather than embedding a device's chosen
models. These source-level integrations do not modify an external Skill repository, install a
live release, or prove native tool support.

Runtime project handoffs carry `executionConcurrency` resolved from the device cap and
the target project budget. This is a bounded scheduling contract, not proof that an external
host acquired a slot. Quota observations and restrictions remain separately identified.

## INIT065 separately governed exact saving (v2 transaction store)

Normal native execution does not call this path. `engine-model-policy-save --workspace <library> --host <id> --changes <json> --expected-host-revision <n> --expected-host-digest <digest|absent> --operation-id <nonsecret-id> --at <UTC> --actor <actual-actor> --decided-in <Owner-decision>` uses the same supported Owner decision verifier and models.engine-policy target as the existing setter. Existing saving authorization is reused; this command does not request repetitive approval or treat temporary execution permission as persistent-save authority.

For an existing host, changes is exactly `{tiers:[{order,model,effort},...]}`. Only explicitly named existing tier tuples change; categories, runner, tier order/category/note, escalation, quota, other tiers and other hosts remain intact. Unknown rows, duplicates and empty patches fail. For an absent host only, changes may instead contain an explicitly approved complete `{initialPolicy:...}` with expected revision 0 and digest `absent`. A tuple alone never invents the missing category/escalation configuration.

The writer validates actor/decision and patch, acquires the existing policy lock, reads the current valid store, checks an existing operation for exact idempotent replay, then compares expected **host** revision and digest. Other-host changes do not cause a false same-host conflict or get overwritten. After merging it validates the whole host policy, atomically writes and reads back under lock. No direct plugin projection write is supported. A same-host change returns ENGINE_MODEL_POLICY_CAS_CONFLICT and preserves bytes; reuse of an operation ID for different changes returns ENGINE_MODEL_POLICY_OPERATION_CONFLICT. There is no force-CAS bypass.

The first transactional save upgrades the store envelope to `tcrn.engine-model-policy.v2`, retaining existing hosts and adding a closed `operations` map. Each operation stores id, host, changeDigest, expectedRevision/expectedDigest, committed storeRevision and exact result host entry (including actual actor/decision). All reside in the same atomic file: a crash after the write cannot commit policy without its replay receipt. The change digest binds host, expected snapshot, exact changes, actor and decision; retry time is not part of that identity. Digests establish consistency, not platform authentication.

Repeated same operation/change returns `replayed` with its original operation result and the current store readback, without a write or revision increment, even if a later authorized write changed that host. Never mistake the original operation result for current configuration. An unknown result is reconciled by reading this receipt/current policy before retry. The legacy full setter preserves v2 receipts if used on a v2 store; it does not acquire the new command's CAS semantics implicitly.

V1 stores remain readable and are not rewritten by reads or dispatch. V2 requires this reader; old engines with closed v1 schema correctly reject it. Downgrading a binary alone is not a successful configuration rollback. Any approved downgrade migration must preserve the operation evidence and explicitly produce an old-compatible store through a separately supported migration; this delivery does not invent a destructive ledger-stripping command. Configuration rollback uses a new operation and current host CAS, creating a new revision rather than falsifying history.

Saving failure never revokes authorized temporary execution, unless the user explicitly required saving before execution. Saving tests/acceptance are recorded separately from core T01–T03. No real device configuration is changed by developing or testing this contract.
