// SPDX-License-Identifier: Apache-2.0
// INC-244: workspace writes automatically rebind an existing knowledge store.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  createProject,
  createWork,
  initializeKnowledgeStore,
  initializeLibrary,
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

test("INC-244: a CLI workspace event automatically rebinds the knowledge high-water", async () => {
  const state = await fixture();
  try {
    let output = "";
    await runCli([
      "project-create",
      "--workspace", state.workspace,
      "--at", instant(3),
      "--external-key", "FIXTURE-INC-244-PROJECT-TWO",
      "--name", "INC-244 two",
    ], { write: value => { output += value; } });
    const receipt = JSON.parse(output);
    const validation = await validateKnowledgeStore(state.workspace);
    assert.equal(receipt.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    assert.equal(validation.reasonCode, "KNOWLEDGE_STORE_VALID");
    assert.equal(validation.eventHighWaterDigest, receipt.headEventHash);
    assert.equal(validation.version, 1);
  } finally {
    await rm(state.base, { recursive: true, force: true });
  }
});
