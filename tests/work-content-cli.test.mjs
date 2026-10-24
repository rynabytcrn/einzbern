// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import { runtimeInputContract } from "../dist/build/packages/core/src/runtime-input-contract.js";
import { admitTemplateInWorkspace, defaultWorkContentTemplate } from "../dist/build/packages/core/src/index.js";
import { cli, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";

test("INIT068 CLI typed drafts cover four kinds and defect without invented completion", async t => {
  const f = await workspaceFixture(t, { externalKey: "CONTENT-DRAFT" });
  for (const [kind, variant] of [["Initiative", "standard"], ["Epic", "standard"], ["Story", "standard"], ["Subtask", "standard"], ["Story", "defect"]]) {
    const draft = await cli(["work-draft", "--workspace", f.workspace, "--project-id", f.projectId, "--kind", kind, "--variant", variant]);
    assert.equal(draft.content.kind, kind); assert.equal(draft.content.variant, variant);
    assert.equal(draft.content.completion, undefined); assert.ok(draft.missing.includes("goal"));
    assert.equal(draft.inheritedContext, null);
    if (variant === "defect") assert.ok(Object.hasOwn(draft.content.details, "reproduction"));
  }
  await assert.rejects(cli(["work-draft", "--workspace", f.workspace, "--project-id", f.projectId, "--kind", "Epic", "--variant", "defect"]));
});
test("INIT068 CLI canonical draft/create/show/context share one content and reject mixed snapshots", async t => {
  const f = await workspaceFixture(t, { externalKey: "CONTENT-SHOW" });
  const common = ["--workspace", f.workspace];
  const draft = await cli(["work-draft", ...common, "--project-id", f.projectId, "--kind", "Initiative"]);
  const content = { ...draft.content, goal: "完整中文🧭", body: "完整来源正文" };
  const admitted = await admitTemplateInWorkspace(f.workspace, { template: defaultWorkContentTemplate("Initiative"), ownerId: "owner:fixture", occurredAt: instant(2) });
  const templateReceipt = admitted.templates.find(entry => entry.template.id === "minimum-initiative").receipt;
  const created = await cli(["work-create", ...common, "--at", instant(2), "--project-id", f.projectId, "--external-key", "CONTENT-SHOW-INIT", "--kind", "Initiative", "--title", "Typed initiative", "--content", JSON.stringify(content), "--template-receipt", JSON.stringify(templateReceipt)]);
  const id = created.record.id;
  const shown = await cli(["work-show", ...common, "--id", id]);
  assert.deepEqual(shown.content, content);
  assert.deepEqual(shown.projectContexts.workContent, shown.workContent);
  assert.deepEqual(shown.workContent.records[0].content, content);
  const segment = await cli(["work-content-context", ...common, "--id", id, "--limit", "32"]);
  assert.equal(segment.complete, false); assert.ok(segment.nextOffset);
  const full = await cli(["work-content-context", ...common, "--id", id]);
  assert.deepEqual(JSON.parse(full.text), shown.workContent);
  const childDraft = await cli(["work-draft", ...common, "--project-id", f.projectId, "--kind", "Epic", "--parent-id", id]);
  assert.deepEqual(childDraft.inheritedContext, shown.workContent);
  await cli(["work-annotate", ...common, "--at", instant(3), "--id", id, "--content", JSON.stringify({ ...content, body: "新版本" })]);
  await assert.rejects(cli(["work-content-context", ...common, "--id", id, "--offset", "32", "--limit", "32", "--digest", segment.digest]), e => e.reasonCode === "WORK_CONTENT_CONTEXT_CHANGED");
  await assert.rejects(cli(["work-annotate", ...common, "--at", instant(4), "--id", id, "--content", JSON.stringify(content), "--goal", "duplicate"]));
});

test("INIT068 content flag contracts are sourced from the actual command catalog", () => {
  const catalog = runtimeInputContract(COMMAND_CATALOG).commandCatalog;
  for (const name of ["work-create", "work-annotate"]) {
    const content = catalog.find(command => command.name === name).flags.find(flag => flag.name === "content");
    assert.equal(content.valueKind, "json"); assert.match(content.valueShape, /tcrn\.work-content\.v1/u);
  }
  const segments = catalog.find(command => command.name === "work-content-context");
  assert.deepEqual(segments.flags.map(flag => flag.name), ["workspace", "id", "offset", "limit", "digest"]);
  assert.match(segments.flags.find(flag => flag.name === "offset").valueShape, /Unicode.*requires digest/u);
  assert.match(segments.flags.find(flag => flag.name === "digest").valueShape, /ancestor\/source versions/u);
  const draft = catalog.find(command => command.name === "work-draft");
  assert.match(draft.flags.find(flag => flag.name === "variant").valueShape, /defect.*Story only/u);
});

test("INIT068 actual annotation and subsequent show expose the same revision-bound affected requirements, evidence and descendants", async t => {
  const f = await workspaceFixture(t, { externalKey: "CONTENT-IMPACT" });
  const common = ["--workspace", f.workspace];
  const draft = await cli(["work-draft", ...common, "--project-id", f.projectId, "--kind", "Initiative"]);
  const admitted = await admitTemplateInWorkspace(f.workspace, { template: defaultWorkContentTemplate("Initiative"), ownerId: "owner:fixture", occurredAt: instant(2) });
  const receipt = admitted.templates.find(entry => entry.template.id === "minimum-initiative").receipt;
  const created = await cli(["work-create", ...common, "--at", instant(3), "--project-id", f.projectId, "--external-key", "CONTENT-IMPACT-INIT", "--kind", "Initiative", "--title", "Impact", "--content", JSON.stringify(draft.content), "--template-receipt", JSON.stringify(receipt)]);
  const id = created.record.id;
  const child = await cli(["work-create", ...common, "--at", instant(4), "--project-id", f.projectId, "--external-key", "CONTENT-IMPACT-EPIC", "--kind", "Epic", "--parent-id", id, "--title", "Affected descendant"]);
  const reference = { workId: id, requirementId: "R1", version: 1 };
  const content = { ...draft.content, goal: "Preserve", scope: "Directory A", sources: [{ id: "request", kind: "user-request", locator: "fixture:request", version: "1", extraction: "complete", text: "Preserve bytes" }],
    requirements: [{ id: "R1", version: 1, text: "Preserve bytes", sourceIds: ["request"], shared: true, disposition: "required" }],
    acceptance: [{ id: "A1", version: 1, requirement: reference, scenario: "cleanup", expected: "bytes retained", method: "compare" }],
    evidence: [{ acceptanceId: "A1", acceptanceVersion: 1, requirement: reference, codeVersion: "fixture-candidate", locator: "fixture:evidence", actual: "bytes retained", outcome: "satisfied", kind: "machine" }] };
  await cli(["work-annotate", ...common, "--at", instant(5), "--id", id, "--content", JSON.stringify(content)]);
  const before = await cli(["work-show", ...common, "--id", id]);
  const next = { ...before.content, scope: "Directory B", requirements: [{ ...content.requirements[0], version: 2 }], acceptance: [{ ...content.acceptance[0], version: 2, requirement: { ...reference, version: 2 } }] };
  const changed = await cli(["work-annotate", ...common, "--at", instant(6), "--id", id, "--expected-revision", String(before.record.revision), "--content", JSON.stringify(next)]);
  const shown = await cli(["work-show", ...common, "--id", id]);
  assert.deepEqual(changed.contentImpact, shown.contentImpact);
  assert.deepEqual(shown.workContent.records[0].contentImpact, shown.contentImpact);
  assert.equal(shown.contentImpact.previousRevision, before.record.revision);
  assert.equal(shown.contentImpact.currentRevision, shown.record.revision);
  assert.ok(shown.contentImpact.impact.changedRequirements.includes("R1"));
  assert.ok(shown.contentImpact.impact.affectedWorkIds.includes(child.record.id));
  assert.ok(shown.contentImpact.impact.affectedEvidence.some(e => e.locator === "fixture:evidence"));
  assert.notEqual(shown.workContent.records[0].acceptanceMeaningDigests.A1, before.workContent.records[0].acceptanceMeaningDigests.A1);
});

test("Readiness preview is read-only and distinct from persisted policy, with actual capable V still pending", async t => {
  const f = await workspaceFixture(t, { externalKey: "CONTENT-READINESS" });
  const common = ["--workspace", f.workspace];
  const before = await cli(["status", ...common]);
  const observation = { schemaVersion: "tcrn.work-content-rollout-observation.v1", observedAt: instant(2),
    capableRelease: { version: null, buildDigest: null, evidence: null, delivery: "pending" }, knownIncapableVersions: ["3.2.0"],
    inventory: { complete: false, evidence: "fixture:inventory-incomplete", unresolvedPaths: ["fixture:unobserved-writer"] }, writers: [],
    barrier: { settingVersion: "3.2.0", oldWriterRefusalEvidence: "", effectiveStateEvidence: "", manifestEvidence: "" },
    boundary: { headEventHash: null, versionVector: {} } };
  const catalog = await cli(["settings-catalog", ...common, "--project-id", f.projectId, "--work-content-observation", JSON.stringify(observation)]);
  assert.equal(catalog.contentRollout.persisted.policy, null);
  assert.equal(catalog.contentRollout.persisted.observation, null);
  assert.equal(catalog.contentRollout.preview.persisted, false);
  assert.deepEqual(catalog.contentRollout.preview.observation, observation);
  assert.equal(catalog.contentRollout.preview.readiness.ready, false);
  assert.equal(catalog.contentRollout.preview.readiness.capableVersion, null);
  assert.ok(catalog.contentRollout.preview.readiness.problems.includes("CAPABLE_DELIVERY_UNVERIFIED"));
  assert.equal(catalog.contentRollout.preview.readiness.authentication, "not-provided");
  const { FRAMEWORK_VERSION } = await import("../dist/build/packages/core/src/index.js");
  assert.equal(catalog.contentRollout.preview.readiness.engineVersion, FRAMEWORK_VERSION);
  const after = await cli(["status", ...common]);
  assert.equal(after.version, before.version); assert.equal(after.headEventHash, before.headEventHash);
  const plain = await cli(["settings-catalog", ...common, "--project-id", f.projectId]);
  assert.equal(plain.contentRollout.preview, null); assert.equal(plain.contentRollout.persisted.policy, null);
  const draft = await cli(["work-draft", ...common, "--project-id", f.projectId, "--kind", "Initiative"]);
  assert.equal(draft.contentRolloutReadiness.ready, false);
  assert.ok(draft.contentRolloutReadiness.problems.includes("ROLLOUT_OBSERVATION_MISSING_OR_INVALID"));
});
