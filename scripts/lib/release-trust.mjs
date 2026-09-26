// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-467 R2 (TCRN-CROSS-MIN-227 D3), TCRN-CROSS-STORY-488 R3: release
// verification is the install-tree digest and nothing else -- this module holds no key,
// performs no signing step and reads no trust archive. The digest itself lives in core
// (packages/core/src/install-tree-digest.ts) and is read here from dist/build, so the
// verifier and the engine agree on one definition.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot } from "./files.mjs";

export class ReleaseVerifyError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "ReleaseVerifyError";
    this.reasonCode = reasonCode;
  }
}

async function core() {
  return import(pathToFileURL(resolve(repositoryRoot, "dist/build/packages/core/src/index.js")).href);
}

/** Check an unpacked release tree against the digest its publisher stated. */
export async function verifyReleaseTree({ tree, sha256 }) {
  if (typeof tree !== "string" || tree.length === 0) throw new ReleaseVerifyError("RELEASE_VERIFY_ARGUMENTS_REQUIRED", "--tree is required");
  if (typeof sha256 !== "string" || sha256.length === 0) throw new ReleaseVerifyError("RELEASE_VERIFY_ARGUMENTS_REQUIRED", "--sha256 is required");
  const { InstallTreeError, verifyInstallTree } = await core();
  try {
    const result = await verifyInstallTree(resolve(tree), sha256);
    return { admitted: result.ok, ...result };
  } catch (error) {
    if (error instanceof InstallTreeError) throw new ReleaseVerifyError(error.reasonCode, error.message);
    throw error;
  }
}
