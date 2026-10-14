// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  ACTOR_ATTESTATION_ENABLE_OPERATION,
  ACTOR_ATTESTATION_REGISTRATION_ID,
  ACTOR_ATTESTATION_SCHEMA_VERSION,
  ACTOR_PREFIXES,
  EVENT_PAYLOAD_OPERATION_EXTRAS,
  assertActorId,
  buildActorAttestationEnableRecord,
  buildActorAttestationRegistration,
  buildEventPayload,
  createProject,
  createWork,
  exportWorkspace,
  initializeLibrary,
  materializeWorkspace,
  validateActorAttestationEnableRecord,
} from "../dist/build/packages/core/src/index.js";
// TCRN-CROSS-SUB-465: the barrel exports only what the CLI calls; the rest is read from the module.
import {
  EVENT_PAYLOAD_OPTIONAL_EXTRAS,
  WRITE_SURFACES,
  writeAuthorizationExtras,
} from "../dist/build/packages/core/src/actor-attestation.js";
import { setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { appendHistoricalAttestationEnable } from "./helpers/workspace-fixture.mjs";
import { validateExtensionRegistration } from "../dist/build/packages/protocol/src/index.js";
import { forgeOwnStream } from "./helpers/library-forge.mjs";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function workspaceFixture(segmentEventLimit = 64) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-actor-")));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(0) });
  return {
    workspace: join(base, "workspace"),
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function reasonAsync(code, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === code, code);
}

// WSE-2: re-hash the last event of the library's stream with a new payload, keeping its
// identity, clock and time so the stream stays internally valid — a hand-crafted log the live
// path would never write, proving the replay reducer enforces attestation independently of the
// writer. In a library such an event does not apply: it is a rejected event with the rule's
// reason code (TCRN-CROSS-STORY-468 R5).
async function rehashLastEvent(workspace, buildPayload) {
  await forgeOwnStream(workspace, (events) => events.map((event, index) => (index === events.length - 1 ? { ...event, payload: buildPayload(event.payload) } : event)));
}

async function rejectedAs(workspace, reasonCode) {
  const state = await materializeWorkspace(workspace);
  const rejected = state.library.rejectedEvents;
  assert.equal(rejected.length, 1, "the forged event is rejected, not applied");
  assert.equal(rejected[0].reasonCode, reasonCode);
  assert.equal(rejected[0].sequence, state.version, "it is the last event of the stream");
  return state;
}

function reason(code, operation) {
  assert.throws(operation, (error) => error?.reasonCode === code, code);
}

test("assertActorId accepts the allowlisted prefixes and fails closed otherwise", () => {
  for (const prefix of ACTOR_PREFIXES) {
    assert.doesNotThrow(() => assertActorId(`${prefix}:alpha-01`));
  }
  for (const bad of ["role:x", "owner:", "Owner:x", "OWNER:X", "owneralpha", "x", ":x", 42, null, undefined]) {
    reason("ACTOR_ID_INVALID", () => assertActorId(bad));
  }
});

test("buildEventPayload carries a validated actor only when supplied", () => {
  assert.deepEqual(buildEventPayload("work.created", { id: "x" }), { operation: "work.created", record: { id: "x" } });
  assert.deepEqual(buildEventPayload("work.created", { id: "x" }, "owner:alpha"), { operation: "work.created", record: { id: "x" }, actor: "owner:alpha" });
  reason("ACTOR_ID_INVALID", () => buildEventPayload("work.created", { id: "x" }, "role:alpha"));
});

// WSD-1 (SDC-2): the registered per-operation extras table — never ad-hoc
// payload shapes. conference.closed must carry exactly the minutes extra; no
// other operation may carry one; reserved keys stay unforgeable.
test("buildEventPayload admits exactly the registered per-operation extras", () => {
  assert.deepEqual(EVENT_PAYLOAD_OPERATION_EXTRAS, { "conference.closed": ["minutes"] });
  assert.deepEqual(
    buildEventPayload("conference.closed", { id: "x" }, undefined, { minutes: { id: "m" } }),
    { operation: "conference.closed", record: { id: "x" }, minutes: { id: "m" } },
  );
  assert.deepEqual(
    buildEventPayload("conference.closed", { id: "x" }, "owner:alpha", { minutes: { id: "m" } }),
    { operation: "conference.closed", record: { id: "x" }, minutes: { id: "m" }, actor: "owner:alpha" },
  );
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("conference.closed", { id: "x" }));
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("conference.closed", { id: "x" }, undefined, {}));
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("conference.closed", { id: "x" }, undefined, { minutes: { id: "m" }, extra: true }));
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("work.created", { id: "x" }, undefined, { minutes: { id: "m" } }));
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("conference.created", { id: "x" }, undefined, { actor: "owner:alpha" }));
});

