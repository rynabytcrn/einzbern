// SPDX-License-Identifier: Apache-2.0
// Deterministic receipt-consumer fixtures. No Codex host, RPC, wake or live peer test.
import assert from "node:assert/strict";
import test from "node:test";
import { prepareHostNativeDispatch } from "../dist/build/packages/core/src/dispatch-workflow.js";
import { recordHostNativeEvents } from "../dist/build/packages/core/src/native-tool-evidence.js";
import { applyEngineModelPolicySet, engineModelPolicyOnboarding } from "../dist/build/packages/core/src/engine-model-policy.js";
import { recordCodexPeerBatch as recordAtCutoff, normalizeCodexPeerBatch, codexPeerReportPrefix } from "../dist/build/packages/core/src/codex-peer-batch.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { nativeFixture, selection } from "./helpers/host-native-fixture.mjs";

const recordCodexPeerBatch = input => recordAtCutoff({ observationCutoff: new Date().toISOString(), ...input });
const at = "2026-10-30T00:00:00Z";
const response = (state, id = `host-${state}`) => ({ id, at: new Date().toISOString(), kind: "host-response", sourceTool: "fixture.spawn", raw: { state, terminal: true }, status: { pointer: "/state", mapping: { [state]: state } }, terminal: { pointer: "/terminal", values: ["true"], contract: "Synthetic terminal receipt contract" } });
async function fixture(t) {
  const f = await nativeFixture(t);
  const draft = engineModelPolicyOnboarding("codex");
  const policy = await applyEngineModelPolicySet({ home: f.home, host: "codex", actor: "agent:fixture", occurredAt: at,
    authorization: { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: f.state.metadata.workspaceId },
    policy: { ...draft, tiers: draft.tiers.map(row => row.category === "flagship" ? row : { ...row, ...selection.tuple }) } });
  const preparation = await prepareHostNativeDispatch(f.state, f.request, { selection, argumentsValue: { prompt: "Synthetic receipt fixture only" } }, f.home);
  assert.ok(preparation.attempt);
  const record = recordHostNativeEvents(preparation, []);
  const manifest = { schemaVersion: "tcrn.codex-peer-manifest.v1", host: "codex", batchId: "fixture-batch", attemptId: "fixture-batch-attempt", workId: f.work.id, workRevision: f.work.revision, policyDigest: policy.hosts.codex.digest,
    main: { conversationId: "fixture-main", sourceRef: "fixture:main-observation", raw: { id: "fixture-main" }, conversationPointer: "/id" }, coordinator: { conversationId: "fixture-economy", sourceRef: "fixture:coordinator-observation", raw: { id: "fixture-economy" }, conversationPointer: "/id" },
    members: [{ attemptId: preparation.attempt.id, workId: f.work.id, workRevision: f.work.revision, conversationId: null }] };
  return { ...f, preparation, input: { manifest, records: [record], policy, capacity: { limit: 3, active: 3 }, workRevisions: [{ id: f.work.id, revision: f.work.revision }] } };
}
const observed = (state, id = `host-${state}`, conversationId = "fixture-worker") => ({ ...response(state, id), raw: { state, terminal: true, conversationId }, providerId: { pointer: "/conversationId" } });
const finish = f => recordHostNativeEvents(f.preparation, [f.completedEvent ??= observed("completed")]);

test("unknown native outcomes retain occupancy; completion, failures and confirmed cancellation remain distinct", async t => {
  const f = await fixture(t);
  const pending = recordCodexPeerBatch(f.input);
  assert.equal(pending.allTerminal, false);
  assert.equal(pending.reportEligible, false);
  assert.equal(pending.occupancy, 1);
  assert.equal(pending.deliveryStatus, "not-attempted");
  assert.ok(pending.blockedReasons.some(reason => reason.startsWith("native-identity-unknown:")));
  assert.equal(pending.authority, "receipt-only-not-execution-authorization");
  for (const state of ["completed", "failed", "cancelled"]) {
    const record = recordHostNativeEvents(f.preparation, [observed(state)]);
    const terminal = recordCodexPeerBatch({ ...f.input, records: [record] });
    assert.equal(terminal.allTerminal, true, state);
    assert.equal(terminal.occupancy, 0, state);
    assert.equal(terminal.records[0].execution, state);
    assert.equal(terminal.reportEligible, true, "a terminal failure can be reported without relabeling success");
  }
  const cancelAck = recordHostNativeEvents(f.preparation, [{ id: "cancel-request", at: new Date().toISOString(), kind: "cancel-requested" }, { id: "cancel-ack", at: new Date().toISOString(), kind: "cancel-accepted", sourceTool: "fixture.cancel", raw: { accepted: true } }]);
  const cancelling = recordCodexPeerBatch({ ...f.input, records: [cancelAck] });
  assert.equal(cancelling.allTerminal, false);
  assert.equal(cancelling.occupancy, 1);
});

