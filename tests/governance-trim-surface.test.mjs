// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-467 (TCRN-CROSS-MIN-227 D3): the governance layer is trimmed. This file
// states AC1 and AC5 as machine checks and holds the retained list (R4) to tests that
// exercise each item, running the one retained gate no other test ran directly.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { P1_TASKS } from "../scripts/p1-sequence.mjs";
import { repositoryRoot } from "../scripts/lib/files.mjs";

async function catalogNames() {
  let output = "";
  await runCli(["commands"], { write: (value) => { output += value; } });
  return JSON.parse(output).commands.map((command) => command.name);
}

test("467-AC1: the command catalog lists no retired verb family", async () => {
  const names = await catalogNames();
  for (const prefix of ["attestation-", "gate-", "dispatch-", "profile-", "telemetry-", "lease-"]) {
    assert.deepEqual(names.filter((name) => name.startsWith(prefix)), [], `${prefix}* is retired`);
  }
  // conference-* stays until STORY-475 replaces the minutes discipline (problem list #2).
  assert.ok(names.some((name) => name.startsWith("conference-")));
});

test("467-AC5: the guard registry, the proof budget and the verification map do not exist", () => {
  for (const path of ["scripts/policy/guard-registry.json", "scripts/policy/proof-budget.json", "verification-map.yaml"]) {
    assert.equal(existsSync(resolve(repositoryRoot, path)), false, path);
  }
});

test("467-R4: each retained item names a test that exercises it", () => {
  // Each entry is a test file and a marker that ties it to the item; a moved or emptied
  // test turns this red instead of leaving the item silently unproved.
  const retained = [
    ["priorHash chain", "tests/legacy-read-only.test.mjs", "priorHash"],
    ["priorHash chain", "tests/protocol-v1.test.mjs", "event integrity vectors reject replay and corruption"],
    ["chain-validate", "tests/legacy-read-only.test.mjs", "chain-validate"],
    ["retrieval-eval", "tests/governance-trim-surface.test.mjs", "scripts/retrieval-eval.mjs"],
    ["format, lint, typecheck, build, test, portal", "tests/p1-roster.test.mjs", "a rostered script dispatches the verb it is listed beside"],
    ["links", "tests/inc238-markdown-link-gate.test.mjs", "MARKDOWN_LINK_BROKEN"],
    ["portal", "portal/tests/portal.test.mjs", "test("],
  ];
  for (const [item, file, marker] of retained) {
    const path = resolve(repositoryRoot, file);
    assert.equal(existsSync(path), true, `${item}: ${file}`);
    assert.ok(readFileSync(path, "utf8").includes(marker), `${item}: ${file} carries ${marker}`);
  }
  for (const task of ["format-check", "lint", "typecheck", "build", "test", "portal", "links", "retrieval-eval"]) {
    assert.ok(P1_TASKS.includes(task), `${task} stays on the P1 roster`);
  }
});

test("467-R4: the retrieval evaluation gate passes on its frozen corpus", () => {
  const run = spawnSync(process.execPath, [resolve(repositoryRoot, "scripts/retrieval-eval.mjs")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(result.reasonCode, "RETRIEVAL_EVAL_VERIFIED", run.stdout);
  assert.equal(result.ok, true);
});