test("the enable record round-trips and validates fail-closed", () => {
  const record = buildActorAttestationEnableRecord();
  assert.deepEqual(record, { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1 });
  assert.doesNotThrow(() => validateActorAttestationEnableRecord(record));
  for (const bad of [{}, { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION }, { schemaVersion: "x", version: 1 }, { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 2 }, { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1, extra: true }, null, []]) {
    reason("ACTOR_ATTESTATION_INVALID", () => validateActorAttestationEnableRecord(bad));
  }
  assert.equal(ACTOR_ATTESTATION_ENABLE_OPERATION, "attestation.actor.enabled");
});

test("the extension registration is event-scoped, off by default, and schema-digest bound", async () => {
  const schemaBytes = await readFile(new URL("../schemas/actor-attestation-v1.schema.json", import.meta.url));
  const schemaDigest = createHash("sha256").update(schemaBytes).digest("hex");
  const registration = buildActorAttestationRegistration(schemaDigest);
  assert.equal(registration.id, ACTOR_ATTESTATION_REGISTRATION_ID);
  assert.deepEqual(registration.appliesTo, ["event"]);
  assert.equal(registration.requiredByDefault, false);
  assert.doesNotThrow(() => validateExtensionRegistration(registration));

  const registrationSchema = JSON.parse(await readFile(new URL("../schemas/extension-registration-v1.schema.json", import.meta.url), "utf8"));
  const protocolSchema = JSON.parse(await readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array" });
  ajv.addSchema(protocolSchema);
  assert.equal(ajv.compile(registrationSchema)(registration), true);
});

test("the actor-attestation schema validates the enable record and actor strings", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/actor-attestation-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array" });
  const validateEnable = ajv.compile(schema);
  assert.equal(validateEnable({ schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1 }), true);
  assert.equal(validateEnable({ schemaVersion: "x", version: 1 }), false);
  assert.equal(validateEnable({ schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1, extra: true }), false);

  const validateActor = ajv.compile(schema.$defs.actorId);
  for (const prefix of ACTOR_PREFIXES) {
    assert.equal(validateActor(`${prefix}:alpha-01`), true);
  }
  for (const bad of ["role:x", "OWNER:X", "owner:"]) {
    assert.equal(validateActor(bad), false);
  }
});

// ---------------------------------------------------------------------------
// WSE-2: engine enforcement of the enable-boundary. These cases drive the real
// file engine (enable event plus mutations) and hand-crafted replay logs the
// live path would never write, proving the mandatory-actor rule is enforced
// identically on write and on replay, and that default behaviour is unchanged.
// ---------------------------------------------------------------------------

async function attestedChain(fixture) {
  const created = await createProject(fixture.workspace, {
    occurredAt: instant(1), externalKey: "PROJECT-CHAIN", name: "Chain",
  });
  await appendHistoricalAttestationEnable(fixture.workspace, {
    occurredAt: instant(2), actorId: "owner:release-gate",
  });
  await createWork(fixture.workspace, {
    occurredAt: instant(3), projectId: created.projects[0].id, externalKey: "INIT-CHAIN", kind: "Initiative", parentId: null, actorId: "agent:builder-7",
  });
}

test("WSE-2 default: no enable event keeps mutations actor-optional and export actor-free", async () => {
  const fixture = await workspaceFixture();
  try {
    let state;
    // An actor supplied before any enable event is a no-op: accepted, never
    // written, so the derived state and export bytes stay actor-free.
    state = await createProject(fixture.workspace, {
      occurredAt: instant(1), externalKey: "PROJECT-DEFAULT", name: "Default", actorId: "owner:release-gate",
    });
    assert.equal(state.attestationEnabledAtSequence, null);
    const exported = await exportWorkspace(fixture.workspace);
    assert.equal(exported.includes("\"actor\""), false);
    const replayed = await materializeWorkspace(fixture.workspace);
    assert.equal(replayed.attestationEnabledAtSequence, null);
    assert.equal(replayed.version, 1);
  } finally {
    await fixture.close();
  }
});

