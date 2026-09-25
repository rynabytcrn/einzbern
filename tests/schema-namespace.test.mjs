// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-466 R2, AC3: every event the engine writes from now on carries the
// einzbern namespace, the legacy tcrn namespace stays readable, and a chain that runs from
// legacy events into new ones still validates link by link.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeWorkspace, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSIONS,
  LEGACY_EVENT_SCHEMA_VERSION,
  createEvent,
  isEventSchemaVersion,
  validateEventChain,
} from "../dist/build/packages/protocol/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("466-R2: the two event namespaces, and only they, are events", () => {
  assert.equal(EVENT_SCHEMA_VERSION, "einzbern.event.v1");
  assert.equal(LEGACY_EVENT_SCHEMA_VERSION, "tcrn.event.v1");
  assert.deepEqual([...EVENT_SCHEMA_VERSIONS], ["tcrn.event.v1", "einzbern.event.v1"]);
  assert.equal(isEventSchemaVersion("tcrn.event.v1"), true);
  assert.equal(isEventSchemaVersion("einzbern.event.v1"), true);
  assert.equal(isEventSchemaVersion("einzbern.event.v2"), false);
});

test("466-R2 (protocol): legacy events followed by new ones validate, each keeping its own namespace", () => {
  const events = [];
  let priorHash = null;
  for (let sequence = 1; sequence <= 6; sequence += 1) {
    const schemaVersion = sequence <= 3 ? LEGACY_EVENT_SCHEMA_VERSION : EVENT_SCHEMA_VERSION;
    const event = createEvent({
      id: `event:mixed-${sequence}`,
      streamId: "stream:mixed",
      sequence,
      occurredAt: `2026-01-01T00:00:0${sequence}Z`,
      priorHash,
      payload: { sequence },
    }, schemaVersion);
    events.push(event);
    priorHash = event.eventHash;
  }
  const validated = validateEventChain(events);
  assert.deepEqual(validated.map((event) => event.schemaVersion), [
    "tcrn.event.v1", "tcrn.event.v1", "tcrn.event.v1", "einzbern.event.v1", "einzbern.event.v1", "einzbern.event.v1",
  ]);
  assert.equal(validated[3].priorHash, validated[2].eventHash, "the first new event links onto the legacy head");
});

test("466-AC3 (engine): a new workspace writes every event as einzbern.event.v1", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-namespace-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"].map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path);
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "NAMESPACE-WORKSPACE", createdAt: "2026-01-01T00:00:00Z" });
  const run = async (args) => {
    let output = "";
    await runCli(args, { write: (value) => { output += value; } });
    return JSON.parse(output);
  };
  const project = await run(["project-create", "--workspace", workspace, "--at", "2026-01-01T00:00:01Z", "--external-key", "NAMESPACE-PROJECT", "--name", "Namespace"]);
  await run(["work-create", "--workspace", workspace, "--at", "2026-01-01T00:00:02Z", "--project-id", project.record.id, "--external-key", "NAMESPACE-INITIATIVE", "--kind", "Initiative", "--title", "Namespace initiative"]);
  const state = await materializeWorkspace(workspace);
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events.map((event) => event.schemaVersion), ["einzbern.event.v1", "einzbern.event.v1"]);
  assert.doesNotThrow(() => validateEventChain(state.events));
});

test("466-R2: the legacy fixture still holds tcrn.event.v1 only", async () => {
  const expected = JSON.parse(await readFile(join(repositoryRoot, "tests/fixtures/legacy-workspace/expected.json"), "utf8"));
  assert.deepEqual(expected.schemaVersions, ["tcrn.event.v1"]);
});
