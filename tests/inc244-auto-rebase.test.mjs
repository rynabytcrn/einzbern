// SPDX-License-Identifier: Apache-2.0
// INC-244: a workspace write must not leave the knowledge store frozen at the previous high water.
//
// TCRN-CROSS-SUB-414 (MIN-235 D7) keeps that purpose and drops the write that served it. The CLI
// used to rebind the store after every chain write -- a rebase that took the crest's claim and
// rewrote its store.json, which two devices writing one library contended for. A library crest's
// marker is now projected by every read at the chain head that read replays, so the knowledge
// surface answers at the new head with nothing rebound, and a chain write leaves the crest untouched.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  createProject,
  createWork,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  readKnowledgeStoreMarker,
  validateKnowledgeStore,
} from "../dist/build/packages/core/src/index.js";

const instant = second => `2026-08-21T12:00:${String(second).padStart(2, "0")}Z`;

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc244-")));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(0) });
  let state = await createProject(workspace, { occurredAt: instant(1), externalKey: "FIXTURE-INC-244-PROJECT", name: "INC-244" });
  state = await createWork(workspace, { occurredAt: instant(2), projectId: state.projects[0].id, externalKey: "FIXTURE-INC-244-WORK", kind: "Initiative", parentId: null, status: "active" });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { base, workspace, version: state.version };
}

test("INC-244, SUB-414: after a CLI workspace event the knowledge surface answers at the new head, and the crest is untouched", async () => {
  const state = await fixture();
  try {
    const crest = join(state.workspace, "crest");
    const manifest = await readFile(join(crest, "store.json"));
    let output = "";
    await runCli([
      "project-create",
      "--workspace", state.workspace,
      "--at", instant(3),
      "--external-key", "FIXTURE-INC-244-PROJECT-TWO",
      "--name", "INC-244 two",
    ], { write: value => { output += value; } });
    const receipt = JSON.parse(output);
    assert.equal(receipt.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    assert.deepEqual(await readFile(join(crest, "store.json")), manifest, "the chain write did not rewrite store.json");
    assert.deepEqual(await readdir(crest), ["store.json"], "nor take the crest's claim, nor write anything else in it");
    const validation = await validateKnowledgeStore(state.workspace);
    assert.equal(validation.reasonCode, "KNOWLEDGE_STORE_VALID");
    assert.equal(validation.eventHighWaterDigest, receipt.headEventHash, "the read answers at the head the chain write made");
    assert.equal(validation.version, 0, "and its version counts card events, of which there are none: nothing was rebound");
    assert.equal((await readKnowledgeStoreMarker(state.workspace)).eventHighWaterDigest, receipt.headEventHash);
    assert.equal((await listKnowledgeMetadata(state.workspace, { at: instant(4) })).reasonCode, "KNOWLEDGE_LIST_READY", "a default read needs no rebase");
  } finally {
    await rm(state.base, { recursive: true, force: true });
  }
});
