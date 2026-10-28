// SPDX-License-Identifier: Apache-2.0
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

function packageInputFail(reasonCode, message, details = {}) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  error.details = details;
  throw error;
}

// Only public CLI contracts consumed by the installed helper, not the whole source specs tree.
export const SPECIFICATIONS = Object.freeze([
  "dispatch-admission-evidence-v1.md", "dot-execution-v1.md", "native-tool-evidence-v1.md", "host-fallback-v1.md", "engine-model-policy-v1.md",
  "shared-submit-v1.md", "config-backup-v1.md", "dot-rules-v1.md", "context-v1.md", "work-content-v1.md", "engine-hook-events-v2.md",
]);

// Public helper contracts that retain their documented source-relative paths.
export const CONTRACT_DOCUMENTS = Object.freeze(["docs/codex-native-controller.md"]);

async function treeFiles(root, relativePath = "") {
  const directory = relativePath === "" ? root : join(root, ...relativePath.split("/"));
  const files = [];
  for (const name of await readdir(directory)) {
    const path = relativePath === "" ? name : `${relativePath}/${name}`;
    const stats = await lstat(join(directory, name));
    if (stats.isDirectory()) files.push(...await treeFiles(root, path));
    else if (stats.isFile()) files.push(path);
    else packageInputFail("PACK_TREE_INVALID", `${path} in the staged release is not a regular file`, { path });
  }
  return files;
}

// Validate the consumer's references independently of SPECIFICATIONS. A valid manifest
// can hash an incomplete tree; an installed Skill must also resolve its named contracts.
export async function verifySkillSpecifications(tree, skillRoot) {
  const files = new Set(await treeFiles(tree));
  for (const source of files) {
    if (!source.startsWith(`${skillRoot}/`) || !source.endsWith(".md")) continue;
    const markdown = await readFile(join(tree, ...source.split("/")), "utf8");
    for (const [reference] of markdown.matchAll(/\b(?:specs|docs)\/[A-Za-z0-9._/-]+\.md\b/gu)) {
      if (reference.split("/").some((part) => part === "" || part === "." || part === "..")) {
        packageInputFail("PACK_SKILL_SPEC_INVALID", "a packaged Skill contract reference is not a canonical relative path", { source, reference });
      }
      if (!files.has(reference)) {
        packageInputFail("PACK_SKILL_SPEC_MISSING", "a contract referenced by the packaged Skill is missing", { source, reference });
      }
      await readFile(join(tree, ...reference.split("/")));
    }
  }
}
