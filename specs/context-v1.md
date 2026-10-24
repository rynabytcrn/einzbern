# Context V1

## Scope & Applicability

This document is normative and describes the context document admitted by
`validateContextDocument` against `context-v1.schema.json`. A context document
binds one project to a deduplicated, ordered set of live work and knowledge
identifiers at a strict generation instant. It inherits every canonical-JSON,
ordering, instant, identifier, and extension rule from `protocol-common-v1`. A
context document carries the AOS requirement `AOS-REQ-008` (deterministic
context). This document also anchors the context-route injection budgets that
the retired activation ladder's session-start summary and persona rendering cited.

## Record Shape

The field set is exact and closed (`additionalProperties: false`): a context
document has precisely `schemaVersion`, `id`, `projectId`, `workIds`,
`knowledgeIds`, `generatedAt`, and `extensions`, with no other keys.

| Field           | Rule                                                      |
| --------------- | -------------------------------------------------------- |
| `schemaVersion` | the constant string `tcrn.context.v1`                    |
| `id`            | a `stableId`                                             |
| `projectId`     | the anchoring project `stableId`                         |
| `workIds`       | an array of unique `stableId`, complete within the executing runtime    |
| `knowledgeIds`  | an array of unique `stableId`, complete within the executing runtime    |
| `generatedAt`   | a `strictInstant`                                        |
| `extensions`    | the shared closed extension map (complete within the executing runtime)     |

Both identifier arrays are validated by `assertSortedUnique`: each element is a
protocol identifier, the array is duplicate-free, and it is already sorted in
`utf8-byte-order-v1` order. Every referenced identifier must resolve to a live
(non-tombstoned) record of the same `projectId` in the supplied work graph and
knowledge set; the work graph itself is validated by the work-model rules.

## Digest & Canonicalization

A context document is hashed with the shared `canonicalSha256` rules: recursive
key ordering by `utf8-byte-order-v1`, safe integers only, one terminal LF.
Producers MUST sort `workIds` and `knowledgeIds` before hashing or exchange; an
unsorted array is rejected rather than silently reordered, so the hashed bytes
are a stable function of the referenced set.

## Context-route injection budgets

The current command catalog exposes context-document admission, not the retired
fixed-budget context router. The former 1024/4096/65536-byte and 16/64-count
router table is not a current product capacity contract. Current injection and
retrieval consumers read the selected project's settings; callers can choose
explicit prompt/result budgets. Those budgets limit a chosen response window,
not storage, replay, canonical admission or the complete dataset. A host's actual
immutable input capacity remains separate and must be observed from that host.

## Reason Codes

Context-document admission emits codes from the shared `PROTOCOL_REASON_CODES`
list: `RECORD_MALFORMED`, `CANONICAL_VALUE_INVALID`, `ID_INVALID`,
`TIMESTAMP_INVALID`, `INPUT_OVERSIZED`, `CANONICALIZATION_MISMATCH` (an unsorted
identifier array), `REFERENTIAL_INTEGRITY` (a referenced identifier absent or
cross-project), `TOMBSTONE_REFERENCED` (a referenced record is tombstoned), and
`UNKNOWN_REQUIRED_EXTENSION`. Context routing emits its own `CONTEXT_*` codes,
including the budget codes above.

## Ordering & Determinism

Both identifier arrays are total-ordered by `utf8-byte-order-v1` and are the only
ordered arrays in the record; object keys serialize in the same order under
canonical JSON. Given the same live references, the emitted bytes and digest are
identical across producers.

## Failure Semantics

Admission is fail-closed and total: a context builder MUST resolve every
non-tombstoned reference before emission, and the first violated rule throws with
its specific reason code and no document is returned. Unknown optional extensions
are preserved byte-semantically; an unknown required extension prevents
admission.

## Non-Goals

A context document does not embed record bodies, transport, credentials, or a
live-service claim; it references identifiers only. The context-route budget
table governs injection sizing, not membership. Building the underlying work
graph and knowledge records is out of scope here.

## Full work content handoff (INIT-068)

`work-show` adds `content` (the canonical typed content or null for legacy) and
`workContent`, the same read-only `tcrn.work-content-context.v1` object used by
`work-project-context`, process target handoffs (`EINZBERN_PROJECT_CONTEXT`) and
native host target handoffs. Coordination with `targets=[]` retains its top-level
work content and does not fabricate a development target. A read projection is
not authorization, host-consumption proof, or a second source of requirements.

The projection includes full direct and ancestor records, canonical source text
and extraction status, source locators/versions, constraints, requirements,
allocations, versioned acceptance and evidence, compatibility fields, effective
requirements with inherited/direct provenance, and unresolved structure. Legacy
sources remain explicitly unverified. `complete` means delivery/ancestry is
complete, not that source extraction or semantic acceptance passed. Child prose
never overrides ancestor constraints. Implementation admission uses the same
policy-aware start checks as lifecycle admission; discovery is not implementation.

`work-draft --kind <Initiative|Epic|Story|Subtask> --project-id <id>` supplies typed
`content`, `missing`, applicable `contentPolicy` and `contentTemplate` alongside
legacy compatibility fields. `--variant defect` is only valid for Story.
`--parent-id` adds full inherited context and must resolve in the same project.
Completion is not fabricated in drafts. `work-create` and `work-annotate` accept
`--content <JSON>`; canonical content cannot be combined with legacy text inputs.

