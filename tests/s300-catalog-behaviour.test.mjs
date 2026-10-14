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

// TCRN-CROSS-STORY-526 GWT5 (TCRN-CROSS-SUB-455): --help on each of the eight writes that may cite an
// Owner decision names --decided-in and how a decision is cited.
test("526 GWT5: --help on the eight writes names decided-in and its written form minutes:<id>#D<n>", async () => {
  for (const name of ["gates-config-set", "gates-config-remove", "rule-enable", "rule-disable", "settings-set", "settings-remove", "variable-set", "variable-remove"]) {
    const result = await capture([name, "--help"]);
    assert.equal(result.ok, true, `${name} --help must not refuse: ${result.reasonCode ?? ""}`);
    assert.match(result.output, /"decided-in"/u, name);
    assert.match(result.output, /minutes:<id>#D<n>/u, name);
    const flag = JSON.parse(result.output).commands[0].flags.find((entry) => entry.name === "decided-in");
    assert.deepEqual([flag.required, flag.valueKind, flag.valueShape], [false, "string", "minutes:<id>#D<n>"], name);
  }
});

// TCRN-CROSS-STORY-541 GWT1 (MIN-258 D3; TCRN-CROSS-SUB-510): the four more writes that may cite an Owner
// decision name it in --help the same way.
test("541 GWT1: --help on work-gate-release, project-bindings-set and -remove and work-release names decided-in", async () => {
  for (const name of ["work-gate-release", "project-bindings-set", "project-bindings-remove", "work-release"]) {
    const result = await capture([name, "--help"]);
    assert.equal(result.ok, true, `${name} --help must not refuse: ${result.reasonCode ?? ""}`);
    const flag = JSON.parse(result.output).commands[0].flags.find((entry) => entry.name === "decided-in");
    assert.deepEqual([flag?.required, flag?.valueKind, flag?.valueShape], [false, "string", "minutes:<id>#D<n>"], name);
  }
  const declare = JSON.parse((await capture(["chain-declare", "--help"])).output).commands[0];
  assert.equal(declare.flags.some((entry) => entry.name === "decided-in"), false, "chain-declare takes no decision");
});

// TCRN-CROSS-STORY-527 (Q6; TCRN-CROSS-SUB-478): --help on the four proposal verbs answers their own
// flags, and on the two lists names --status.
test("527 Q6: --help on the proposal verbs answers their flags, and the two lists take --status", async () => {
  for (const name of ["gates-config-propose", "rule-propose", "proposal-approve", "proposal-reject", "gates-config-list", "rule-list"]) {
    const result = await capture([name, "--help"]);
    assert.equal(result.ok, true, `${name} --help must not refuse: ${result.reasonCode ?? ""}`);
    const entry = JSON.parse(result.output).commands[0];
    assert.equal(entry.name, name);
    if (name.endsWith("-list")) assert.ok(entry.flags.some((flag) => flag.name === "status"), name);
    else assert.ok(entry.flags.some((flag) => flag.name === "actor" && flag.required), name);
  }
});
