// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("privacy normalization terminates on the cloud-roots source and unmatched slash arrays", async () => {
  const cloudRoots = await readFile(new URL("./cloud-roots.test.mjs", import.meta.url), "utf8");
  assert.equal(Buffer.byteLength(cloudRoots, "utf8"), 6433, "the unmodified scan input is the diagnosed 6,433-byte source file");

  const repeatedSlashes = "\\".repeat(28);
  const unmatchedArray = `[${JSON.stringify(repeatedSlashes)},${JSON.stringify(repeatedSlashes)}]`;
  const inputs = [cloudRoots, unmatchedArray];
  const privacyModule = new URL("../scripts/lib/privacy.mjs", import.meta.url).href;
  const probe = [
    'import { readFileSync } from "node:fs";',
    `import { normalizePrivacyText } from ${JSON.stringify(privacyModule)};`,
    'const inputs = JSON.parse(readFileSync(0, "utf8"));',
    "const normalized = inputs.map((input) => normalizePrivacyText(input));",
    'process.stdout.write(JSON.stringify({ lengths: normalized.map((value) => Buffer.byteLength(value, "utf8")), unmatchedUnchanged: normalized[1] === inputs[1] }));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
    input: JSON.stringify(inputs),
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    lengths: [Buffer.byteLength(cloudRoots, "utf8"), Buffer.byteLength(unmatchedArray, "utf8")],
    unmatchedUnchanged: true,
  });
});