`work-content-context --id <id> [--offset N --limit N --digest SHA256]` retrieves
the same projection as segmented JSON text. Offsets count Unicode code points,
not bytes: Chinese and supplementary characters are never split. The result
identifies delivered and omitted half-open ranges, total, digest, `truncated`,
`complete`, and `nextOffset`. Concatenate segment text before parsing JSON.
Any continuation with nonzero offset requires the first digest, which covers
all direct/ancestor/source versions; changes refuse with
`WORK_CONTENT_CONTEXT_CHANGED` rather than mixing snapshots. Without a limit the
complete document is returned. Oversized responses refuse explicitly with
`WORK_CONTENT_CONTEXT_OVERSIZED` and a bounded retrieval remedy; they never
silently emit a successful shortened context. Each host must actually consume
all required segments; a receipt or a digest alone does not demonstrate that.

Legacy process and DotExecutionRequest inputs accept optional `action`:
`implementation`, `research`, or `coordination`. The discriminator is not a
permission grant. For content-enforced work with start problems, an omitted
action refuses with `work-content-action-required` at any status, including
planned; it is never silently interpreted as research. Explicit implementation
refuses the same start problems. Explicit research/coordination preserve their
existing admission and readiness checks and may gather missing information.
Unenabled legacy work without applicable content problems remains compatible.
`execution-prepare --action` retains the selector in its request binding;
`work-project-context --execution-request` and legacy native preparation JSON
carry the same optional field. Prior saved receipts remain unchanged. Older
readers that do not understand the additive field reject it rather than treating
it as authorization; use a compatible engine or the native HostExecutionRequest
path, not removal of a safety-relevant action to bypass a refusal.

## Recorded change impact

The native annotation reducer records `advisory:work-content-impact` bound to
previous/current revisions and structural meaning digests. `work-annotate`
returns that persisted value as `contentImpact`; `work-show.contentImpact` and
each `workContent.records[].contentImpact` read the same value, including changed
requirement/acceptance IDs, affected nonterminal work and evidence locators.
It is the last actual content change, not a speculative comparison with a raced
read. `acceptanceMeaningDigests` in each context record provides per-acceptance
structural binding inputs from the shared core helper. Neither these digests nor
impact lists prove semantic acceptance or authorize a scope change.

## Rollout readiness readback (R15/R16 v2)

`settings-catalog` returns `contentRollout.persisted`, separating the selected
project's stored policy/observation from its current structural readiness.
Optional `--work-content-observation <JSON>` adds `contentRollout.preview` using
machine-assembled observed evidence; it never writes the supplied observation,
changes a floor, installs a client, enables rules, or grants approval. It is not
a new admission stage or a request that a user manually assemble JSON.

Preview checks bind the current accepted head/vector; persisted observations
retain their original accepted boundary. Native engine code supplies the actual
running version and current manifest floor, not caller-reported or registered
versions. Reports distinguish the setting floor, manifest floor, effective floor,
capable release and unresolved writer/evidence gaps. Null or incomplete inputs
remain explicitly not ready; no synthetic V or same-name candidate version is
reported as an actual delivered release. Caller evidence references remain
unauthenticated and cannot prove unseen writers absent.

`work-draft`, `work-show`, and top-level `work-project-context` expose the same
policy-aware `contentRolloutReadiness` report for stored observations. This is
rollout information, not a new blocker for unrelated existing research/work.
Project rules remaining disabled does not mean the library floor is lowered or
that unchanged projects can use incompatible clients. Real floor changes,
client upgrades, and production enablement require their separate authorized
operations and actual evidence; these read commands perform none of them.

## Private dot extension source write (R19)

`dot-extension-source-set --source <JSON> --verification <JSON>` writes the
existing `dot.extensions.source` variable through its specialized native setter.
It retains the variable write's `--workspace`, `--at`, `--actor`, `--project-id`,
`--decided-in` and `--timeout-ms` contract, model-write authorization, write lock,
project projection and readback. Type is string and exports are always empty;
there is no alternate source store or public export switch. Ordinary
`variable-set` retains its existing privacy checks unchanged.

The source is data, not publication approval. Verification is an ephemeral
machine-assembled `{gitExecutable,scratchRoot,repositories:[{key,root}]}` binding:
absolute paths identify the actually authorized local executable, scratch and
repository roots; source metadata carries portable logical repository keys only.
The binding cannot grant filesystem authority, select remote fetches or execute
source code. Bindings are never saved in the source or emitted in its readback.
The native operation verifies exact typed commit occurrences against real local
Git objects before saving; self-declared hashes or prior success do not suffice.
Unrelated credentials and opaque strings retain ordinary privacy refusals.

Existing `setup --dot-input <file>` passes `extensionVerification` in its dot
options, without a new setup flag. Planning and applying reverify current local
objects; saved-source readback alone remains unverified for synchronization and
reconstruction. See `dot-rules-v1.md` for the typed occurrence schema and supported
local Git layouts. Unsupported backup/restore of typed references must report an
explicit unsupported gap, never claim complete recovery or mislabel a verified
technical identity as a secret. No command here grants remote writes, target
publication or approval of source text.
