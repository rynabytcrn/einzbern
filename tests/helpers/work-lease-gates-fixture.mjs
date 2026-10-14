// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-536 (MIN-257 D6): the library the lease-before-gates tests share, driven through
// the CLI. A Git project with one commit and, beside it, a library whose one project holds
// INIT > EPIC > STORY, and a SIBLING Story under the Epic, both Stories active. The library declares
// one required gate that covers every path and runs green, records no run yet, and is registered for
// the project; actor A holds a lease on STORY.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../dist/build/packages/cli/src/index.js";
import { materializeWorkspace } from "../../dist/build/packages/core/src/index.js";
import { gateRunsDirectory } from "../../dist/build/packages/core/src/gates-run.js";
import { deriveStableId } from "../../dist/build/packages/protocol/src/index.js";
import { A } from "./work-lease-fixture.mjs";
import { ATELIER_SURFACE, withSurface } from "./workspace-fixture.mjs";

const T0 = Date.UTC(2026, 9, 14, 9, 0, 0);

/** Run the CLI in this process and answer its receipt. */
export async function run(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

/** The error the CLI refuses `argv` with; a write that goes through fails the test. */
export async function refusal(argv) {
  try {
    await run(argv);
  } catch (error) {
    return error;
  }
  throw new Error(`${argv.join(" ")} was expected to be refused`);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, "-c", "user.name=lease-gates-test", "-c", "user.email=lease-gates-test-at-example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The library above, under a scratch directory removed after the test, with its own HOME and device
 * directory for the test's duration. `at()` answers the next instant, one second after the last.
 */
export async function leaseGatesLibrary(context, key) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-lease-gates-")));
  const previousHome = process.env.HOME;
  const previousDeviceHome = process.env.EINZBERN_HOME;
  process.env.HOME = join(base, "home");
  process.env.EINZBERN_HOME = join(base, "desk");
  await mkdir(process.env.HOME);
  context.after(async () => {
    restoreEnv("HOME", previousHome);
    restoreEnv("EINZBERN_HOME", previousDeviceHome);
    await rm(base, { recursive: true, force: true });
  });
  let second = 0;
  const at = () => {
    second += 1;
    return new Date(T0 + second * 1000).toISOString().replace(".000Z", "Z");
  };

  const project = join(base, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "a.ts"), "export const a = 1;\n");
  git(project, ["init", "-q"]);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "initial"]);
  const baseCommit = git(project, ["rev-parse", "HEAD"]).trim();

  const library = join(base, ".ether");
  await run(["init", "--workspace", library, "--at", at()]);
  const projectId = (await run(["project-create", "--workspace", library, "--at", at(), "--external-key", `${key}-P`, "--name", key])).record.id;
  const keys = { initiative: `${key}-INIT`, epic: `${key}-EPIC`, story: `${key}-STORY`, sibling: `${key}-SIBLING` };
  const ids = Object.fromEntries(Object.entries(keys).map(([name, externalKey]) => [name, deriveStableId("work", externalKey)]));
  const create = (externalKey, kind, parentId, extra = []) => run([
    "work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", externalKey, "--kind", kind,
    ...(parentId === null ? [] : ["--parent-id", parentId]), "--title", externalKey, ...extra,
  ]);
  await create(keys.initiative, "Initiative", null);
  await create(keys.epic, "Epic", ids.initiative, ["--status", "active"]);
  const story = ["--status", "active", "--goal", "Pass the gates", "--acceptance", "GIVEN the gates WHEN green THEN done"];
  await create(keys.story, "Story", ids.epic, story);
  await create(keys.sibling, "Story", ids.epic, story);

  // Gates are declared in Atelier (TCRN-CROSS-STORY-513).
  await withSurface(ATELIER_SURFACE, () => run([
    "gates-config-set", "--workspace", library, "--project-id", projectId, "--at", at(), "--name", "all",
    "--command", JSON.stringify([process.execPath, "-e", "process.exit(0)"]), "--covers", "**",
  ]));
  await run(["library-register", "--project", project, "--library", library, "--at", at(), "--project-id", projectId]);
  const claimed = await run(["work-claim", "--workspace", library, "--at", at(), "--id", ids.story, "--actor", A]);
  const libraryId = (await materializeWorkspace(library)).metadata.workspaceId;
  return { base, project, library, projectId, libraryId, baseCommit, keys, ids, at, lease: claimed.lease };
}

/** The library's version, read through the core. */
export async function libraryVersion(library) {
  return (await materializeWorkspace(library)).version;
}

/** How many entries this device's gate-runs directory of the library holds; none when it is absent. */
export function gateRunEntries(libraryId) {
  const directory = gateRunsDirectory(libraryId);
  return existsSync(directory) ? readdirSync(directory, { recursive: true }).length : 0;
}

/** A gates-run bound to `workIds`, against the project's first commit. */
export function gatesRun(f, workIds) {
  return run(["gates-run", "--workspace", f.library, "--at", f.at(), "--project", f.project, "--base", f.baseCommit, "--work-id", workIds.join(","), "--project-id", f.projectId]);
}
