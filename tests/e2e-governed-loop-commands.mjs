// SPDX-License-Identifier: Apache-2.0

// WSG-6: the single source of truth for the flagship governed-loop storyline.
//
// This module is pure data plus pure string helpers — it imports nothing and
// writes nothing, so both the hermetic proof (tests/e2e-governed-loop.test.mjs)
// and the doc-proof lockstep gate (scripts/task.mjs `e2e`) load it without a
// build step. The storyline is authored ONCE here; the tutorial
// (docs/tutorial/governed-loop.md) must reproduce the exact same fenced command
// tokens, and both the proof and the gate re-derive that equality so the doc and
// the proof can never drift (acceptance criterion 2).
//
// Path values are workspace-relative placeholders and identifiers are
// angle-bracket placeholders (GAP-5: no absolute paths, no hostnames). The proof
// substitutes real mkdtemp paths and real receipt-derived identifiers at replay
// time; the gate compares the placeholder tokens verbatim.

// The published binary name each fenced command is prefixed with in the tutorial.
export const CLI_BINARY = "einzbern";

// The library placeholder (an identical literal token in the tutorial): a project's library is
// the .ether directory in its root (TCRN-CROSS-STORY-469).
export const WORKSPACE_PATH = "./flagship/.ether";

// The Story is created atomically with its complete scope.  The tutorial keeps
// the value as a placeholder; the replay substitutes this one canonical fixture
// so the command remains readable without weakening the engine admission rule.
export const STORY_SCOPE = [
  "【Goal】为谁改变什么=flagship Story；目的锚=governed-loop；符合性判据=loop reaches done with evidence；判定人=Owner。",
  "【Requirements】现象与证据=命令回放；修复项=完成 flagship loop。",
  "【Acceptance Criteria】GIVEN the workspace is ready WHEN the loop runs THEN the Story reaches done。",
  "【Business Background】evidence=the loop is the canonical tutorial path。",
  "【Preconditions】无——原因：the library is created by init。",
  "【Assumptions】无——原因：the tutorial does not add a runtime setting。",
  "【Use Cases & Examples】无——原因：the command sequence is the example。",
  "【Feature Toggle & Setting】无——原因：no bypass flag is permitted。",
  "【Permissions】Owner is the decider; the engine is the write face。",
  "【Implementation Notes】决策点及裁定状态=the Story starts planned and transitions through the loop。",
].join("\n");

// The init command is narrated and executed but is NOT part of the mutation
// storyline (it creates the library at version zero). It is listed separately so
// the proof can create the library before the loop begins while the lockstep gate
// still checks it against the tutorial.
export const initCommand = [
  "init",
  "--workspace",
  WORKSPACE_PATH,
  "--project-name",
  "Flagship",
  "--at",
  "2026-07-11T00:00:00Z",
];

// The governed loop, in replay order. Each step carries:
//   key         — a stable label the proof keys its capture logic on
//   command     — the exact fenced command tokens (after the binary prefix)
//   reasonCode  — the observable success reason the proof asserts
export const governedLoopStoryline = [
  {
    key: "project-create",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["project-create", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:01Z", "--external-key", "FLAGSHIP-PROJECT", "--name", "Flagship"],
  },
  {
    key: "work-create-initiative",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-create", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:02Z", "--project-id", "<project-id>", "--external-key", "FLAGSHIP-INITIATIVE", "--kind", "Initiative", "--title", "Flagship-initiative"],
  },
  {
    key: "work-create-epic",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-create", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:03Z", "--project-id", "<project-id>", "--external-key", "FLAGSHIP-EPIC", "--kind", "Epic", "--parent-id", "<initiative-id>", "--title", "Flagship-epic"],
  },
  {
    key: "work-create-story",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-create", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:04Z", "--project-id", "<project-id>", "--external-key", "FLAGSHIP-STORY", "--kind", "Story", "--parent-id", "<epic-id>", "--scope", "<story-scope>", "--title", "Flagship-story"],
  },
  {
    key: "work-transition-story-ready",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-transition", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:05Z", "--id", "<story-id>", "--status", "ready"],
  },
  {
    key: "work-transition-story-active",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-transition", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:06Z", "--id", "<story-id>", "--status", "active"],
  },
  {
    key: "minutes-record",
    reasonCode: "MINUTES_RECORDED",
    command: ["minutes-record", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:08Z", "--project-id", "<project-id>", "--external-key", "FLAGSHIP-MINUTES-1", "--title", "Decide-the-story", "--summary", "approach-ratified", "--decisions", "persist-the-decision-as-minutes", "--decided-by", "owner:governance", "--work-ids", "<story-id>"],
  },
  {
    key: "work-annotate-story-decided-in",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-annotate", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:09Z", "--id", "<story-id>", "--decided-in", "<minutes-id>"],
  },
  {
    key: "work-transition-story-done",
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    command: ["work-transition", "--workspace", WORKSPACE_PATH, "--at", "2026-07-11T00:00:10Z", "--id", "<story-id>", "--status", "done"],
  },
  {
    key: "work-show-story",
    reasonCode: "WORKSPACE_RECORD_READY",
    command: ["work-show", "--workspace", WORKSPACE_PATH, "--id", "<story-id>"],
  },
  {
    key: "minutes-show",
    reasonCode: "WORKSPACE_RECORD_READY",
    command: ["minutes-show", "--workspace", WORKSPACE_PATH, "--id", "<minutes-id>"],
  },
];

// The minutes the loop records: their title and single decision, which the trace reads back as D1.
// TCRN-CROSS-STORY-475 replaced the conference, its close and the distillation into a knowledge
// candidate with one minutes-record; the story names the minutes with the decided-in relation.
export const MINUTES_TITLE = "Decide-the-story";
export const RECORDED_DECISION = "persist-the-decision-as-minutes";

// Canonical string form of a command's tokens, used only for the lockstep diff.
// Both sides feed placeholder tokens through this identically, so the comparison
// is exact token equality with a separator that cannot appear inside a token.
export function canonicalizeCommand(tokens) {
  return tokens.join("\u0000");
}

// Extract the fenced command lines from the tutorial markdown. A command line is
// any line inside a fenced block that begins with the "$ " prompt; every other
// fenced line (example output) is ignored. The binary prefix is stripped so the
// returned token arrays align with each storyline step's `command`.
export function extractTutorialCommands(markdown) {
  const commands = [];
  let inFence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed.startsWith("$ ")) {
      continue;
    }
    const tokens = trimmed.slice(2).split(/\s+/u);
    if (tokens[0] === CLI_BINARY) {
      tokens.shift();
    }
    commands.push(tokens);
  }
  return commands;
}

// The full ordered token list the tutorial must reproduce: the init command
// followed by every storyline command.
export function expectedTutorialCommands() {
  return [initCommand, ...governedLoopStoryline.map((step) => step.command)];
}
