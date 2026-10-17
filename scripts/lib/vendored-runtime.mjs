// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

export const VENDORED_RUNTIME_SOURCE = "portal/ds-static-bridges.snapshot.js";
export const VENDORED_RUNTIME_NOTICES = "THIRD_PARTY_NOTICES.txt";

function requireValue(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { reasonCode: "VENDORED_RUNTIME_INVALID" });
}

/** Bind the reviewed component inventory to the exact shipped snapshot and notice. */
export function validateVendoredRuntimeInventory(inventory, snapshotBytes, noticeBytes) {
  requireValue(inventory?.schemaVersion === "einzbern.vendored-runtime.v1", "unknown vendored runtime inventory schema");
  requireValue(inventory.source === VENDORED_RUNTIME_SOURCE, "unexpected vendored runtime source");
  requireValue(inventory.notices === VENDORED_RUNTIME_NOTICES, "unexpected vendored runtime notices");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  requireValue(inventory.sha256 === digest(snapshotBytes), "vendored runtime snapshot changed; review its component inventory");
  requireValue(inventory.noticesSha256 === digest(noticeBytes), "vendored runtime notices changed; review their inventory binding");
  requireValue(Array.isArray(inventory.components) && inventory.components.length > 0, "vendored runtime components are required");
  const identities = new Set();
  return inventory.components.map((component) => {
    requireValue(typeof component?.name === "string" && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(component.name), "invalid vendored component name");
    requireValue(typeof component.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(component.version), "vendored components require exact versions");
    requireValue(component.license === "MIT", "review the notice handling before adding a different vendored license");
    const identity = `${component.name}@${component.version}`;
    requireValue(!identities.has(identity), "duplicate vendored component identity");
    identities.add(identity);
    return {
      type: "library", name: component.name, version: component.version, scope: "required",
      licenses: [{ license: { id: component.license } }],
      purl: `pkg:npm/${encodeURIComponent(component.name)}@${component.version}`,
      properties: [
        { name: "einzbern:distribution", value: "vendored-snapshot" },
        { name: "einzbern:source-path", value: inventory.source },
        { name: "einzbern:source-sha256", value: inventory.sha256 },
        { name: "einzbern:notices", value: inventory.notices },
      ],
    };
  });
}
