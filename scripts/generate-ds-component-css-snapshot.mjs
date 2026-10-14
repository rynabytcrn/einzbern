#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INIT-029/S252: materialise the Design System's public CSS export as a
// checked-in, runtime-local snapshot. The portal never imports the package.
// TCRN-CROSS-STORY-533: the export is taken from the candidate commit that
// portal/ds-consumer-contract.json binds, read from git objects by
// scripts/lib/ds-candidate-source.mjs, the same reader the reconciliation uses; the
// sibling checkout's working tree is not read. When the bound candidate cannot be
// read, or has no usable export, generation is refused with the reason and the
// snapshot keeps its bytes.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANDIDATE_SOURCE_PATH, readCandidateSource } from "./lib/ds-candidate-source.mjs";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DESIGN_SYSTEM_ROOT = resolve(
  process.env.TCRN_DESIGN_SYSTEM_ROOT ?? join(REPOSITORY_ROOT, "..", "TCRN-Design-System"),
);
// An explicit source file (tests, by hand) takes precedence over the bound candidate.
export const DESIGN_SYSTEM_SOURCE = process.env.TCRN_DS_COMPONENT_CSS_SOURCE
  ? resolve(process.env.TCRN_DS_COMPONENT_CSS_SOURCE)
  : null;
export const CONSUMER_CONTRACT_PATH = resolve(
  process.env.TCRN_DS_CONSUMER_CONTRACT ?? join(REPOSITORY_ROOT, "portal/ds-consumer-contract.json"),
);
// Same seam name as the reconciliation, so a test points both at one temporary file.
export const SNAPSHOT_PATH = resolve(
  process.env.TCRN_DS_COMPONENT_CSS_SNAPSHOT ?? join(REPOSITORY_ROOT, "portal/ds-component-css.snapshot.css"),
);
export const INLINE_MARKER = '<style id="tcrn-ds-component-css" data-source="snapshot">';

export function extractTcrnComponentCss(source) {
  const match = source.match(/export const tcrnComponentCss = `([\s\S]*?)`;/u);
  if (!match) throw new Error("DS_COMPONENT_CSS_EXPORT_NOT_FOUND");
  if (match[1].includes("${")) throw new Error("DS_COMPONENT_CSS_EXPORT_HAS_INTERPOLATION");
  return match[1];
}

export function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function relativePath(path) {
  return relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
}

const EXTRACTION_REASONS = new Map([
  ["DS_COMPONENT_CSS_EXPORT_NOT_FOUND", "export-not-found"],
  ["DS_COMPONENT_CSS_EXPORT_HAS_INTERPOLATION", "export-has-interpolation"],
]);

async function main() {
  const checkOnly = process.argv.includes("--check");
  const read = await readCandidateSource({
    contractPath: CONSUMER_CONTRACT_PATH,
    designSystemRoot: DESIGN_SYSTEM_ROOT,
    sourceFile: DESIGN_SYSTEM_SOURCE,
  });
  const sourceName = DESIGN_SYSTEM_SOURCE
    ? relativePath(DESIGN_SYSTEM_SOURCE)
    : `${read.candidate ?? "unbound"}:${CANDIDATE_SOURCE_PATH}`;
  let source = null;
  let reason = read.status === "available" ? null : read.reason;
  if (read.status === "available") {
    try {
      source = extractTcrnComponentCss(read.text);
    } catch (error) {
      reason = EXTRACTION_REASONS.get(error?.message) ?? null;
      if (reason === null) throw error;
    }
  }
  if (source === null) {
    // Refused before anything is opened for writing: the snapshot keeps its bytes. A
    // snapshot generated from whatever the sibling checkout holds today would bind the
    // portal to bytes no published candidate carries.
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reasonCode: "DS_COMPONENT_CSS_SOURCE_UNAVAILABLE",
      reason,
      candidate: read.candidate,
      source: sourceName,
      snapshot: relativePath(SNAPSHOT_PATH),
    })}\n`);
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    const snapshot = await readFile(SNAPSHOT_PATH, "utf8");
    const matches = snapshot === source;
    process.stdout.write(`${JSON.stringify({
      ok: matches,
      reasonCode: matches ? "DS_COMPONENT_CSS_SNAPSHOT_MATCHES_SOURCE" : "DS_COMPONENT_CSS_SNAPSHOT_DRIFTED",
      candidate: read.candidate,
      source: sourceName,
      snapshot: relativePath(SNAPSHOT_PATH),
      sourceBytes: Buffer.byteLength(source),
      snapshotBytes: Buffer.byteLength(snapshot),
      sourceSha256: digest(source),
      snapshotSha256: digest(snapshot),
    })}\n`);
    if (!matches) process.exitCode = 1;
    return;
  }

  await writeFile(SNAPSHOT_PATH, source, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reasonCode: "DS_COMPONENT_CSS_SNAPSHOT_WRITTEN",
    candidate: read.candidate,
    source: sourceName,
    snapshot: relativePath(SNAPSHOT_PATH),
    bytes: Buffer.byteLength(source),
    sha256: digest(source),
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
