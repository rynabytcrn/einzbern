// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { P1_TASKS } from "../p1-sequence.mjs";

export const LIGHT_TESTS = Object.freeze([
  "tests/ci-artifact-transport.test.mjs",
  "tests/ci-light-contract.test.mjs",
  "tests/ci-light-evidence.test.mjs",
  "tests/ci-test-roster.test.mjs",
  "tests/cross-repo-privacy.test.mjs",
  "tests/p1-roster.test.mjs",
  "tests/protocol-proof.test.mjs",
  "tests/protocol-v1.test.mjs",
]);

const task = (id, expected, requires = []) => ({ id, argv: ["scripts/task.mjs", id], requires, kind: "receipt", expected: [expected] });
export const LIGHT_STEPS = Object.freeze([
  task("format-check", "FORMAT_VERIFIED"),
  task("links", "MARKDOWN_LINKS_RESOLVED"),
  { id: "test-wiring", argv: ["scripts/test-wiring-proof.mjs"], requires: [], kind: "receipt", expected: ["TEST_WIRING_VERIFIED"] },
  task("lint", "LINT_VERIFIED"),
  task("build", "BUILD_VERIFIED"),
  { id: "contracts", argv: ["--test", ...LIGHT_TESTS], requires: ["build"], kind: "tap" },
  { id: "portal-proof", argv: ["portal/scripts/proof.mjs"], requires: ["build"], kind: "process" },
  { id: "ds-reconcile", argv: ["scripts/ds-component-css-reconcile.mjs"], requires: [], kind: "process" },
  { id: "ds-proof", argv: ["scripts/ds-component-css-proof.mjs"], requires: [], kind: "process" },
  task("no-sibling-dependency", "NO_SIBLING_DEPENDENCY"),
  task("offline", "OFFLINE_BOUNDARY_VERIFIED"),
  task("retrieval-eval", "RETRIEVAL_EVAL_VERIFIED", ["build"]),
  task("archive", "ARCHIVE_VERIFIED"),
  task("privacy", "PRIVACY_SOURCE_CLEAN", ["archive"]),
].map(row => Object.freeze({ ...row, argv: Object.freeze(row.argv), requires: Object.freeze(row.requires), ...(row.expected ? { expected: Object.freeze(row.expected) } : {}) })));

// Every full-P1 leg is classified, not silently added to or omitted from CI.
// A subset of tests/proofs is not equivalence to the full Core/Portal legs.
export const P1_CLASSIFICATION = Object.freeze({
  "format-check": "format-check", lint: "lint", typecheck: "nested:build", build: "build",
  test: "notRunHere", portal: "notRunHere", archive: "archive",
  "no-sibling-dependency": "no-sibling-dependency", offline: "offline", privacy: "privacy",
  links: "links", "retrieval-eval": "retrieval-eval",
});
export const NOT_RUN_HERE = Object.freeze(["full-core", "full-portal", "full-impact-regressions", "PF2-H1", "P8", "release-validation"]);

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function lightRoster() {
  if (JSON.stringify(Object.keys(P1_CLASSIFICATION).sort()) !== JSON.stringify([...P1_TASKS].sort())) throw new Error("CI_LIGHT_UNCLASSIFIED_P1_TASK");
  const description = {
    schemaVersion: "einzbern.ci-light-roster.v1", profile: "ci-light", coverage: "light",
    steps: LIGHT_STEPS, p1Classification: P1_CLASSIFICATION, notRunHere: NOT_RUN_HERE,
    localValidationRequired: "full", packageSmoke: { id: "package-smoke", requires: ["build"], retainedSeparately: true },
  };
  return { ...description, rosterDigest: createHash("sha256").update(JSON.stringify(canonical(description))).digest("hex") };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(`${JSON.stringify(lightRoster())}\n`);
