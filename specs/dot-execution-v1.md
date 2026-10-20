# dot execution admission v1

`dot-autonomous`, installation target `chatgpt-dot`, actual actor, and `native-tool`
evidence are separate identities. The native branch is explicit; it does not extend
legacy host enumeration or borrow another host's policy, quota, or selected tuple.

`DotExecutionRequest` has the complete installed closed shape below; the public
engine validator checks it without requiring any source checkout.
`selfModelSelection`, `modelTier`, `modelEscalation`, and `accountQuota` are always
`not-applicable`, never pass. Actual model metadata is observed with a source or
unavailable with a reason. Exact requested delegation needs matching native
interface capability and actual invocation metadata; refusal applies to that
request only.

Work, scope, target, permission, tools, state, actual-session context, output and
verification checks all need evidence. Unknown refuses. The project-context
consumer independently compares current work revision and scope, selected target,
terminal work state and repository/output/language/design readiness. A read-only
context is never dispatch admission; coordination-only and empty targets refuse.
A frozen-scope input is a distinct type, not an escape from revision checks: the
current project consumer refuses it until a supported freeze authority is present.

Concurrency is the minimum of device, project and observed platform caps, less
actual occupancy. Parent inclusion is explicit. Missing occupancy is unknown,
not zero. Observations older than five minutes or in the future refuse. This
point-in-time receipt reserves no slots and does not authenticate caller evidence.

Traditional execution admission, quota freshness, policy revision, runner/model/
effort matching and process return contracts remain unchanged. Source-development
exceptions are not represented in this protocol.

The actual dot project consumer reads device concurrency settings but does not
read unrelated engine host-policy/quota files. It returns an explicit
not-applicable policy descriptor, not a fabricated configured host. Native
preparation binds one explicit selected target; targetDispatchAdmitted does not
claim that every other target in a cross-project work item is admitted.

## Installed input contract (authoritative v1 closed JSON)

This file ships at `specs/dot-execution-v1.md` relative to the installed engine
bundle root, alongside `scripts/einzbern.mjs`. It is usable without TypeScript
sources. `execution-native-prepare --request <private-json>` and
`work-project-context --execution-request <private-json>` consume this shape.
Notation below describes JSON, not executable code: `?` means omit the property;
`| null` means an explicit JSON null is allowed; otherwise every property is
required. Objects reject undeclared properties. Strings are actual nonempty
observations, not suggested values. `Sha` is a lowercase 64-hex SHA-256 string,
`Instant` a strict UTC ISO instant ending in Z, `Int` a safe JSON integer, and
`Ref` a nonempty source/evidence reference. Arrays preserve actual observations.
Canonical JSON uses sorted object keys, original array order, compact JSON and
exactly one terminal LF; numbers must be safe integers. Hash these UTF-8 bytes,
not indented presentation text. Source-file sha256 values instead hash the exact
read file bytes; retain already produced scope/content digests unchanged. These
digests detect content changes, not origin authentication.

