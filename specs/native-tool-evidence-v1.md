# Native tool evidence v1

An engine-generated local random attempt ID is not a provider ID. An admitted
attempt binds library/project/work, revision or supported frozen scope, admission,
tool contract, argument digest and request time. No response means an attempt
with unknown execution and finality, not a synthetic response envelope.

`recordNativeToolResponse` consumes actual response JSON, its private source
reference, tool name, observed time and explicit source observations. Provider
fields are extracted only from declared JSON pointers. Status needs a raw field
and explicit mapping. Confirmed finality requires the same observed tool contract
and a terminal field, not a completion sentence or passing deliverable.

Association requires actual invocation/response references and matching arguments.
Without that linkage the raw return can be retained as unverified. Source labels
and hashes do not authenticate a provider. Review consumes the complete attempt,
admission, original response and rebuilt envelope, not a standalone passed flag.
The normalized result preserves unverified rather than labelling it associated.
Verification pass/fail is independent, with reviewer, time and evidence references.
Process selectedTuple/stdout/stderr/exitCode are not native envelope fields.

History preserves all returns. Provider event identity excludes independent
verification: equal event key/content, deliverable set and verification are idempotent and retain
each observation time; different independent checks of the same raw return retain
separate original records, not a provider-content conflict.
Conflicting provider content, tasks, revisions or tools refuses.
Late returns never downgrade confirmed finality. A retry must create a new local
attempt and preserve the old attempt; an unknown outcome must first be queried,
never interpreted as not executed. Private outputs use the existing create-new
0600 dispatch-artifact writer outside device and library roots.
Conflict results also retain the rejected source record. Retry request time must
follow its actual reconciliation observation; neither attempt is redated.

A complete review requires associated, provider-confirmed reported-completed and
the latest valid independent verification of that attempt's same nonempty
deliverable resultRefs to pass. Execution finality and verification are separate:
a later bound failure invalidates an earlier pass without reopening execution.
Failed/cancelled returns remain retained failures;
accepted/running or delivery pass without terminal evidence is not complete.

The saved native record wrapper can be read directly by the evidence command.
Its cached assessment is ignored and rebuilt from original sources. Review routes
native records to that official command; an older engine without it refuses rather
than interpreting native output as process evidence. A complete native assessment
still does not itself prove the separate G5 engine-write/readback or E4 acceptance.

## Installed CLI and complete input shapes

Read this file at `specs/native-tool-evidence-v1.md` in the engine bundle. The
request shape and primitives Ref/Sha/Instant are fully defined in the adjacent
`dot-execution-v1.md`. JSON objects below are closed; all fields are required
unless `?` is shown. Null is accepted only where shown. No process fields, local
IDs relabelled as provider IDs, or invented tool returns are permitted.

1. `execution-native-prepare --workspace <actual-library> --request <json>
   --tool <actual-tool-name> --tool-contract <json> --arguments <json>
   --output <new-private-file>` consumes DotExecutionRequest, the contract object
   `{ref:Ref,sha256:Sha}`, and the exact JSON argument value intended for the tool.
   Contract ref/hash come from the actual exposed native contract, not the package
   spec or a made-up provider version. Output is the full engine-generated
   `tcrn.native-dispatch-preparation.v1` binding. Preserve it verbatim, including
   context, selected target, admission, attempt and digest. Refused preparation
   has no executable attempt and cannot be recorded as successful dispatch.
2. Invoke the actual native tool only if authorized and actually supported.
3. `execution-native-record --binding <saved-preparation> --response <json>
   --prior <previous-saved-record> --output <new-private-file>` records an actual
   return. Omit response only when none was returned; this retains pending rather
   than fabricating evidence. Omit prior only on the first record of this attempt.
   Every subsequent observation carries the previous saved output, including its
   full history. Each output is create-new; do not overwrite the predecessor.
4. `execution-native-evidence --from-file <saved-output> [--work-id <id>]
   [--work-revision <integer>]` and the existing review surface revalidate original
   sources and history. Cached normalized claims confer no authority.

```typescript
type NativeStatus = "accepted"|"running"|"reported-completed"|"failed"|"cancelled"|"unknown";
type NativeToolResponseInput = {
  sourceTool:string, rawResponseRef:Ref, rawResponseValue:Json,
  observedAt:Instant, executionStatus:NativeStatus,
  statusPointer?:string, statusMapping?:{[actualRawStatus:string]:NativeStatus},
  providerPointers?:{providerRef?:string, providerEventRef?:string,
    providerStartedAt?:string, providerFinishedAt?:string},
  resultRefs:Ref[],
  association:{status:"associated"|"unverified"|"invalid",
    invocationRef:Ref|null, responseRef:Ref|null, argumentsDigest:Sha|null,
    evidenceRefs:Ref[], reason:string},
  terminalObservation?:{jsonPointer:string, terminalValues:string[],
    contractRef:Ref, evidenceRef:Ref},
  verification:{status:"unverified"|"pass"|"fail", evidenceRefs:Ref[],
    verifiedAt?:Instant, verifiedBy?:Ref}
};
```

