// SPDX-License-Identifier: Apache-2.0
import { mkdir, readdir, writeFile, lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundRegularFile } from "../lib/safe-io.mjs";
import { canonical, digest } from "./impact-plan.mjs";
export function transportIdentity(plan) {
  const identity = { head: plan.head, runId: plan.runId, attempt: plan.attempt, planDigest: plan.planDigest };
  if (!/^[a-f0-9]{40}$/u.test(identity.head) || !/^[a-f0-9]{64}$/u.test(identity.planDigest) || !/^\d+$/u.test(identity.runId) || !/^\d+$/u.test(identity.attempt)) throw new Error("Invalid transport identity");
  return identity;
}
export function payloadFor(identity) { return Buffer.concat([Buffer.from("Einzbern CI transport v1\n" + canonical(identity) + "\n"), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]); }
async function read(path) { return (await readBoundRegularFile(path, { reasonCode: "CI_TRANSPORT_FILE_INVALID" })).content; }
export async function createTransport(directory, plan) {
  const identity = transportIdentity(plan);
  await mkdir(directory);
  const payload = payloadFor(identity);
  const manifest = { schemaVersion: "einzbern.ci-transport.v1", ...identity, payload: { file: "payload.bin", bytes: payload.length, sha256: digest(payload) } };
  await writeFile(resolve(directory, "payload.bin"), payload, { flag: "wx" });
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
}
export async function verifyTransport(directory, plan) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== resolve(directory)) throw new Error("Transport directory boundary mismatch");
  if (canonical((await readdir(directory)).sort()) !== canonical(["manifest.json", "payload.bin"])) throw new Error("Transport file set mismatch");
  const identity = transportIdentity(plan);
  const payload = await read(resolve(directory, "payload.bin"));
  const manifest = JSON.parse(await read(resolve(directory, "manifest.json")));
  const expected = { schemaVersion: "einzbern.ci-transport.v1", ...identity, payload: { file: "payload.bin", bytes: payload.length, sha256: digest(payload) } };
  if (!payload.equals(payloadFor(identity)) || canonical(manifest) !== canonical(expected)) throw new Error("Transport bytes/identity mismatch");
  return { ok: true, scope: "downloaded-bytes; action execution established by same-run job provenance", ...identity };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, directory, path] = process.argv.slice(2);
  const plan = JSON.parse(await read(path));
  if (mode === "create") await createTransport(directory, plan);
  else if (mode === "verify") process.stdout.write(JSON.stringify(await verifyTransport(directory, plan)) + "\n");
  else throw new Error("Expected create or verify");
}
