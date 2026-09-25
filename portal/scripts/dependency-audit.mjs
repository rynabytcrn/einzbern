// SPDX-License-Identifier: Apache-2.0
//
// The portal's standing proof that it consumes only the public Einzbern
// boundary. It scans every source file in the repository rather than a named
// list of directories: a gate that only reads two folders stops protecting the
// moment someone adds a third.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { BRAND, LOCAL_DIRECTORY_NAMES } from "../../scripts/lib/names.mjs";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const skippedDirectories = new Set([".git", "node_modules", "dist"]);
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".html"]);
const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gu;
// Engine internals are package paths. The CLI entry point is deliberately not
// matched: shelling out to `scripts/einzbern.mjs` is the sanctioned route.
// The engine is reached as <engine folder>/packages whether its checkout keeps the local
// folder name or carries the product id.
const engineFolders = [LOCAL_DIRECTORY_NAMES.engine.split("/").at(-1), BRAND.engine.id].join("|");
const forbiddenPattern = new RegExp(`(?:^|[\\\\/])(?:(?:${engineFolders})[\\\\/]packages|packages[\\\\/](?:core|cli|protocol|mcp|pg-backend))(?:[\\\\/]|$)`, "u");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (skippedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (sourceExtensions.has(path.slice(path.lastIndexOf(".")))) files.push(path);
  }
  return files;
}

const findings = [];
const scanned = [];
for (const file of await sourceFiles(portalRoot)) {
  const text = await readFile(file, "utf8");
  scanned.push(relative(portalRoot, file));
  for (const match of text.matchAll(importPattern)) {
    if (forbiddenPattern.test(match[1])) {
      findings.push({ file: relative(portalRoot, file), specifier: match[1] });
    }
  }
}

process.stdout.write(`${JSON.stringify({
  ok: findings.length === 0,
  reasonCode: findings.length === 0 ? "NO_INTERNAL_IMPORTS" : "INTERNAL_IMPORT_FOUND",
  scope: "whole repository",
  scanned: scanned.sort(),
  findings,
}, null, 2)}\n`);
if (findings.length > 0) process.exitCode = 1;