```typescript
type RevisionBinding =
  | {kind:"revision", workRevision:Int /* >=1 */, scopeDigest:Sha}
  | {kind:"frozen-scope", scopeDigest:Sha, frozenAt:Instant, freezeEvidenceRef:Ref};
type Check = {status:"pass"|"fail"|"unknown", evidenceRefs:Ref[], reason:string};
type SourceKey = "agents"|"mana-orchestrate"|"work";
type SourceFile = {logicalKey:SourceKey, sourceVersion:string, sha256:Sha,
  readMethod:string, evidenceRef:Ref};
type ContextRead = {
  record:{schemaVersion:"tcrn.execution-context-read.v1", sessionRef:Ref,
    readAt:Instant, workReference:string, workRevision:Int, scopeDigest:Sha,
    files:SourceFile[], effectiveRoots:string[]},
  expected:{sessionRef:Ref, workReference:string, workRevision:Int, scopeDigest:Sha,
    notBefore:Instant, now:Instant,
    files:{logicalKey:SourceKey, sourceVersion:string, sha256:Sha}[],
    effectiveRoots:string[]},
  observations:{sessionRef:Ref,
    source:"execution-session"|"parent-session"|"patrol"|"unavailable",
    logicalKey:SourceKey, evidenceRef:Ref, toolName:string, readAt:Instant,
    sha256:Sha, association:"associated"|"unverified"}[]
};
type DotExecutionRequest = {
  mode:"dot-autonomous", executionTarget:"chatgpt-dot",
  libraryId:string /* library: or workspace: followed by 24 lowercase hex */,
  projectRef:{libraryId:string, projectId:string /* project: + 24 lowercase hex */},
  workId:string /* work: + [a-z0-9][a-z0-9._-]{0,127} */,
  revisionBinding:RevisionBinding, requestedAgents:Int /* >=1 */,
  requiredTools:string[] /* nonempty */, actualCapabilityEvidenceRefs:Ref[] /* nonempty */,
  authorizationEvidenceRef:Ref,
  checks:{work:Check, scope:Check, target:Check, permission:Check, tools:Check,
    state:Check, context:Check, output:Check, verification:Check},
  occupancyObservation:{status:"observed"|"unknown", activeAgents:Int|null,
    includesParent:boolean, parentActive:boolean, platformLimit:Int|null,
    observedAt:Instant, evidenceRef:Ref},
  modelObservation:{status:"unavailable", reason:string}
    | {status:"observed", value:string, sourceRef:Ref},
  contextRead?:ContextRead,
  exactDelegation?:{runner:string, model:string, effort:string, supported:boolean,
    actualInvocationMetadataRef:Ref|null,
    observedTuple?:{runner:string, model:string, effort:string}}
};
```

A pass Check requires nonempty evidenceRefs. The context check is independently
rebuilt from ContextRead, never accepted because checks.context says pass.
Both file arrays contain each SourceKey exactly once; roots are nonempty, unique,
normalized absolute paths. Record/session/work/revision/scope, current source
versions and hashes, effective roots and actual execution-session tool returns
must match. Reads occur between notBefore and now. Parent/patrol/unavailable or
unverified observations cannot establish execution-session reading. Missing
contextRead is representable only to obtain an honest refused/unknown result.
The project consumer replaces work/revision/scope/time/roots expectations with
its current materialized observations. The saved admission retains those exact
expectations so record, evidence and review reassess the same association.

Observed occupancy requires activeAgents >=0 and platformLimit >=1; unknown
requires both null. includesParent describes whether the observed count already
includes the parent; parentActive states the actual parent activity. Never infer
an empty platform from missing observations. Current engine device/project limits
are read by the consumer, not supplied by this JSON. The projectRef.libraryId
must equal libraryId. Frozen scope remains refused by the current project
consumer without independent supported freeze authority.

### Assemble from actual sources, not from the example notation

- Get stable work/target identity, revision, scope, readiness and repository roots
  from the existing work/project read surfaces. Use the same current scope in the
  three-source expectation. Do not create a project identity to fill this input.
- Read AGENTS, installed Mana and current work in the actual executing session.
  Preserve tool-return references, source versions, canonical hashes, read method
  and actual timestamps. Match those returns to each observation. An unavailable
  tool relationship stays unverified/unknown rather than invented.
- Read the current native tool contract and capability, actual occupancy, and
  applicable authorization; copy their source references. Record each missing or
  failed precondition as unknown/fail. Passing an output test is not provider
  completion or permission.
- Use observed native model metadata only when exposed. Do not infer your own
  model tier/quota. Exact delegation values come from the user's requested tuple
  and actual invocation metadata, not another host's configuration.
- Save the returned preparation verbatim in private create-new storage. A digest
  is content association, not authentication. This command does not call a native
  tool, reserve capacity, complete work, or provide G5/E4 evidence.
