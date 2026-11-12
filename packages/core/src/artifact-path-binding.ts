// SPDX-License-Identifier: Apache-2.0
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceHome } from "./device-home.js";
import { projectArtifactBinding } from "./portable-path.js";

export { isProjectArtifactBinding, projectArtifactBinding, resolveProjectArtifactBinding } from "./portable-path.js";

/** Device-local location, keyed by stable library/project identity, not by another device's path. */
export async function bindProjectArtifactPath(libraryId: string, projectId: string, path: string): Promise<string> {
  const value = projectArtifactBinding(libraryId, projectId);
  const home = deviceHome();
  await mkdir(join(home, "artifact-paths"), { recursive: true });
  const body = JSON.stringify({ schemaVersion: "einzbern.project-artifact-path.v1", libraryId, projectId, path });
  const target = join(home, "artifact-paths", `${value.slice("binding:projectArtifacts/".length)}.json`);
  const staging = `${target}.${process.pid}.tmp`;
  await writeFile(staging, body, { mode: 0o600 });
  await rename(staging, target);
  return value;
}