test("WSE-2 live: enabling attestation makes a valid actor mandatory on every later write", async () => {
  const fixture = await workspaceFixture();
  try {
    let created = await createProject(fixture.workspace, {
      occurredAt: instant(1), externalKey: "PROJECT-A", name: "Alpha",
    });
    assert.equal(created.attestationEnabledAtSequence, null);

    const enabled = await appendHistoricalAttestationEnable(fixture.workspace, {
      occurredAt: instant(3), actorId: "owner:release-gate",
    });
    assert.equal(enabled.attestationEnabledAtSequence, 2);

    // A missing actor fails closed and writes nothing (version and head unchanged).
    const before = await materializeWorkspace(fixture.workspace);
    await reasonAsync("WORKSPACE_ACTOR_REQUIRED", () => createWork(fixture.workspace, {
      occurredAt: instant(4), projectId: created.projects[0].id, externalKey: "INIT-A", kind: "Initiative", parentId: null,
    }));
    const afterFail = await materializeWorkspace(fixture.workspace);
    assert.equal(afterFail.version, before.version);
    assert.equal(afterFail.headEventHash, before.headEventHash);

    // An unlisted prefix fails closed as an invalid actor.
    await reasonAsync("WORKSPACE_ACTOR_INVALID", () => createWork(fixture.workspace, {
      occurredAt: instant(4), projectId: created.projects[0].id, externalKey: "INIT-A", kind: "Initiative", parentId: null, actorId: "role:nope",
    }));

    // A valid actor succeeds.
    const worked = await createWork(fixture.workspace, {
      occurredAt: instant(4), projectId: created.projects[0].id, externalKey: "INIT-A", kind: "Initiative", parentId: null, actorId: "agent:builder-7",
    });
    assert.equal(worked.version, 3);
    assert.equal(worked.attestationEnabledAtSequence, 2);

    const exported = JSON.parse(await exportWorkspace(fixture.workspace));
    assert.equal("actor" in exported.events[0].payload, false);
    assert.equal(exported.events[1].payload.operation, ACTOR_ATTESTATION_ENABLE_OPERATION);
    assert.equal(exported.events[1].payload.actor, "owner:release-gate");
    assert.equal(exported.events[2].payload.actor, "agent:builder-7");
  } finally {
    await fixture.close();
  }
});

test("WSE-2 replay: a hand-crafted post-enable event with no valid actor does not apply", async () => {
  const missing = await workspaceFixture();
  try {
    await attestedChain(missing);
    await rehashLastEvent(missing.workspace, (payload) => {
      const copy = { ...payload };
      delete copy.actor;
      return copy;
    });
    await rejectedAs(missing.workspace, "WORKSPACE_ACTOR_REQUIRED");
  } finally {
    await missing.close();
  }

  const invalid = await workspaceFixture();
  try {
    await attestedChain(invalid);
    await rehashLastEvent(invalid.workspace, (payload) => ({ ...payload, actor: "role:forged" }));
    await rejectedAs(invalid.workspace, "WORKSPACE_ACTOR_INVALID");
  } finally {
    await invalid.close();
  }
});

test("WSE-2 replay: a duplicate enable event and a pre-enable actor are both refused by the reader", async () => {
  const dup = await workspaceFixture();
  try {
    await attestedChain(dup);
    await rehashLastEvent(dup.workspace, () => ({
      operation: ACTOR_ATTESTATION_ENABLE_OPERATION,
      record: buildActorAttestationEnableRecord(),
      actor: "owner:release-gate",
    }));
    await rejectedAs(dup.workspace, "WORKSPACE_EVENT_CORRUPT");
  } finally {
    await dup.close();
  }

  const early = await workspaceFixture();
  try {
    await createProject(early.workspace, {
      occurredAt: instant(1), externalKey: "PROJECT-EARLY", name: "Early",
    });
    // The live path never writes an actor before enablement; a hand-crafted
    // pre-enable event carrying one violates the exact {operation, record} shape
    // and the reducer refuses it as a corrupt event.
    await rehashLastEvent(early.workspace, (payload) => ({ ...payload, actor: "owner:release-gate" }));
    const state = await rejectedAs(early.workspace, "WORKSPACE_EVENT_CORRUPT");
    assert.deepEqual(state.projects, [], "the forged create did not apply");
  } finally {
    await early.close();
  }
});

