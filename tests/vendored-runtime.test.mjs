// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateVendoredRuntimeInventory } from "../scripts/lib/vendored-runtime.mjs";

const root = new URL("../", import.meta.url);
async function inputs() {
  const inventory = JSON.parse(await readFile(new URL("scripts/policy/vendored-runtime.json", root), "utf8"));
  const snapshot = await readFile(new URL("portal/ds-static-bridges.snapshot.js", root));
  const notice = await readFile(new URL("THIRD_PARTY_NOTICES.txt", root));
  return { inventory, snapshot, notice };
}

test("shipped React components have digest-bound vendored inventory and their MIT notice", async () => {
  const { inventory, snapshot, notice } = await inputs();
  const components = validateVendoredRuntimeInventory(inventory, snapshot, notice);
  assert.deepEqual(components.map(({ name, version }) => ({ name, version })), [
    { name: "react", version: "19.1.0" }, { name: "react-dom", version: "19.1.0" },
  ]);
  assert.match(notice.toString(), /Copyright \(c\) Meta Platforms, Inc\. and affiliates\./u);
  assert.match(notice.toString(), /The above copyright notice and this permission notice shall be included/u);
  for (const component of components) {
    assert.equal(component.scope, "required");
    assert.equal(component.licenses[0].license.id, "MIT");
    assert.equal(component.properties.find(({ name }) => name === "einzbern:source-sha256").value, createHash("sha256").update(snapshot).digest("hex"));
  }
});

test("changed snapshot or notice cannot silently retain a stale vendored inventory", async () => {
  const { inventory, snapshot, notice } = await inputs();
  assert.throws(() => validateVendoredRuntimeInventory(inventory, Buffer.concat([snapshot, Buffer.from("\n")]), notice), { reasonCode: "VENDORED_RUNTIME_INVALID" });
  assert.throws(() => validateVendoredRuntimeInventory(inventory, snapshot, Buffer.concat([notice, Buffer.from("\n") ])), { reasonCode: "VENDORED_RUNTIME_INVALID" });
});

test("vendored runtime components reject duplicate identities and floating versions", async () => {
  const { inventory, snapshot, notice } = await inputs();
  assert.throws(() => validateVendoredRuntimeInventory({ ...inventory, components: [...inventory.components, inventory.components[0]] }, snapshot, notice), { reasonCode: "VENDORED_RUNTIME_INVALID" });
  assert.throws(() => validateVendoredRuntimeInventory({ ...inventory, components: [{ ...inventory.components[0], version: "^19.1.0" }] }, snapshot, notice), { reasonCode: "VENDORED_RUNTIME_INVALID" });
});
