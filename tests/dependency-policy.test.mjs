// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The vulnerability snapshot check and its freshness window were the governance leg's, and
// retire with it (TCRN-CROSS-STORY-467 R2); the frozen graph read by the SBOM stays.
import { DependencyGraphError, validateFrozenDependencyGraph } from "../scripts/lib/dependency-graph.mjs";

async function dependencyInputs() {
  const [packageJson, dependencyPolicy, lockContent] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../scripts/policy/dependency-policy.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"),
  ]);
  return { packageJson, dependencyPolicy, lockContent };
}

test("the exact frozen dependency graph has complete policy and integrity closure", async () => {
  const graph = validateFrozenDependencyGraph(await dependencyInputs());
  assert.equal(graph.records.length, 25);
  assert.deepEqual(graph.directIdentities, [
    "@types/node@24.13.2",
    "ajv@8.20.0",
    "linkedom@0.18.12",
    "typescript@5.9.3",
  ]);
  assert.deepEqual(graph.transitiveIdentities, [
    "boolbase@1.0.0",
    "css-select@5.1.0",
    "css-what@6.1.0",
    "cssom@0.5.0",
    "dom-serializer@2.0.0",
    "domelementtype@2.3.0",
    "domhandler@5.0.2",
    "domhandler@5.0.3",
    "domutils@3.0.1",
    "domutils@3.2.2",
    "entities@4.2.0",
    "entities@7.0.1",
    "fast-deep-equal@3.1.3",
    "fast-uri@3.1.8",
    "html-escaper@3.0.3",
    "htmlparser2@10.1.0",
    "json-schema-traverse@1.0.0",
    "nth-check@2.0.1",
    "require-from-string@2.0.2",
    "uhyphen@0.2.0",
    "undici-types@7.18.2",
  ]);
});

test("unapproved lock packages and integrity drift fail closed", async () => {
  const inputs = await dependencyInputs();
  const missingPolicy = structuredClone(inputs.dependencyPolicy);
  delete missingPolicy.dependencies["fast-uri@3.1.8"];
  assert.throws(
    () => validateFrozenDependencyGraph({ ...inputs, dependencyPolicy: missingPolicy }),
    (error) => error instanceof DependencyGraphError && error.reasonCode === "DEPENDENCY_GRAPH_POLICY_MISMATCH",
  );
  const wrongIntegrity = structuredClone(inputs.dependencyPolicy);
  wrongIntegrity.dependencies["fast-uri@3.1.8"].integrity = "sha512-invalid";
  assert.throws(
    () => validateFrozenDependencyGraph({ ...inputs, dependencyPolicy: wrongIntegrity }),
    (error) => error instanceof DependencyGraphError && error.reasonCode === "DEPENDENCY_GRAPH_INTEGRITY_MISMATCH",
  );
  const importerDrift = inputs.lockContent.replace("specifier: 8.20.0", "specifier: 8.19.0");
  assert.throws(
    () => validateFrozenDependencyGraph({ ...inputs, lockContent: importerDrift }),
    (error) => error instanceof DependencyGraphError && error.reasonCode === "DEPENDENCY_LOCK_IMPORTER_NOT_EXACT",
  );
});

test("a scoped lock identity parses through its surrounding pnpm quotes", async () => {
  const inputs = await dependencyInputs();
  // pnpm quotes every lock key beginning with "@". Before the identity match stripped
  // those quotes the version pattern saw a trailing quote and the whole graph failed to
  // parse, so no scoped dependency could be admitted at all.
  assert.match(inputs.lockContent, /^ {2}'@types\/node@24\.13\.2':$/mu);
  const graph = validateFrozenDependencyGraph(inputs);
  assert.ok(graph.directIdentities.includes("@types/node@24.13.2"));
  const scoped = graph.records.find((record) => record.identity === "@types/node@24.13.2");
  assert.equal(scoped.name, "@types/node");
  assert.equal(scoped.version, "24.13.2");
});
