// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-533: the Design System source this repository reconciles against is the
// one portal/ds-consumer-contract.json binds — its candidate commit — read from that commit's
// git objects. The sibling checkout's working tree is never opened. An edit another session
// has not published yet is a fact about that checkout, not about this repository or the
// candidate it is bound to, and while the verdict moved with it the sibling's working tree
// was this gate's baseline: the portal gate went red with this repository's bytes unchanged.
//
// Whatever cannot be read comes back as an unavailable status with a reason. A git failure
// never throws, no query leaves the machine, and nothing here writes to the Design System
// repository.

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

/** Where the export lives inside the Design System tree. */
export const CANDIDATE_SOURCE_PATH = "packages/ui-react/src/components/Navigation/Navigation.tsx";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const unavailable = (reason, candidate = null) => ({ status: "unavailable", reason, text: null, candidate });

/** The contract's binding, or null when the file is unreadable or binds no well-formed commit and tree. */
async function readBinding(contractPath) {
  let contract;
  try {
    contract = JSON.parse(await readFile(contractPath, "utf8"));
  } catch {
    return null;
  }
  const { candidate, candidateTree } = contract ?? {};
  const wellFormed = (value) => typeof value === "string" && OBJECT_ID.test(value);
  return wellFormed(candidate) && wellFormed(candidateTree) ? { candidate, candidateTree } : null;
}

/**
 * One read-only git query against the Design System repository; its stdout, or null on any
 * failure. The caller's own git environment is dropped: a hook exports GIT_DIR for the
 * repository it runs in, and inheriting it would aim this query at that repository.
 * Discovery may not climb above the given root, so a directory that is not itself a
 * repository cannot borrow an enclosing one. Transports are refused and lazy object
 * retrieval is off, so a partial clone missing the blob reads as unavailable instead of
 * reaching the network. git's diagnostics are captured rather than inherited, so a probe
 * that finds nothing prints nothing.
 */
function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["-c", "protocol.allow=never", "-c", "color.ui=never", "-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...env,
      GIT_CEILING_DIRECTORIES: dirname(root),
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return result.error || result.status !== 0 ? null : result.stdout;
}

/**
 * Read the Design System source the consumer contract binds.
 *
 * An explicit `sourceFile` (TCRN_DS_COMPONENT_CSS_SOURCE — for tests and by hand) wins and
 * is read as it is; only its absence is reported (`source-absent`), any other read error
 * propagates. Otherwise `designSystemRoot` must itself be a git repository
 * (`not-a-repository`) holding the contract's candidate commit (`candidate-absent`, also
 * when the contract binds no readable candidate), whose tree is the contract's
 * candidateTree (`tree-mismatch`); the source is that commit's blob at
 * CANDIDATE_SOURCE_PATH (`export-not-found` when the bound tree has no such file).
 *
 * @param {{ contractPath?: string, designSystemRoot?: string, sourceFile?: string | null }} [options]
 * @returns {Promise<{ status: "available" | "unavailable", reason: string | null, text: string | null, candidate: string | null }>}
 */
export async function readCandidateSource({
  contractPath,
  designSystemRoot,
  sourceFile = process.env.TCRN_DS_COMPONENT_CSS_SOURCE || null,
} = {}) {
  if (sourceFile) {
    try {
      return { status: "available", reason: null, text: await readFile(sourceFile, "utf8"), candidate: null };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return unavailable("source-absent");
    }
  }

  const binding = contractPath ? await readBinding(contractPath) : null;
  const candidate = binding?.candidate ?? null;
  if (!designSystemRoot) return unavailable("not-a-repository", candidate);
  let root;
  try {
    root = realpathSync.native(resolve(designSystemRoot));
  } catch {
    return unavailable("not-a-repository", candidate);
  }
  if (git(root, ["rev-parse", "--git-dir"]) === null) return unavailable("not-a-repository", candidate);
  if (binding === null) return unavailable("candidate-absent");
  if (git(root, ["cat-file", "-e", `${binding.candidate}^{commit}`]) === null) return unavailable("candidate-absent", candidate);
  const tree = git(root, ["rev-parse", "--verify", "--quiet", `${binding.candidate}^{tree}`]);
  if (tree === null) return unavailable("candidate-absent", candidate);
  if (tree.trim() !== binding.candidateTree) return unavailable("tree-mismatch", candidate);
  const text = git(root, ["show", "--no-textconv", `${binding.candidate}:${CANDIDATE_SOURCE_PATH}`]);
  if (text === null) return unavailable("export-not-found", candidate);
  return { status: "available", reason: null, text, candidate };
}
