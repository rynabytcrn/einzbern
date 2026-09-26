// SPDX-License-Identifier: Apache-2.0
// S7 — engine behavior-surface golden samples (TCRN-CROSS-STORY-141).
//
// The engine's behavior surface is deterministic for a fixed input: same bytes in,
// same canonical JSON out, for as long as the engine's semantics hold. The former
// persona-render command was retired in STORY-370; this file retains the wrapper
// smoke test that still exercises the shipped CLI.
//
// Goldens live beside this test under fixtures/s7-golden/ as string modules (INC-034:
// as .json they were rewritten by this repository own formatter, which is the byte
// under test). Regenerate a golden ONLY when the behavior change is intended: re-run
// the generator (see docs/reports/init-018/S7/commands.md) and review the diff.
//
// TCRN-CROSS-STORY-358 family 1 retired the adapter-generate golden and its shared
// inputs with the (since retired) Codex adapter module.
//
// Rework: WSB-5 below is not a golden-snapshot case -- it is a plain CLI smoke test
// relocated here from tests/p7-compatibility-modes.test.mjs, which retires whole-file
// in this same change. It had no adapter or compatibility-mode dependency, so losing it
// with that file would have dropped the only coverage of scripts/einzbern.mjs's
// "status" read verb over the real shipped binary. The coverage waiver that pointed here
// from its old path retired with coverage conservation (TCRN-CROSS-STORY-467 R2).
import "./helpers/device-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeLibrary } from "../dist/build/packages/core/src/index.js";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function initializedWrapperWorkspace() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "workflow-s7-wrapper-")));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: "2026-07-12T00:00:00Z" });
  return { base, workspace: join(base, "workspace"), close: () => rm(base, { recursive: true, force: true }) };
}

test("WSB-5: the shipped binary completes the status read verb with exit 0 and WORKSPACE_COMMAND_COMPLETED", async () => {
  const fixture = await initializedWrapperWorkspace();
  try {
    const result = spawnSync(process.execPath,
      [join(REPO_ROOT, "scripts/einzbern.mjs"), "status", "--workspace", fixture.workspace],
      { encoding: "utf8", cwd: REPO_ROOT });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "", "a successful read emits nothing on stderr");
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    assert.equal(envelope.version, 0);
  } finally {
    await fixture.close();
  }
});
