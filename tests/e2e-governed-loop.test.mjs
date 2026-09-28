// SPDX-License-Identifier: Apache-2.0

// WSG-6: the flagship end-to-end governed-loop proof.
//
// One hermetic replay of the whole product loop --
// initiative -> epic -> story -> minutes -> decided-in -> done -> trace
// -- on a REAL (non-fixture) library created under mkdtemp, driven entirely
// through the governed CLI surface (runCli + a CliIo write-capture stub, never a
// direct core-library call), with every timestamp supplied explicitly (no
// Date.now, no randomness) and no network access (the offline process guard is
// installed by the verify harness).
//
// The command sequence is authored once in ./e2e-governed-loop-commands.mjs and
// reproduced verbatim by docs/tutorial/governed-loop.md; this proof replays that
// single source of truth and additionally re-derives the doc/proof equality, so
// the tutorial cannot rot (acceptance criterion 2). The trace step asserts an
// unbroken digest chain binding the work record and the minutes that decided it,
// from both ends (acceptance criterion 3). TCRN-CROSS-STORY-475 replaced the
// conference, its close and the distillation into a promoted knowledge candidate
// with one minutes-record and the decided-in relation.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import {
  MINUTES_TITLE,
  RECORDED_DECISION,
  WORKSPACE_PATH,
  canonicalizeCommand,
  expectedTutorialCommands,
  extractTutorialCommands,
  governedLoopStoryline,
  initCommand,
  STORY_ACCEPTANCE,
  STORY_GOAL,
} from "./e2e-governed-loop-commands.mjs";

const MINUTES_PREFIX = "minutes:";

