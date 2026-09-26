// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-466 R2, STORY-469 (SUB-285): the frozen old-layout workspace, restored into a
// fresh directory in the layout the old engine wrote. This engine writes libraries only, so the
// fixture is the one way a test gets an old-layout workspace to read.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { LEGACY_CONTROL_DIRECTORY } from "../../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../../dist/build/packages/protocol/src/index.js";

export const LEGACY_FIXTURE_ROOT = resolve(import.meta.dirname, "../fixtures/legacy-workspace");
export const LEGACY_FIXTURE_EXPECTED = JSON.parse(await readFile(join(LEGACY_FIXTURE_ROOT, "expected.json"), "utf8"));

/** Restore the fixture as `<base>/<name>`: its root, control directory and events directory. */
export async function restoreLegacyFixture(base, name = "workspace") {
  const root = join(base, name);
  const control = join(root, LEGACY_CONTROL_DIRECTORY);
  const events = join(control, "events");
  await mkdir(events, { recursive: true });
  const canonical = async (relativePath) => canonicalJson(JSON.parse(await readFile(join(LEGACY_FIXTURE_ROOT, "control", relativePath), "utf8")));
  await writeFile(join(control, "workspace.json"), await canonical("workspace.json"));
  await writeFile(join(events, "manifest.json"), await canonical("events/manifest.json"));
  for (const entry of (await readdir(join(LEGACY_FIXTURE_ROOT, "control/events"))).filter((name) => name.endsWith(".ndjson"))) {
    await writeFile(join(events, entry), await readFile(join(LEGACY_FIXTURE_ROOT, "control/events", entry)));
  }
  return { root, control, events };
}