test("same-batch recovery and duplicate/late receipts never duplicate work or regress terminal evidence", async t => {
  const f = await fixture(t);
  const pending = recordCodexPeerBatch(f.input);
  const completed = recordCodexPeerBatch({ ...f.input, records: [finish(f)], prior: pending });
  const recovered = recordCodexPeerBatch({ ...f.input, records: [], prior: JSON.parse(JSON.stringify(completed)), observationCutoff: completed.observationCutoff });
  assert.equal(recovered.digest, completed.digest);
  const duplicate = recordCodexPeerBatch({ ...f.input, records: [finish(f)], prior: recovered, observationCutoff: recovered.observationCutoff });
  assert.equal(duplicate.digest, recovered.digest);
  const lateEvent = { id: "late-accepted", at: new Date().toISOString(), kind: "host-response", sourceTool: "fixture.spawn", raw: { state: "accepted" }, status: { pointer: "/state", mapping: { accepted: "accepted" } } };
  const late = recordCodexPeerBatch({ ...f.input, records: [recordHostNativeEvents(f.preparation, [lateEvent])], prior: recovered });
  assert.equal(late.records.length, 1);
  assert.equal(late.records[0].execution, "completed");
  assert.equal(late.occupancy, 0);
  assert.equal(normalizeCodexPeerBatch(late).digest, late.digest);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, attemptId: "another-batch-attempt" }, prior: recovered }), /immutable manifest/u);
  assert.throws(() => normalizeCodexPeerBatch({ ...pending, allTerminal: true, reportEligible: true }), /differs from retained/u);
});

test("capacity, policy/work drift, fixed identities and explicit host remain fail-closed", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  for (const host of ["unknown", "claude-code", "dsh", "dot"]) assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, host } }), /explicit Codex/u);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, coordinator: f.input.manifest.main } }), /independent conversations/u);
  const unknown = recordCodexPeerBatch({ ...f.input, records, capacity: { limit: 3, active: null } });
  assert.ok(unknown.blockedReasons.includes("capacity-unknown")); assert.equal(unknown.reportEligible, false);
  const exceeded = recordCodexPeerBatch({ ...f.input, records, capacity: { limit: 2, active: 3 } });
  assert.ok(exceeded.blockedReasons.includes("capacity-exceeded")); assert.equal(exceeded.reportEligible, false);
  const drift = recordCodexPeerBatch({ ...f.input, records, manifest: { ...f.input.manifest, policyDigest: "0".repeat(64) } });
  assert.ok(drift.blockedReasons.includes("policy-drift")); assert.equal(drift.reportEligible, false);
  const reused = recordCodexPeerBatch({ ...f.input, records: [recordHostNativeEvents(f.preparation, [observed("completed", "reused", "fixture-main")])] });
  assert.ok(reused.blockedReasons.some(reason => reason.startsWith("native-identity-reused:"))); assert.equal(reused.reportEligible, false);
  const changedIdentity = recordHostNativeEvents(f.preparation, [observed("completed", "first-id"), observed("completed", "second-id", "different-worker")]);
  const changed = recordCodexPeerBatch({ ...f.input, records: [changedIdentity] });
  assert.ok(changed.blockedReasons.some(reason => reason.startsWith("native-identity-drift:"))); assert.equal(changed.reportEligible, false);
  const missing = recordCodexPeerBatch({ ...f.input, records: [] });
  assert.ok(missing.blockedReasons.some(reason => reason.startsWith("member-outcome-unknown:")));
});

