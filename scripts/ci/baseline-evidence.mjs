// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
export function verifyBaseline(record, expected) {
  const refuse = (reason) => ({ eligible: false, reason });
  if (!record || record.state !== "verified") return refuse(record?.reason ?? "unavailable");
  if (record.sha !== expected.base || record.repository !== expected.repository) return refuse("identity-mismatch");
  if (!["full", "selective"].includes(record.coverage)) return refuse("unknown-coverage");
  if (record.conclusion !== "success" || record.verification !== (record.coverage === "full" ? "CI_VERIFIED" : "CI_SELECTED_VERIFIED")) return refuse("failed-or-mislabeled");
  if (!/^\d+$/u.test(String(record.runId)) || !/^\d+$/u.test(String(record.attempt)) || record.workflow !== ".github/workflows/ci.yml" || !/^[a-f0-9]{64}$/u.test(record.evidenceDigest ?? "")) return refuse("incomplete-provenance");
  return { eligible: true, reason: "exact-base-applicable-verification", coverage: record.coverage };
}
const cleanup = (path) => {
  for (const item of readdirSync(path)) { const child = join(path, item); if (lstatSync(child).isDirectory()) cleanup(child); else unlinkSync(child); }
  rmdirSync(path);
};
export async function githubBaselineRequest(repository, path, raw = false) {
  const env = process.env;
  if (env.GITHUB_ACTIONS !== "true" || env.CI !== "true" || env.EINZBERN_CI_BASELINE_ONLINE !== "read-only" || env.GITHUB_REPOSITORY !== repository || !["plan", "verify"].includes(env.GITHUB_JOB) || !env.GITHUB_WORKFLOW_REF?.startsWith(`${repository}/.github/workflows/ci.yml@`) || !["pull_request", "push"].includes(env.GITHUB_EVENT_NAME)) throw new Error("baseline-online-context-required");
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^(?:actions\/workflows\/ci\.yml\/runs\?head_sha=[a-f0-9]{40}&status=success&per_page=100|actions\/runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*\/jobs\?per_page=100|\/artifacts\?per_page=100)?|actions\/artifacts\/[1-9][0-9]*\/zip)$/u.test(path)) throw new Error("baseline-api-endpoint-refused");
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (env.GH_TOKEN) headers.Authorization = `Bearer ${env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { method: "GET", headers, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`api-${response.status}`);
  return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
}
export async function collectBaseline(input, root, pinnedRun) {
  let temporary;
  try {
    if (!input.complete || !/^[a-f0-9]{40}$/u.test(input.comparison.base ?? "")) throw new Error("invalid-comparison");
    const repository = input.repository;
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "")) throw new Error("invalid-repository");
    const api = (path, raw = false) => githubBaselineRequest(repository, path, raw);
    const rows = pinnedRun ? [await api(`actions/runs/${pinnedRun}`)] : (await api(`actions/workflows/ci.yml/runs?head_sha=${input.comparison.base}&status=success&per_page=100`)).workflow_runs;
    const run = rows?.find((row) => row.head_sha === input.comparison.base && row.path === ".github/workflows/ci.yml" && row.conclusion === "success" && row.event !== "workflow_dispatch");
    if (!run) throw new Error("no-exact-base-run");
    const jobs = await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (jobs.total_count !== jobs.jobs.length || jobs.jobs.filter((job) => job.name === "verify" && job.conclusion === "success").length !== 1) throw new Error("jobs-incomplete-or-failed");
    const artifacts = await api(`actions/runs/${run.id}/artifacts?per_page=100`);
    if (artifacts.total_count !== artifacts.artifacts.length) throw new Error("artifacts-incomplete");
    temporary = mkdtempSync(join(tmpdir(), "einzbern-ci-baseline-"));
    const receipts = [];
    for (const artifact of artifacts.artifacts) {
      if (!artifact.name.endsWith(`-${run.head_sha}-${run.run_attempt}`)) continue;
      if (artifact.expired || !/^[\w.-]+$/u.test(artifact.name)) throw new Error("expired-or-invalid-artifact");
      const bytes = await api(`actions/artifacts/${artifact.id}/zip`, true);
      receipts.push({ id: artifact.id, name: artifact.name, digest: createHash("sha256").update(bytes).digest("hex") });
      const zip = join(temporary, `${artifact.id}.zip`);
      writeFileSync(zip, bytes, { flag: "wx" });
      execFileSync("python3", ["-c", "import zipfile,sys,pathlib,stat\nz=zipfile.ZipFile(sys.argv[1]); root=pathlib.Path(sys.argv[2]); seen=set()\nfor i in z.infolist():\n p=pathlib.PurePosixPath(i.filename)\n if p.is_absolute() or '..' in p.parts or i.filename in seen or stat.S_ISLNK(i.external_attr >> 16): raise ValueError('unsafe zip')\n seen.add(i.filename)\nz.extractall(root)", zip, join(temporary, artifact.name)]);
      unlinkSync(zip);
    }
    const validated = JSON.parse(execFileSync("python3", [resolve(root, "scripts/ci/aggregate-evidence.py"), "--baseline-artifacts", temporary, "--sha", run.head_sha, "--run-id", String(run.id), "--attempt", String(run.run_attempt), "--repo", root], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
    if (!validated.ok) throw new Error("baseline-evidence-refused");
    const expectedJobs = ["plan", "verify", ...validated.shards.map((shard) => `p1 (p1-${shard})`)];
    if (jobs.jobs.length !== expectedJobs.length || expectedJobs.some((name) => jobs.jobs.filter((job) => job.name === name && job.conclusion === "success").length !== 1)) throw new Error("baseline-selected-jobs-not-successful");
    return { state: "verified", repository, sha: run.head_sha, runId: String(run.id), attempt: String(run.run_attempt), workflow: run.path, conclusion: run.conclusion, coverage: validated.coverage, verification: validated.reasonCode, evidenceDigest: createHash("sha256").update(JSON.stringify(receipts.sort((a,b) => a.name.localeCompare(b.name)))).digest("hex") };
  } catch (error) { return { state: "unavailable", reason: error.message }; }
  finally { if (temporary) cleanup(temporary); }
}
