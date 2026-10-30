// SPDX-License-Identifier: Apache-2.0
// Retirement fixtures only; no native Codex session or multi-conversation claim.
import assert from "node:assert/strict";
import test from "node:test";
import { mergeHostHooks, planHostHooks } from "../dist/build/packages/core/src/host-hooks.js";

const command = 'node "/old/device/engine/hook.mjs" subagent-stop';
const owned = { type: "command", command };
const unrelated = { type: "command", command: "another-tool stop", timeout: 3 };
const plan = () => planHostHooks({ host: "codex", scope: "user", deviceHome: "/fixture/device" });

test("Codex retirement consumes only exact owned defaults, including duplicates in mixed groups", () => {
  const before = { description: "keep", hooks: { SubagentStop: [{ hooks: [owned, unrelated, owned] }], Notification: [{ hooks: [unrelated] }] } };
  const copy = structuredClone(before);
  const result = mergeHostHooks(before, plan());
  assert.deepEqual(before, copy, "planning is pure");
  assert.deepEqual(result.document.hooks.SubagentStop, [{ hooks: [unrelated] }]);
  assert.deepEqual(result.document.hooks.Notification, before.hooks.Notification);
  assert.equal(result.document.description, "keep");
  assert.deepEqual(result.removedHooks, [{ event: "SubagentStop", command }, { event: "SubagentStop", command }]);
  const repeated = mergeHostHooks(result.document, plan());
  assert.deepEqual(repeated.document, result.document);
  assert.deepEqual(repeated.removedHooks, []);
});

test("edited and unknown stop hooks survive retirement byte-for-byte in their original order", () => {
  const groups = [
    { matcher: "owner", hooks: [owned] },
    { timeout: 7, hooks: [owned] },
    { settings: { enabled: false }, hooks: [owned] },
    { hooks: [{ ...owned, timeout: 3 }] },
    { hooks: [{ ...owned, settings: { custom: true } }] },
    { hooks: [{ type: "command", command: `${command} --custom` }] },
    { hooks: [{ type: "command", command: 'node "/unknown/hook.mjs" subagent-stop' }] },
    { future: "opaque", hooks: "unknown format" },
    { hooks: [unrelated] },
  ];
  for (const admission of [undefined, { state: "supported", version: "fixture", evidenceRef: "synthetic-only", subagentStop: true, trust: "permitted" }]) {
    const expected = planHostHooks({ host: "codex", scope: "user", deviceHome: "/fixture/device", codexAdmission: admission });
    assert.equal(expected.groups.SubagentStop, undefined);
    const result = mergeHostHooks({ hooks: { SubagentStop: groups } }, expected);
    assert.deepEqual(result.document.hooks.SubagentStop, groups);
    assert.deepEqual(result.removedHooks, []);
  }
});
