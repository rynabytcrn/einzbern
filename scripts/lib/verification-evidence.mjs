// SPDX-License-Identifier: Apache-2.0
// Timing and raw streams are artifacts, never additional stdout/stderr chatter.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function createPortalEvidence(root) {
  const explicit = process.env.EINZBERN_PORTAL_EVIDENCE_DIR;
  let directory;
  if (explicit) {
    directory = resolve(explicit);
    await mkdir(directory); // A previous run is never overwritten or reused.
  } else {
    const parent = join(root, "dist", "verification");
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(join(parent, "portal-"));
  }
  await mkdir(join(directory, "timings"));
  return directory;
}

export async function retainVerificationStep(directory, step, result) {
  await Promise.all([
    writeFile(join(directory, `${step.id}.stdout`), result.stdout ?? "", { flag: "wx" }),
    writeFile(join(directory, `${step.id}.stderr`), result.stderr ?? "", { flag: "wx" }),
    writeFile(join(directory, `${step.id}.json`), `${JSON.stringify(step, null, 2)}\n`, { flag: "wx" }),
  ]);
}

export async function recordVerificationTiming(event, started, env = process.env) {
  const row = { ...event, durationMs: Math.round(performance.now() - started) };
  if (env.EINZBERN_VERIFY_TIMINGS_DIR) {
    const name = `${process.pid}-${process.hrtime.bigint()}.json`;
    await writeFile(join(env.EINZBERN_VERIFY_TIMINGS_DIR, name), `${JSON.stringify(row)}\n`, { flag: "wx" });
  }
  return row;
}
