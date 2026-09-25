// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-258: stopped backup mechanisms are not install obligations.
// TCRN-CROSS-INC-274: live-platform testing replaced with synthetic fixture;
// whether this machine's install surface is correct is platform-doctor's job —
// it accepts an explicit --platform-root, not a unit test.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { INSTALL_MANIFEST, INSTALL_MANIFEST_REQUIRED_ITEM_IDS, assertInstallManifestComplete } from "../dist/build/packages/core/src/index.js";
import { inspectInstallWiring } from "../scripts/platform-doctor.mjs";

const REMOVED_IDS = ["machine.local-snapshot-receipt", "machine.offsite-push-receipt"];

async function createInstallFixture(context, { skipItems = [] } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc258-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  const home = join(base, "home");

  await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  await mkdir(home, { recursive: true });

  // Create all manifest items except the skipped ones
  for (const entry of INSTALL_MANIFEST.items) {
    if (skipItems.includes(entry.id)) continue;

    const path = entry.pathTemplate.replaceAll("<PLATFORM_ROOT>", root).replaceAll("<HOME>", home);

    if (
      entry.acceptanceProbe.startsWith("probe:regular-directory") ||
      entry.acceptanceProbe.startsWith("probe:engine-version")
    ) {
      await mkdir(path, { recursive: true });
    } else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "{}\n");
      if (entry.acceptanceProbe.startsWith("probe:regular-executable")) {
        await chmod(path, 0o755);
      }
    }
  }

  return { root, home };
}

test("INC-258 install wiring accepts the stopped backup removal", async (context) => {
  const fixture = await createInstallFixture(context, { skipItems: REMOVED_IDS });
  const result = await inspectInstallWiring(fixture.root, fixture.home);
  assert.equal(result.ok, true);
});

test("INC-258 install manifest matches the post-removal surface and rejects restored receipts", async (context) => {
  const fixture = await createInstallFixture(context, { skipItems: REMOVED_IDS });
  assertInstallManifestComplete(INSTALL_MANIFEST);
  // 20 until TCRN-CROSS-STORY-467 R3 retired the two adapter bundles, their two install
  // receipts and the engine repository's own settings fixture; 14 since R2 retired the
  // helper trust archive.
  assert.equal(INSTALL_MANIFEST.items.length, 14);
  assert.deepEqual(REMOVED_IDS.filter((id) => INSTALL_MANIFEST.items.some((entry) => entry.id === id)), []);
  assert.deepEqual(REMOVED_IDS.filter((id) => INSTALL_MANIFEST_REQUIRED_ITEM_IDS.includes(id)), []);
  const restored = {
    ...INSTALL_MANIFEST,
    items: [
      ...INSTALL_MANIFEST.items,
      { id: REMOVED_IDS[0], layer: "machine", host: "shared", pathTemplate: "<PLATFORM_ROOT>/missing-local.json", writer: "user-guided", acceptanceProbe: "probe:local-snapshot-freshness;maxAgeHours=26" },
      { id: REMOVED_IDS[1], layer: "machine", host: "shared", pathTemplate: "<PLATFORM_ROOT>/missing-offsite.json", writer: "user-guided", acceptanceProbe: "probe:offsite-push-freshness;maxAgeHours=26" },
    ],
  };
  const red = await inspectInstallWiring(fixture.root, fixture.home, restored);
  assert.equal(red.ok, false);
  assert.deepEqual(red.missing.map((entry) => entry.id).sort(), [...REMOVED_IDS].sort());
});