async function deliveryFor(f, events = [], action = "coordination", message = `${codexPeerReportPrefix(f.input.manifest)}Synthetic batch result`) {
  const preparation = await prepareHostNativeDispatch(f.state, { ...f.request, action }, { selection, argumentsValue: { recipient: f.input.manifest.main.conversationId, message } }, f.home);
  assert.ok(preparation.attempt);
  return { record: recordHostNativeEvents(preparation, events), recipientPointer: "/recipient", correlationPointer: "/message", batchId: f.input.manifest.batchId, batchAttemptId: f.input.manifest.attemptId };
}

test("report eligibility is not a send; attempted unknown delivery survives recovery without permitting resend", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  const eligible = recordCodexPeerBatch({ ...f.input, records });
  assert.equal(eligible.reportEligible, true);
  assert.equal(eligible.deliveryStatus, "not-attempted");
  const delivery = await deliveryFor(f);
  const attempted = recordCodexPeerBatch({ ...f.input, records, delivery, prior: eligible });
  assert.equal(attempted.deliveryStatus, "unknown"); assert.equal(attempted.reportEligible, false);
  const recovered = recordCodexPeerBatch({ ...f.input, records: [], prior: attempted, observationCutoff: attempted.observationCutoff });
  assert.equal(recovered.digest, attempted.digest);
  assert.equal(recovered.delivery.record.preparation.attempt.id, delivery.record.preparation.attempt.id);
  const completedDelivery = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("completed")], delivery.record) };
  const confirmed = recordCodexPeerBatch({ ...f.input, records: [], delivery: completedDelivery, prior: recovered });
  assert.equal(confirmed.deliveryStatus, "confirmed"); assert.equal(confirmed.reportEligible, false);
  assert.equal(recordCodexPeerBatch({ ...f.input, records: [], delivery: completedDelivery, prior: confirmed, observationCutoff: confirmed.observationCutoff }).digest, confirmed.digest);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery: { ...delivery, batchAttemptId: "wrong-attempt" } }), /another batch/u);
  const wrongRecipient = await deliveryFor(f);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery: { ...wrongRecipient, recipientPointer: "/message" } }), /recipient differs/u);
  const failedDelivery = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("failed")]) };
  const failed = recordCodexPeerBatch({ ...f.input, records, delivery: failedDelivery });
  assert.equal(failed.deliveryStatus, "failed"); assert.equal(failed.reportEligible, false);
  const early = recordCodexPeerBatch({ ...f.input, delivery: completedDelivery });
  assert.ok(early.blockedReasons.includes("delivery-before-terminal-batch"));
});

test("missing or changed current work revisions and contradictory terminal facts block reporting", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  const missingAuthority = recordCodexPeerBatch({ ...f.input, records, workRevisions: undefined });
  assert.ok(missingAuthority.blockedReasons.includes("work-revisions-unknown"));
  assert.equal(missingAuthority.reportEligible, false);
  assert.equal(normalizeCodexPeerBatch(missingAuthority).digest, missingAuthority.digest);
  for (const workRevisions of [[], [{ id: f.work.id, revision: f.work.revision + 1 }]]) {
    const changed = recordCodexPeerBatch({ ...f.input, records, workRevisions });
    assert.ok(changed.blockedReasons.includes(`work-revision-drift:${f.work.id}`));
    assert.equal(changed.reportEligible, false);
  }
  const conflicting = recordHostNativeEvents(f.preparation, [observed("completed"), observed("cancelled")]);
  const unresolved = recordCodexPeerBatch({ ...f.input, records: [conflicting] });
  assert.ok(unresolved.blockedReasons.some(reason => reason.startsWith("native-conflict:")));
  assert.equal(unresolved.allTerminal, false);
  assert.equal(unresolved.reportEligible, false);
  assert.equal(unresolved.occupancy, 1);
});

test("peer identity references must match retained native response fields, not guessed labels", async t => {
  const f = await fixture(t);
  for (const role of ["main", "coordinator"]) {
    const peer = f.input.manifest[role];
    for (const replacement of [{ ...peer, raw: { id: "wrong-observed-id" } }, { ...peer, conversationPointer: "/missing" }]) {
      assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, [role]: replacement } }));
    }
  }
});

