// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-469 R3: a test never reaches the real device directory. Importing this module
// points EINZBERN_HOME at a fresh temporary directory for the whole test process, unless the
// runner already chose one, and removes it when the process exits.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.EINZBERN_HOME === undefined || process.env.EINZBERN_HOME === "") {
  const directory = mkdtempSync(join(tmpdir(), "einzbern-test-device-"));
  process.env.EINZBERN_HOME = join(directory, "einzbern");
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
}

export const testDeviceHome = process.env.EINZBERN_HOME;

/**
 * Run `operation` as a device with a fixed identity, in a device directory of its own, and put
 * the test process's device back afterwards. For a test whose golden bytes include event hashes:
 * every einzbern event hashes its device id (TCRN-CROSS-STORY-468 R3).
 */
export async function asPinnedDevice(operation, deviceId = "d".repeat(32)) {
  const directory = mkdtempSync(join(tmpdir(), "einzbern-test-pinned-"));
  const home = join(directory, "einzbern");
  mkdirSync(home);
  writeFileSync(join(home, "device.json"), `${JSON.stringify({ createdAt: "2026-01-01T00:00:00Z", deviceId, displayName: "pinned", schemaVersion: "einzbern.device.v1" })}\n`);
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  try {
    return await operation(home);
  } finally {
    process.env.EINZBERN_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}
