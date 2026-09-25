#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// einzbern-release-verify --tree <unpacked release directory> --sha256 <install-tree digest>
//
// Admits a release tree only when its install-tree digest equals the one stated for it
// (TCRN-CROSS-STORY-467 R2). The receipt goes to stdout on success and to stderr, with a
// non-zero exit, on refusal; both carry a stable reason code.

import { ReleaseVerifyError, verifyReleaseTree } from "./lib/release-trust.mjs";

function parseArguments(values) {
  const output = {};
  const allowed = new Set(["tree", "sha256"]);
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new ReleaseVerifyError("RELEASE_VERIFY_ARGUMENTS_INVALID", "Arguments must be --name value pairs");
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) {
      throw new ReleaseVerifyError("RELEASE_VERIFY_ARGUMENT_UNKNOWN", `Unknown argument: ${name}`);
    }
    if (output[name] !== undefined) {
      throw new ReleaseVerifyError("RELEASE_VERIFY_ARGUMENTS_INVALID", `Duplicate argument: ${name}`);
    }
    output[name] = value;
  }
  return output;
}

try {
  const argumentsByName = parseArguments(process.argv.slice(2));
  const missing = ["tree", "sha256"].filter((name) => !argumentsByName[name]);
  if (missing.length > 0) {
    throw new ReleaseVerifyError("RELEASE_VERIFY_ARGUMENTS_REQUIRED", `Missing arguments: ${missing.join(",")}`);
  }
  const result = await verifyReleaseTree({ tree: argumentsByName.tree, sha256: argumentsByName.sha256 });
  if (result.admitted) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  const reasonCode = error instanceof ReleaseVerifyError ? error.reasonCode : "RELEASE_VERIFY_INTERNAL_ERROR";
  process.stderr.write(`${JSON.stringify({ admitted: false, reasonCode, message: error.message })}\n`);
  process.exitCode = 1;
}