test("CLI batch record reads current workspace and device policy, writes private receipt and replays it", async t => {
  const { writeFile, readFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const f = await fixture(t);
  const manifestPath = join(f.root, "manifest-input.json"), recordsPath = join(f.root, "records-input.json"), capacityPath = join(f.root, "capacity-input.json"), output = join(f.root, "batch-receipt.json");
  await writeFile(manifestPath, JSON.stringify(f.input.manifest));
  await writeFile(recordsPath, JSON.stringify([finish(f)]));
  await writeFile(capacityPath, JSON.stringify(f.input.capacity));
  const cli = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const invoke = args => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home }, timeout: 30_000 }));
  const before = new Date().toISOString();
  const result = invoke(["execution-codex-peer-record", "--workspace", f.workspace, "--manifest", manifestPath, "--records", recordsPath, "--capacity", capacityPath, "--output", output]);
  assert.ok(result.observationCutoff >= before && result.observationCutoff <= new Date().toISOString());
  assert.equal(result.reportEligible, true);
  assert.equal(result.reportPrefix, codexPeerReportPrefix(f.input.manifest));
  assert.throws(() => normalizeCodexPeerBatch({ ...result, reportPrefix: "tampered" }), /differs from retained/u);
  assert.equal(result.deliveryStatus, "not-attempted");
  assert.equal(result.workRevisions.find(row => row.id === f.work.id).revision, f.work.revision);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
  assert.deepEqual(invoke(["execution-codex-peer-evidence", "--from-file", output]), result);
  assert.throws(() => invoke(["execution-codex-peer-record", "--workspace", f.workspace, "--manifest", manifestPath, "--records", recordsPath, "--capacity", capacityPath, "--output", output]), /exists|EEXIST|WRITE/u);
  const futureRecords = [recordHostNativeEvents(f.preparation, [{ ...observed("completed", "future-worker"), at: "2099-01-01T00:00:00Z" }])];
  await writeFile(recordsPath, JSON.stringify(futureRecords));
  const invalidPath = join(f.root, "future-invalid.json");
  const invalidRun = spawnSync(process.execPath, [cli, "execution-codex-peer-record", "--workspace", f.workspace, "--manifest", manifestPath, "--records", recordsPath, "--capacity", capacityPath, "--prior", output, "--output", invalidPath], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home }, timeout: 30_000 });
  assert.equal(invalidRun.status, 1, "invalid evidence must not return CLI success");
  const invalid = JSON.parse(invalidRun.stdout);
  assert.equal(invalid.reasonCode, "CODEX_PEER_RECORD_INVALID");
  assert.deepEqual(invalid.records, futureRecords);
  assert.deepEqual(invalid.prior, result);
  assert.equal(invalid.validation.status, "invalid");
  assert.ok(invalid.problems.some(problem => problem.includes("after observation cutoff")));
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result, "last valid receipt remains untouched");
  assert.deepEqual(JSON.parse(await readFile(invalidPath, "utf8")), invalid);
  assert.throws(() => invoke(["execution-codex-peer-record", "--workspace", f.workspace, "--manifest", manifestPath, "--records", recordsPath, "--capacity", capacityPath, "--output", join(f.root, "override.json"), "--observation-cutoff", "2099-01-01T00:00:00Z"]), error => error.status === 1 && JSON.parse(error.stderr).reasonCode === "CLI_ARGUMENT_UNKNOWN");

});