// TCRN-CROSS-STORY-526 (MIN-256; TCRN-CROSS-SUB-452): beside the registered extras, the four
// configuration operations may carry the optional authorization extras -- surface (cli or atelier)
// and decidedIn with decidedInLibraryId -- and no other operation may. Without them a payload is
// exactly what it was.
test("SUB-452: buildEventPayload admits the optional authorization extras for the configuration writes only", () => {
  // TCRN-CROSS-SUB-510: gate.updated as well, which work-gate-release appends.
  assert.deepEqual(Object.keys(EVENT_PAYLOAD_OPTIONAL_EXTRAS).sort(), ["config.record.removed", "config.record.set", "gate.updated", "settings.removed", "settings.updated"]);
  for (const extras of Object.values(EVENT_PAYLOAD_OPTIONAL_EXTRAS)) assert.deepEqual([...extras], ["decidedIn", "decidedInLibraryId", "surface"]);
  assert.deepEqual([...WRITE_SURFACES], ["atelier", "cli"]);
  const record = { collection: "gate", key: "unit" };
  const decided = { decidedIn: "minutes:abc123#D8", decidedInLibraryId: `library:${"a".repeat(24)}` };
  assert.deepEqual(buildEventPayload("config.record.set", record), { operation: "config.record.set", record });
  assert.deepEqual(buildEventPayload("config.record.set", record, undefined, {}), { operation: "config.record.set", record });
  assert.deepEqual(buildEventPayload("config.record.set", record, undefined, writeAuthorizationExtras(undefined)), { operation: "config.record.set", record });
  assert.deepEqual(buildEventPayload("settings.updated", record, undefined, { surface: "atelier" }), { operation: "settings.updated", record, surface: "atelier" });
  assert.deepEqual(buildEventPayload("config.record.removed", record, "owner:alpha", writeAuthorizationExtras({ surface: "cli", ...decided })),
    { operation: "config.record.removed", record, surface: "cli", ...decided, actor: "owner:alpha" });
  for (const extras of [
    { surface: "web" },
    { surface: "" },
    { decidedIn: decided.decidedIn },
    { decidedInLibraryId: decided.decidedInLibraryId },
    { decidedIn: "TCRN-CROSS-MIN-256#D8", decidedInLibraryId: decided.decidedInLibraryId },
    { decidedIn: decided.decidedIn, decidedInLibraryId: "library:short" },
    { approvedBy: "owner:governance" },
  ]) {
    reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("settings.removed", record, undefined, extras));
  }
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("work.created", { id: "x" }, undefined, { surface: "cli" }));
  reason("EVENT_PAYLOAD_EXTRA_INVALID", () => buildEventPayload("conference.closed", { id: "x" }, undefined, { minutes: { id: "m" }, surface: "cli" }));
});

test("SUB-452: on an attested chain the authorization extras travel beside the actor and replay; a forged surface does not apply", async () => {
  const fixture = await workspaceFixture();
  try {
    await appendHistoricalAttestationEnable(fixture.workspace, { occurredAt: instant(1), actorId: "owner:release-gate" });
    const gate = { command: ["node", "--version"], root: ".", covers: ["**"], required: true, enabled: true, releaseOnly: false };
    await setConfigRecord(fixture.workspace, { collection: "gate", key: "unit", value: gate, occurredAt: instant(2), actorId: "agent:test-portal", authorization: { surface: "atelier" } });
    const state = await materializeWorkspace(fixture.workspace);
    assert.deepEqual(state.events.at(-1).payload, { operation: "config.record.set", record: { collection: "gate", key: "unit", value: gate }, surface: "atelier", actor: "agent:test-portal" });
    assert.deepEqual(state.library.rejectedEvents, []);
    await rehashLastEvent(fixture.workspace, (payload) => ({ ...payload, surface: "browser" }));
    const forged = await rejectedAs(fixture.workspace, "WORKSPACE_EVENT_CORRUPT");
    assert.deepEqual(forged.configRecords, [], "the forged write did not apply");
  } finally {
    await fixture.close();
  }
});
