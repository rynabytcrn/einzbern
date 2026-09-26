// SPDX-License-Identifier: Apache-2.0
//
// STORY-300 slice 1. The command catalog is the only authority on what exists, and
// two of its promises had nothing behind them.
//
// The first was the head sentinel: the catalog declared which verbs accepted
// `--expected-version head`, and a behavioural probe here checked that every declaring
// handler resolved it. TCRN-CROSS-STORY-467 R1 removed the caller-supplied version, and
// the sentinel with it -- writers take the engine write lock and append to the head they
// find under it -- so that probe went with its subject.
//
// The second is discoverability. The catalog has always carried each flag's name,
// required flag and value kind; there was simply no way to ask for one verb's entry
// without either dumping all 130 or reading the source. `--help` was refused 35
// times in this chain's history, which is the most expensive single refusal in it.

import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";

async function capture(argv) {
  const chunks = [];
  try {
    await runCli(argv, { write(value) { chunks.push(value); } });
    return { ok: true, output: chunks.join("") };
  } catch (error) {
    return { ok: false, reasonCode: error?.reasonCode, message: String(error?.message ?? error), output: chunks.join("") };
  }
}

// Red leg: remove the `--help` branch and this returns the verb's ordinary refusal
// (or, for a verb with no required flags, runs it) instead of its catalog entry.
test("STORY-300: --help returns the verb's own argument surface without reading engine source", async () => {
  // conference-open was the third verb here until TCRN-CROSS-STORY-475 R3 retired it.
  for (const name of ["work-create", "work-annotate", "status"]) {
    const result = await capture([name, "--help"]);
    assert.equal(result.ok, true, `${name} --help must not refuse: ${result.reasonCode ?? ""} ${result.message ?? ""}`);
    const payload = JSON.parse(result.output);
    assert.equal(payload.reasonCode, "CLI_CATALOG_READY", "help reuses the catalog reason code rather than minting one");
    assert.equal(payload.commands.length, 1, "help answers about the verb that was asked for, not all of them");
    const entry = payload.commands[0];
    assert.equal(entry.name, name);
    // The whole point: a caller can build a valid invocation from this alone.
    for (const flag of entry.flags) {
      assert.equal(typeof flag.name, "string");
      assert.equal(typeof flag.required, "boolean");
      assert.equal(typeof flag.valueKind, "string");
    }
  }
  // An unknown verb keeps its existing refusal rather than answering emptily.
  const unknown = await capture(["not-a-verb", "--help"]);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reasonCode, "CLI_COMMAND_UNKNOWN");
});