test("observation cutoff rejects future worker events/preparations and rollback; saved replay is clock-independent", async t => {
  const f = await fixture(t);
  const observationCutoff = new Date().toISOString();
  const pending = recordCodexPeerBatch({ ...f.input, observationCutoff });
  const future = { ...observed("completed"), at: "2099-01-01T00:00:00Z" };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(f.preparation, [future])], prior: pending }), /after observation cutoff/u);
  assert.equal(pending.occupancy, 1);
  assert.equal(pending.allTerminal, false);
  const nanosFuture = { ...future, at: observationCutoff.replace("Z", "000001Z") };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(f.preparation, [nanosFuture])] }), /after observation cutoff/u);
  const boundary = { ...observed("completed"), at: observationCutoff };
  const completed = recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(f.preparation, [boundary])], prior: pending });
  assert.equal(completed.reportEligible, true);
  assert.deepEqual(normalizeCodexPeerBatch(JSON.parse(JSON.stringify(completed))), completed);
  const later = new Date(Date.parse(observationCutoff) + 1000).toISOString();
  const resumed = recordCodexPeerBatch({ ...f.input, observationCutoff: later, records: [], prior: completed });
  assert.equal(resumed.observationCutoff, later);
  assert.deepEqual(resumed.records, completed.records);
  assert.deepEqual(normalizeCodexPeerBatch(resumed), resumed);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [], prior: resumed }), /moved backwards/u);
  const { digest: ignored, ...payload } = f.preparation;
  const preparationPayload = { ...payload, attempt: { ...payload.attempt, requestedAt: future.at } };
  const preparation = { ...preparationPayload, digest: canonicalSha256(preparationPayload) };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(preparation, [])] }), /preparation is after observation cutoff/u);
  const decision = { ...f.preparation.decision, evaluatedAt: future.at };
  const futureEvaluationPayload = { ...payload, decision, context: { ...payload.context, executionDecision: decision } };
  const futureEvaluation = { ...futureEvaluationPayload, digest: canonicalSha256(futureEvaluationPayload) };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(futureEvaluation, [])] }), /evaluation is after observation cutoff/u);

});

test("delivery requires actual coordination action and exact current-manifest text prefix", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  const wrongAction = await deliveryFor(f, [], "decomposition");
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery: wrongAction }), /actual coordination attempt/u);
  for (const message of [`Before ${codexPeerReportPrefix(f.input.manifest)}result`, codexPeerReportPrefix(f.input.manifest).trimEnd() + "suffix", "Synthetic batch result"]) {
    const delivery = await deliveryFor(f, [], "coordination", message);
    assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery }), /does not bind/u);
  }
  const delivery = await deliveryFor(f);
  const confirmedDelivery = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("completed")]) };
  assert.equal(recordCodexPeerBatch({ ...f.input, records, delivery: confirmedDelivery }).deliveryStatus, "confirmed");
  const otherPreparation = await prepareHostNativeDispatch(f.state, f.request, { selection, argumentsValue: { prompt: "Different worker batch" } }, f.home);
  const manifest = { ...f.input.manifest, batchId: "other-batch", attemptId: "other-batch-attempt", members: [{ ...f.input.manifest.members[0], attemptId: otherPreparation.attempt.id }] };
  const otherRecords = [recordHostNativeEvents(otherPreparation, [observed("completed", "other-result", "other-worker")])];
  assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest, records: otherRecords, delivery: { ...confirmedDelivery, batchId: manifest.batchId, batchAttemptId: manifest.attemptId } }), /does not bind/u);
});

test("future delivery events and preparations cannot confirm or replace the retained unknown send", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  const delivery = await deliveryFor(f);
  const pending = recordCodexPeerBatch({ ...f.input, records, delivery });
  const future = { ...response("completed"), at: "2099-01-01T00:00:00Z" };
  const futureDelivery = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [future]) };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records: [], delivery: futureDelivery, prior: pending }), /after observation cutoff/u);
  assert.equal(pending.deliveryStatus, "unknown");
  assert.equal(pending.reportEligible, false);
  const resumed = recordCodexPeerBatch({ ...f.input, records: [], prior: pending });
  assert.equal(resumed.delivery.record.preparation.attempt.id, delivery.record.preparation.attempt.id);
  assert.equal(resumed.reportEligible, false);
  const { digest: ignored, ...payload } = delivery.record.preparation;
  const preparationPayload = { ...payload, attempt: { ...payload.attempt, requestedAt: future.at } };
  const preparation = { ...preparationPayload, digest: canonicalSha256(preparationPayload) };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery: { ...delivery, record: recordHostNativeEvents(preparation, []) } }), /preparation is after observation cutoff/u);
});

// Exercise the public CLI as well as API replay: blocked receipts are valid evidence,
// not CLI validation errors, and must retain their derived blocking facts on disk.
async function peerCliRoundtrip(f, input, stem) {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const args = ["execution-codex-peer-record", "--workspace", f.workspace];
  for (const key of ["manifest", "records", "capacity", "delivery", "prior"]) {
    if (input[key] == null) continue;
    const path = join(f.root, `${stem}-${key}.json`);
    await writeFile(path, JSON.stringify(input[key]));
    args.push(`--${key}`, path);
  }
  const output = join(f.root, `${stem}-output.json`);
  args.push("--output", output);
  const cli = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const invoke = flags => JSON.parse(execFileSync(process.execPath, [cli, ...flags], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, EINZBERN_HOME: f.home },
  }));
  const result = invoke(args);
  assert.deepEqual(invoke(["execution-codex-peer-evidence", "--from-file", output]), result);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
  assert.deepEqual(normalizeCodexPeerBatch(result), result);
  return result;
}

