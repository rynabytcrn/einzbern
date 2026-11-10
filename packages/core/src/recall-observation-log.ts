// SPDX-License-Identifier: Apache-2.0
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceHome } from "./device-home.js";
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { CACHE_VIEWS_SCHEMA_VERSION } from "./library-cache.js";
import type { RecallObservation } from "./recall-observation.js";

/** Same optional log as hooks; no output bytes, query or knowledge content. */
export async function logCliRecall(observation: RecallObservation, results: readonly { reasonCode: string; outcome: string }[]): Promise<void> {
  try {
    const directory = join(deviceHome(), "log");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const result of results) {
      await appendFile(join(directory, "hook.ndjson"), `${JSON.stringify({ schemaVersion: "einzbern.hook-log.v1", at: new Date().toISOString(), host: "cli", event: "recall", engineVersion: FRAMEWORK_VERSION, projectionVersion: CACHE_VIEWS_SCHEMA_VERSION, observation, ...result })}\n`, { mode: 0o600 });
    }
  } catch {
    // Observability never changes the CLI output, exception or exit status.
  }
}