// Drive one governed command through runCli with a write-capture stub and return
// the parsed canonical output. No clock is injected, so the CLI never reaches for a
// wall clock (constraint 6).
async function invoke(tokens) {
  let output = "";
  await runCli(tokens, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

// Substitute the workspace-relative path placeholders and the receipt-derived
// identifier placeholders with their real values before replay.
function render(tokens, substitutions) {
  return tokens.map((token) => (Object.hasOwn(substitutions, token) ? substitutions[token] : token));
}

test("the flagship governed loop replays end-to-end through the CLI with an unbroken trace digest chain", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-e2e-governed-loop-")));
  context.after(() => rm(base, { recursive: true, force: true }));

  // The live substitution table: the library placeholder first, identifiers as the
  // storyline captures them from each receipt.
  const substitutions = { [WORKSPACE_PATH]: join(base, ".ether"), "<story-goal>": STORY_GOAL, "<story-acceptance>": STORY_ACCEPTANCE };

  // Create the library at version zero.
  const initReceipt = await invoke(render(initCommand, substitutions));
  assert.equal(initReceipt.reasonCode, "LIBRARY_CREATED", "init");
  assert.equal(initReceipt.version, 0);
  const registered = await invoke([
    "library-register",
    "--project", base,
    "--library", substitutions[WORKSPACE_PATH],
    "--at", "2026-07-11T00:00:00Z",
  ]);
  assert.equal(registered.reasonCode, "LIBRARY_REGISTERED", "the done transition resolves the same project root as the gate run");

  // Replay the governed loop, asserting each step's observable reason and
  // capturing the identifiers later steps depend on.
  const captured = {};
  for (const step of governedLoopStoryline) {
    if (step.key === "work-transition-story-done") {
      const workspace = substitutions[WORKSPACE_PATH];
      const storyId = substitutions["<story-id>"];
      const command = [process.execPath, "-e", "process.exit(0)"];
      const declaration = await invoke([
        "gates-config-set", "--workspace", workspace, "--at", "2026-07-11T00:00:09Z",
        "--name", "fixture-story-coverage", "--command", JSON.stringify(command),
        "--root", ".", "--covers", storyId, "--required", "true",
      ]);
      assert.deepEqual(declaration.gate, {
        name: "fixture-story-coverage", command, root: ".", covers: [storyId], required: true, enabled: true, releaseOnly: false,
      });
      const gateRun = await invoke([
        "gates-run", "--workspace", workspace, "--at", "2026-07-11T00:00:09Z",
        "--release", "true", "--work-id", storyId,
      ]);
      assert.equal(gateRun.reasonCode, "GATES_RUN_COMPLETED");
      assert.equal(gateRun.ok, true);
      assert.deepEqual(gateRun.requiredReds, []);
      assert.deepEqual(gateRun.run.workIds, [storyId]);
      assert.deepEqual(gateRun.run.gates.map(({ name, required, matchedWorkIds, ok }) => [name, required, matchedWorkIds, ok]), [
        ["fixture-story-coverage", true, [storyId], true],
      ], "the required gate ran green with exact coverage for this Story");
    }
    const output = await invoke(render(step.command, substitutions));
    assert.equal(output.reasonCode, step.reasonCode, step.key);
    switch (step.key) {
      case "project-create":
        substitutions["<project-id>"] = output.record.id;
        break;
      case "work-create-initiative":
        substitutions["<initiative-id>"] = output.record.id;
        break;
      case "work-create-epic":
        substitutions["<epic-id>"] = output.record.id;
        break;
      case "work-create-story":
        substitutions["<story-id>"] = output.record.id;
        break;
      case "minutes-record":
        captured.minutesId = output.id;
        captured.recorded = output;
        substitutions["<minutes-id>"] = output.id;
        break;
      case "work-show-story":
        captured.story = output.record;
        captured.storyFields = output.fields;
        captured.storyAdvisory = output.advisory;
        captured.storyRelations = output.relations;
        break;
      case "minutes-show":
        captured.minutes = output.record;
        captured.decides = output.decides;
        break;
      default:
        break;
    }
  }

  // --- Trace: the unbroken digest chain (acceptance criterion 3) --------------
  // Node 1 -> 2: the story names the minutes it was decided in. The Story's goal names Owner as
  // its decider, so it reaches done only once that relation is on the record.
  assert.equal(captured.story.id, substitutions["<story-id>"]);
  assert.equal(captured.story.status, "done", "the story reached done with its decision recorded");
  // The Story is the goal and the acceptance it was created with (TCRN-CROSS-STORY-473).
  assert.deepEqual(captured.storyFields, { goal: STORY_GOAL, acceptance: STORY_ACCEPTANCE, body: null, source: "fields" });
  assert.deepEqual(captured.storyRelations.forward.decidedIn, [captured.minutesId], "the story names the minutes that decided it");
  assert.deepEqual(captured.storyAdvisory.decidedBy, [captured.minutesId], "decided-in is the decided-by list on the record");
  assert.ok(captured.minutesId.startsWith(MINUTES_PREFIX));

  // Node 2 -> 1: the minutes name the story they bear on, and the reverse relation reads back.
  assert.deepEqual(captured.recorded.decisions, [{ number: 1, text: RECORDED_DECISION }], "the record command echoes D1");
  assert.equal(captured.minutes.id, captured.minutesId);
  assert.equal(captured.minutes.externalKey, "FLAGSHIP-MINUTES-1");
  assert.equal(captured.minutes.title, MINUTES_TITLE);
  assert.deepEqual(captured.minutes.decisions, [{ number: 1, text: RECORDED_DECISION }]);
  assert.deepEqual(captured.minutes.linkedWorkIds, [captured.story.id], "the minutes link the story");
  assert.deepEqual(captured.decides, [captured.story.id], "and the story is what the minutes decide");

  // The node digests, ordered, hash to a single stable chain digest -- the whole loop's
  // evidence collapses to one 64-hex value that changes if a single node or edge changes.
  const chainDigest = canonicalSha256([
    canonicalSha256({ story: captured.story, decidedIn: captured.storyRelations.forward.decidedIn }),
    canonicalSha256({ minutes: captured.minutes, decides: captured.decides }),
  ]);
  assert.match(chainDigest, /^[a-f0-9]{64}$/u);

  // --- Doc/proof lockstep (acceptance criterion 2), re-derived in-proof -------
  const tutorial = await readFile(new URL("../docs/tutorial/governed-loop.md", import.meta.url), "utf8");
  const documented = extractTutorialCommands(tutorial).map(canonicalizeCommand);
  const authored = expectedTutorialCommands().map(canonicalizeCommand);
  assert.deepEqual(documented, authored, "every tutorial command matches the replayed storyline verbatim");
});