// Nanosecond offsets around a millisecond invocation, with no lossy Date.parse
// comparison in the implementation. All synthetic times remain in the observed past.
function nearSend(delivery, nanoseconds) {
  const at = delivery.record.preparation.attempt.requestedAt;
  const base = BigInt(Date.parse(at)) * 1_000_000n + BigInt(nanoseconds);
  const seconds = base / 1_000_000_000n;
  return new Date(Number(seconds * 1000n)).toISOString().slice(0, 19) + `.${String(base % 1_000_000_000n).padStart(9, "0")}Z`;
}

test("premature reports remain blocked through completion, prior recovery and direct CLI replay", async t => {
  const f = await fixture(t);
  const { setTimeout: delay } = await import("node:timers/promises");
  await delay(2);
  const delivery = await deliveryFor(f);
  const runningEvent = { ...observed("running", "running-before-send"), at: nearSend(delivery, -1) };
  delete runningEvent.terminal;
  const running = recordHostNativeEvents(f.preparation, [runningEvent]);
  await delay(2);
  const completedEvent = { ...observed("completed", "completed-after-send"), at: nearSend(delivery, 1) };
  const sent = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("completed", "send-finished")]) };
  const before = recordCodexPeerBatch({ ...f.input, records: [running], delivery: sent });
  assert.ok(before.blockedReasons.includes("delivery-before-terminal-batch"));
  const completed = recordHostNativeEvents(f.preparation, [completedEvent], running);
  for (const [label, prior] of [["resumed", before], ["direct", undefined]]) {
    const input = { ...f.input, records: [completed], delivery: sent, prior };
    const after = recordCodexPeerBatch(input);
    assert.equal(after.allTerminal, true);
    assert.equal(after.occupancy, 0);
    assert.equal(after.deliveryStatus, "confirmed", "transport success is not valid final-report association");
    assert.ok(after.blockedReasons.includes("delivery-before-terminal-batch"));
    assert.equal(after.reportEligible, false);
    assert.deepEqual(normalizeCodexPeerBatch(after), after);
    const cli = await peerCliRoundtrip(f, input, `early-${label}`);
    assert.deepEqual(cli.blockedReasons, after.blockedReasons);
    const recovered = recordCodexPeerBatch({ ...f.input, records: [], prior: cli });
    assert.deepEqual(recovered.blockedReasons, after.blockedReasons);
  }
});

test("report boundary is send invocation, uses strict nanosecond order, and requires identity then", async t => {
  const f = await fixture(t);
  const { setTimeout: delay } = await import("node:timers/promises");
  await delay(2);
  const delivery = await deliveryFor(f);
  await delay(2);
  const sent = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("completed")]) };
  for (const [label, offset, blocked] of [["before", -1, false], ["equal", 0, true], ["after", 1, true]]) {
    const records = [recordHostNativeEvents(f.preparation, [{ ...observed("completed"), at: nearSend(delivery, offset) }])];
    const input = { ...f.input, records, delivery: sent };
    const result = recordCodexPeerBatch(input);
    assert.equal(result.blockedReasons.includes("delivery-before-terminal-batch"), blocked, label);
    assert.equal(result.allTerminal, true);
    assert.equal(result.deliveryStatus, "confirmed");
    const cli = await peerCliRoundtrip(f, input, `boundary-${label}`);
    assert.deepEqual(cli.blockedReasons, result.blockedReasons);
  }
  const terminalWithoutId = { ...response("completed", "anonymous-terminal"), at: nearSend(delivery, -1) };
  const lateIdentity = { ...observed("completed", "late-identity"), at: nearSend(delivery, 1) };
  const unknownAtSend = recordCodexPeerBatch({ ...f.input, records: [recordHostNativeEvents(f.preparation, [terminalWithoutId, lateIdentity])], delivery: sent });
  assert.equal(unknownAtSend.allTerminal, true);
  assert.ok(unknownAtSend.blockedReasons.includes("delivery-before-terminal-batch"));
  const priorUnknown = recordCodexPeerBatch({ ...f.input, records: [recordHostNativeEvents(f.preparation, [terminalWithoutId])], delivery: sent });
  const resumed = recordCodexPeerBatch({ ...f.input, records: unknownAtSend.records, prior: priorUnknown });
  assert.deepEqual(resumed.blockedReasons, unknownAtSend.blockedReasons);
});

