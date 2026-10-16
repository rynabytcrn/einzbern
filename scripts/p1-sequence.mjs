// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-218 — the P1 gate roster, written once.
//
// Two runners drive P1 and they need different things from it. `verify:p1` runs the
// verbs in-process; `preflight` runs each as its own `pnpm` process in a scrubbed
// environment inside an isolated clone. Both collect every red, so the first failure
// cannot hide a second one (`verify:p1` stopped at the first red until
// TCRN-CROSS-STORY-467 R5). Those are two ways of running the same
// list, and until this file existed each runner carried its own copy of it.
//
// The copies had already drifted. `verify:p1` ran `portal` and `no-sibling-dependency`;
// preflight's list held neither — so the one world that proves this repository stands up
// without its siblings was precisely the world that never ran the sibling gate. Nothing
// compared the two lists, and nothing would have.
//
// That is the failure this platform keeps paying for: a hand-kept roster goes stale at
// the exact moment a new member is admitted, and it goes stale silently, because a list
// nobody checks still looks like coverage. The no-sibling gate's own sibling discovery
// was written to avoid it; its runner list reintroduced it one directory away.

/**
 * P1, in order.
 *
 * `task` is the verb `scripts/task.mjs` dispatches. `script` is the `package.json` entry
 * preflight spawns. They are stated together because the pair is what has to stay true:
 * a roster naming a verb whose script runs something else is the same drift in a smaller
 * space, and `tests/p1-roster.test.mjs` holds them to it.
 */
export const P1_SEQUENCE = Object.freeze([
  { task: "format-check", script: "format:check" },
  { task: "lint", script: "lint" },
  { task: "typecheck", script: "typecheck" },
  { task: "build", script: "build" },
  // TCRN-CROSS-STORY-359: `test` is the widest leg and now the only one that runs the
  // suite. Every subset verb this roster used to carry -- test-trust, roots, and the
  // ticket-numbered focus verbs -- filtered the same `tests/**/*.test.mjs` set this one
  // runs unfiltered, so removing them retired convenience, not coverage.
  { task: "test", script: "test" },
  // `portal` is the one entry whose script does not dispatch through task.mjs: both the
  // verb and `verify:portal` run scripts/verify-portal.mjs directly. Declared here rather
  // than special-cased in the test, so the exception is visible where the roster is read.
  { task: "portal", script: "verify:portal", dispatchesThroughTask: false },
  // `archive` stays on the roster because `privacy` below scans the source archive when
  // one is present and silently scans less when it is not. Dropping the producer would
  // have narrowed the privacy surface without any gate saying so.
  { task: "archive", script: "archive" },
  { task: "no-sibling-dependency", script: "verify:no-sibling-dependency" },
  { task: "offline", script: "verify:offline" },
  { task: "privacy", script: "verify:privacy" },
  // TCRN-CROSS-INC-232: near the end, because it is the cheapest leg in the train
  // and ordering it early would delay every expensive gate behind a documentation
  // question. It exists because a published code of conduct spent a day telling readers
  // the authoritative text was at a path that did not exist, and every gate above was
  // green throughout -- nothing here had ever checked a documentation link.
  { task: "links", script: "verify:links" },
  { task: "retrieval-eval", script: "verify:retrieval-eval" },
].map((entry) => Object.freeze({ dispatchesThroughTask: true, ...entry })));

/** The verb names, in order — what `verify:p1` walks. */
export const P1_TASKS = Object.freeze(P1_SEQUENCE.map((entry) => entry.task));

/**
 * Run every rostered leg and collect every red (TCRN-CROSS-STORY-467 R5): a red leg no
 * longer hides the legs after it. `runLeg(task)` resolves to the leg's result, which must
 * carry a `reasonCode`, or rejects with an error that carries one. A leg that rejects
 * without a reason code, or resolves without one, is still a named red.
 */
export async function runAllP1Legs(runLeg, tasks = P1_TASKS, now = () => performance.now()) {
  const legs = [];
  const reds = [];
  // TCRN-CROSS-MIN-280 D2: how long each leg took, in its own list so the leg rows keep their
  // shape. A red leg is timed too; the time runs from the leg's start to its result or rejection.
  const durations = [];
  for (const task of tasks) {
    const started = now();
    try {
      const result = await runLeg(task);
      if (typeof result?.reasonCode !== "string" || result.reasonCode.length === 0) {
        legs.push({ task, ok: false, reasonCode: "P1_LEG_REASON_MISSING" });
        reds.push({ task, reasonCode: "P1_LEG_REASON_MISSING", message: "the leg returned no reason code" });
        continue;
      }
      const notice = result.notice === null || result.notice === undefined ? {} : { notice: result.notice };
      legs.push({ task, ok: true, reasonCode: result.reasonCode, ...notice });
    } catch (error) {
      const reasonCode = typeof error?.reasonCode === "string" && error.reasonCode.length > 0 ? error.reasonCode : "P1_LEG_INTERNAL_ERROR";
      legs.push({ task, ok: false, reasonCode });
      reds.push({ task, reasonCode, message: String(error?.message ?? error).slice(0, 2000) });
    } finally {
      durations.push({ task, durationMs: Math.round(now() - started) });
    }
  }
  return { reasonCode: reds.length === 0 ? "P1_VERIFIED" : "P1_RED", legs, reds, durations };
}

/** `[key, argv]` pairs — what preflight spawns, one process per gate. */
export const P1_GATE_SPECS = Object.freeze(
  P1_SEQUENCE.map((entry) => Object.freeze([
    entry.task,
    Object.freeze(["pnpm", "run", "--silent", entry.script]),
  ])),
);
