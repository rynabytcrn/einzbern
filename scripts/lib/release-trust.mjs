// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-467 R2 (TCRN-CROSS-MIN-227 D3): release verification is the install-tree
// digest and nothing else. The Ed25519 manifest signature, the external trust root, the
// in-toto build statement, the transaction log and the test-root restriction this module
// used to enforce are retired; the digest itself lives in core
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