test("unknown, drifted or ambiguous native identity never releases a fixed member", async t => {
  const f = await fixture(t);
  const manifest = { ...f.input.manifest, members: [{ ...f.input.manifest.members[0], conversationId: "fixture-worker" }] };
  const cases = [
    ["unknown", [response("completed")]],
    ["drift", [observed("completed", "wrong-worker", "unrelated-conversation")]],
    ["ambiguous", [observed("completed", "right-worker"), observed("completed", "wrong-worker", "unrelated-conversation")]],
    ["main-reused", [observed("completed", "main-worker", manifest.main.conversationId)]],
    ["coordinator-reused", [observed("completed", "coordinator-worker", manifest.coordinator.conversationId)]],
  ];
  for (const [label, events] of cases) {
    const input = { ...f.input, manifest, records: [recordHostNativeEvents(f.preparation, events)] };
    const result = recordCodexPeerBatch(input);
    assert.equal(result.records[0].executionFinality, "confirmed", "native lifecycle evidence remains unchanged");
    assert.equal(result.occupancy, 1, label);
    assert.equal(result.allTerminal, false, label);
    assert.equal(result.reportEligible, false, label);
    const cli = await peerCliRoundtrip(f, input, `identity-${label}`);
    assert.equal(cli.occupancy, 1, label);
    assert.equal(cli.allTerminal, false, label);
    assert.deepEqual(cli.blockedReasons, result.blockedReasons);
  }
});

test("colliding identities retain both claimants regardless of record order and reserve missing fixed members", async t => {
  const f = await fixture(t);
  const second = await prepareHostNativeDispatch(f.state, f.request, { selection, argumentsValue: { prompt: "Second synthetic worker" } }, f.home);
  const manifest = { ...f.input.manifest, members: [...f.input.manifest.members, { ...f.input.manifest.members[0], attemptId: second.attempt.id }] };
  const firstRecord = recordHostNativeEvents(f.preparation, [observed("completed", "first")]);
  const secondRecord = recordHostNativeEvents(second, [observed("completed", "second")]);
  for (const [label, records] of [["forward", [firstRecord, secondRecord]], ["reverse", [secondRecord, firstRecord]]]) {
    const input = { ...f.input, manifest, records };
    const result = recordCodexPeerBatch(input);
    assert.equal(result.occupancy, 2, label);
    assert.equal(result.allTerminal, false, label);
    for (const member of manifest.members) assert.ok(result.blockedReasons.includes(`native-identity-reused:${member.attemptId}`));
    const cli = await peerCliRoundtrip(f, input, `collision-${label}`);
    assert.equal(cli.occupancy, 2);
    assert.equal(cli.allTerminal, false);
  }
  const reserved = { ...manifest, members: [manifest.members[0], { ...manifest.members[1], conversationId: "fixture-worker" }] };
  const input = { ...f.input, manifest: reserved, records: [firstRecord] };
  const missing = recordCodexPeerBatch(input);
  assert.equal(missing.occupancy, 2);
  assert.equal(missing.allTerminal, false);
  assert.ok(missing.blockedReasons.includes(`native-identity-reused:${f.preparation.attempt.id}`));
  const cli = await peerCliRoundtrip(f, input, "collision-missing-fixed");
  assert.equal(cli.occupancy, 2);
  assert.equal(cli.allTerminal, false);
  const distinct = recordCodexPeerBatch({ ...f.input, manifest, records: [firstRecord, recordHostNativeEvents(second, [observed("failed", "different-worker", "second-worker")])] });
  assert.equal(distinct.occupancy, 0);
  assert.equal(distinct.allTerminal, true);
  assert.equal(distinct.reportEligible, true);
});
