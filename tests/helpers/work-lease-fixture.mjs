// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-528 (MIN-256): the library the work-lease tests share. One project holds
// INIT > EPIC > STORY > SUB and a SIBLING Story under the Epic; two actors take leases on them.

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWorkBatch, createProject, initializeLibrary } from "../../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../../dist/build/packages/protocol/src/index.js";

export const A = "agent:alpha";
export const B = "agent:bravo";

const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);

/** The instant `minutes` and `seconds` after 08:00 UTC on 2026-10-14. */
export const at = (minutes = 0, seconds = 0) => new Date(T0 + minutes * 60_000 + seconds * 1000).toISOString().replace(".000Z", "Z");

export const STORY_SCOPE = [
  "## Goal",
  "为谁:the operator. 目的锚:STORY-528. 符合性判据:one writer per Story. 判定人:machine-checked lane.",
  "", "## Requirements", "- 实现 the work lease.",
  "", "## Acceptance Criteria", "GIVEN a lease WHEN another actor writes THEN the write is refused",
  "", "## Business Background", "实测 two sessions wrote one Story.",
  "", "## Preconditions", "- None.",
  "", "## Assumptions", "- None.",
  "", "## Use Cases & Examples", "- Claim a Story before working on it.",
  "", "## Feature Toggle & Setting", "None.",
  "", "## Permissions", "None.",
  "", "## Implementation Notes", "新增 the lease collection.",
].join("\n");

/**
 * A library under a scratch directory removed after the test, with the tree above written ten to
 * eight minutes before `clock()`'s zero; its ids by name.
 */
export async function leaseLibrary(context, key, clock = at) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-work-lease-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "library");
  await initializeLibrary({ root, createdAt: clock(-10) });
  const project = await createProject(root, { occurredAt: clock(-9), externalKey: `${key}-P`, name: key });
  const projectId = project.projects[0].id;
  const keys = { initiative: `${key}-INIT`, epic: `${key}-EPIC`, story: `${key}-STORY`, sibling: `${key}-SIBLING`, subtask: `${key}-SUB` };
  await applyWorkBatch(root, {
    schemaVersion: "tcrn.work-batch.v1",
    members: [
      { verb: "work-create", projectId, externalKey: keys.initiative, kind: "Initiative", parentId: null, status: "active", title: keys.initiative },
      { verb: "work-create", projectId, externalKey: keys.epic, kind: "Epic", parentExternalKey: keys.initiative, status: "active", title: keys.epic },
      { verb: "work-create", projectId, externalKey: keys.story, kind: "Story", parentExternalKey: keys.epic, status: "planned", scope: STORY_SCOPE, title: keys.story },
      { verb: "work-create", projectId, externalKey: keys.sibling, kind: "Story", parentExternalKey: keys.epic, status: "planned", scope: STORY_SCOPE, title: keys.sibling },
      { verb: "work-create", projectId, externalKey: keys.subtask, kind: "Subtask", parentExternalKey: keys.story, status: "planned", title: keys.subtask },
    ],
  }, { occurredAt: clock(-8) });
  const ids = Object.fromEntries(Object.entries(keys).map(([name, externalKey]) => [name, deriveStableId("work", externalKey)]));
  return { base, root, projectId, keys, ids };
}

/** The lease records of a merged state. */
export const leaseRecords = (state) => state.configRecords.filter((record) => record.collection === "lease");
