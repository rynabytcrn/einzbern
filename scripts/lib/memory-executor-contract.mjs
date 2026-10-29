// SPDX-License-Identifier: Apache-2.0
// Build-time producer. Runtime adapters consume data, never import the executor source closure.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const EXECUTOR_FILES = Object.freeze([
  "package.json", "scripts/task.mjs", "scripts/verify-portal.mjs", "scripts/portal-tests.mjs", "scripts/release.mjs",
  "scripts/lib/memory-budget.mjs", "scripts/lib/memory-worker-check.mjs", "scripts/lib/heavy-runs.mjs", "scripts/lib/storage-location.mjs",
  "scripts/test-controller-bootstrap.mjs", "scripts/test-controller-child-policy.mjs",
]);
const EXECUTOR_SCHEMA = "einzbern.memory-executors.v1";
const executorDigest = bytes => createHash("sha256").update(bytes).digest("hex");
/** Packaging producer: immutable identities for the instrumented source executor closure. */
export function createMemoryExecutorContract(root) {
  const files = Object.fromEntries(EXECUTOR_FILES.map(path => [path, executorDigest(readFileSync(join(root, path)))]));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // A build can serve a policy-disabled fixture. Unsupported package identities stay
  // unadmittable at runtime, without making ordinary builds depend on policy opt-in.
  return { schemaVersion: EXECUTOR_SCHEMA, packageManager: pkg.packageManager ?? null, files };
}
