// SPDX-License-Identifier: Apache-2.0
// Fixture for an installed version that still emitted variable snapshots. Production writers
// must never call this: tests seed the old file and native records, then exercise migration.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { materializeWorkspace, scopedWorkspaceState } from "../../dist/build/packages/core/src/index.js";
import { setConfigRecord } from "../../dist/build/packages/core/src/config-records.js";
import { managedSectionRecordsFor, renderSection, sectionDigest } from "../../dist/build/packages/core/src/managed-sections.js";
import { renderSystemVariablesSection, renderCustomVariablesSection } from "../../dist/build/packages/core/src/variables-sections.js";

export async function seedLegacyVariableSections({ libraryRoot, projectRoot, projectId, occurredAt,
  ids = ["variables-system", "variables-custom"] }) {
  const state = scopedWorkspaceState(await materializeWorkspace(libraryRoot), projectId);
  const records = managedSectionRecordsFor(state, "AGENTS.md");
  const path = join(projectRoot, "AGENTS.md");
  let text = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  for (const id of ids) {
    const body = (id === "variables-system" ? renderSystemVariablesSection(state) : renderCustomVariablesSection(state)).body;
    const rev = (records.find(record => record.id === id)?.rev ?? 0) + 1;
    text += `\n${renderSection({ id, body, rev })}`;
    await setConfigRecord(libraryRoot, { projectId, collection: "managed-section", key: `AGENTS.md#${id}`,
      value: { file: "AGENTS.md", id, rev, digest: sectionDigest(body), state: "managed" }, occurredAt });
  }
  await writeFile(path, text);
}
