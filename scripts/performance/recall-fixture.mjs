// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { initializeLibrary, createProject, createWork, initializeKnowledgeStore, captureKnowledgeUnit } from "../../dist/build/packages/core/src/index.js";
import { registerLibrary } from "../../dist/build/packages/core/src/registry.js";
const root = resolve(process.argv[2]);
const at = "2026-11-10T12:00:00Z";
await initializeLibrary({ root, createdAt: at });
const state = await createProject(root, { occurredAt: at, externalKey: "PERF-PROJECT", name: "Performance fixture" });
const projectId = state.projects[0].id;
const initiative = await createWork(root, { occurredAt: at, projectId, externalKey: "PERF-INIT", kind: "Initiative", parentId: null, title: "Recall performance", goal: "Compare validated reads", scope: "## Goal\nCompare Recall performance.\n\n## Requirements\nPreserve integrity." });
const initId = initiative.work.find(w => w.externalKey === "PERF-INIT").id;
const epic = await createWork(root, { occurredAt: at, projectId, externalKey: "PERF-EPIC", kind: "Epic", parentId: initId, title: "Recall performance", goal: "Compare request state reuse" });
const epicId = epic.work.find(w => w.externalKey === "PERF-EPIC").id;
for (let n = 0; n < 20; n += 1) await createWork(root, { occurredAt: at, projectId, externalKey: `PERF-STORY-${n}`, kind: "Story", parentId: epicId, title: `Recall performance ${n}`, goal: "Preserve semantics", acceptance: "Given identical input, results agree", body: "Performance validation fixture. ".repeat(100) });
const knowledge = process.argv[3] === "knowledge";
if (knowledge) {
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  for (const [index, subject] of ["Copper alloy calibration", "Obsidian beacon alignment"].entries()) {
    await captureKnowledgeUnit(root, {
      occurredAt: at, externalKey: `PERF-CARD-${index}`, scope: index === 0 ? "workspace" : "project",
      ...(index === 0 ? {} : { projectId }),
      subject, summary: `Measured ${subject.toLowerCase()}`, snippet: `Check ${subject.toLowerCase()}`,
      tags: ["calibration"], body: `The synthetic ${subject.toLowerCase()} measured seventeen units.`,
      accountableOwnerId: "owner:000000000000000000000001",
    });
  }
}
if (process.argv[4] !== undefined) await registerLibrary({ projectPath: resolve(process.argv[4]), libraryPath: root, registeredAt: at });
console.log(JSON.stringify({ root, projectId, records: 22, knowledgeCards: knowledge ? 2 : 0 }));