Json is an actual protocol-canonical JSON response value (numbers must be safe
integers, objects must be plain JSON; hashing adds exactly one terminal LF); null, missing and empty object/array are
not actual returned evidence. A non-unknown executionStatus requires statusPointer
and statusMapping. Pointers are RFC 6901 paths beginning `/`, with only `~0`/`~1`
escapes, and must resolve in rawResponseValue. Compare the raw pointed value's
string representation with the explicit mapping derived from the actual tool
contract. Provider pointer values must be actual nonempty strings; provider time
values must be UTC instants. Missing provider IDs stay omitted.

For associated status, invocationRef and evidenceRefs are nonempty, responseRef
matches rawResponseRef, and argumentsDigest matches the saved attempt's actual
argument digest. If the platform cannot expose this association, use unverified
with unavailable linkage nulls, not invented references. RawResponseRef is the
actual private observation/storage reference; it is not event content identity.
Duplicate event bytes at another storage reference are idempotent. A same event
key with different bytes or inconsistent status/finality is a retained conflict.

Only reported-completed/failed/cancelled can carry terminalObservation. Its
contractRef must equal the saved observed tool contract; the actual raw field's
string value must appear in the nonempty terminalValues observed from that
contract. Do not infer terminality from a sentence or a delivered file. Verification
pass/fail requires evidenceRefs, verifiedAt and verifiedBy from the actual
independent verification; unverified can omit those two optional fields.
To add a later verification of an existing return, retain its original raw bytes,
source reference and observedAt; supply the actual new verification, carry the
previous saved output with `--prior`, and write a new output. Do not invent a new
provider return or redate the old one to represent the independent check.

The saved output contains `record` (complete preparation, attempt, admission,
response and rebuilt evidence; response/evidence absent when pending), `history`
(records, event observation keys/times/sourceRefs, derived current evidence), `appendStatus`
(pending/appended/duplicate/conflict), `problems`, optional `rejectedRecord`, and
`normalized`. The normalizer rebuilds every retained record and current state,
requires selected target readiness and repository roots consistent with the saved
three-source context, and rejects a bare attempt/admission as dispatch completion.
Conflicts retain execution responsibility. History `current` selects execution
state, not an immutable verification result. A late accepted/running observation
cannot downgrade an associated confirmed terminal result. Completion separately
uses retained associated checks with the same attempt and exact resultRefs set
as that terminal result. A check's verifiedAt must not predate either the terminal
observation or its own source observation. The newest valid verification time
wins; a fail wins a same-time pass/fail tie. Unverified, stale, unrelated or
evidenceless observations cannot promote completion or erase a retained failure.
A late execution observation may carry a new bound independent check, but cannot
change execution finality. Histories are bounded at 256 distinct source/check
records and 1024 observations, retry ancestry at 16; reaching a
bound refuses another append, never deletes earlier evidence.

### Explicit retry inputs

Only a retry uses the paired optional prepare flags `--retry-from <previous-saved-
record>` and `--reconciliation <json>`. Neither is valid alone. The previous saved
artifact and this reconciliation are retained in the new preparation's `retry`
field and covered by its digest. The new attempt has a new local ID and the same
work/project/tool identity. Unknown outcomes must be queried first; retry is not
an alternative to recording an existing response.

```typescript
type NativeRetryReconciliation =
  | {outcome:"confirmed-terminal", record:NativeToolRecord}
  | {outcome:"confirmed-not-executed", queryTool:string, queryRef:Ref,
      queriedAttemptId:string, responseValue:Json, observedAt:Instant,
      notExecutedPointer:string, notExecutedValue:string, contractRef:Ref};
```

NativeToolRecord is the verbatim `record` from a previously generated saved output,
not a hand-assembled completion flag. Confirmed-terminal must be an associated,
confirmed failed/cancelled record for the exact predecessor. A non-execution
query must come from the actual query tool/return, bind the previous attempt ID
and exact observed contract, and expose the matching notExecutedValue at its
pointer. The query/terminal observation cannot predate the original attempt; the
new request cannot predate reconciliation. Completed, conflicting or unresolved
predecessors never become retries merely because another local filename or UUID
is available. No SDK, global attempt database or automatic tool call is implied.
