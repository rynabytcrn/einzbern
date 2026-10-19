// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rmdir, stat, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";

interface Identity { readonly dev: string; readonly ino: string }
interface Entry { readonly path: string; readonly kind: "directory" | "file" | "link"; readonly sha256?: string; readonly bytes?: number; readonly link?: string; readonly directoryLink?: boolean }
interface Receipt { readonly from: string; readonly to: string; readonly source: Identity; readonly target?: Identity; readonly entries: readonly Entry[]; readonly phase: "copying" | "verified" | "complete" }
export interface RuntimeTransportOptions {
  readonly forceCopyForTest?: boolean;
  readonly publicationStepForTest?: (phase: "verified" | "retiring") => void | Promise<void>;
}
const json = (value: unknown): string => canonicalJson(value as JsonValue);
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
function refuse(message: string): never { throw Object.assign(new Error(message), { reasonCode: "STORAGE_TRANSPORT_REFUSED" }); }
function validateReceipt(value: Receipt): void {
  const validIdentity = (item: Identity | undefined): boolean => item !== undefined && /^\d+$/u.test(item.dev) && /^\d+$/u.test(item.ino);
  if (!value || !isAbsolute(value.from) || !isAbsolute(value.to) || !validIdentity(value.source) || !["copying", "verified", "complete"].includes(value.phase) || !Array.isArray(value.entries)) refuse("invalid runtime transport receipt");
  const paths = new Map<string, Entry>();
  for (const entry of value.entries) {
    if (typeof entry.path !== "string" || isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.split("/").some((part: string) => ["", ".", ".."].includes(part)) || paths.has(entry.path)) refuse("invalid runtime receipt path");
    if (!["directory", "file", "link"].includes(entry.kind) || (entry.kind === "file" && (!/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "") || !Number.isSafeInteger(entry.bytes) || entry.bytes! < 0)) || (entry.kind === "link" && (typeof entry.link !== "string" || entry.link.length === 0 || entry.link.includes("\0")))) refuse("invalid runtime receipt entry");
    paths.set(entry.path, entry);
  }
  for (const entry of value.entries) {
    const parent = entry.path.slice(0, entry.path.lastIndexOf("/"));
    if (entry.path.includes("/") && paths.get(parent)?.kind !== "directory") refuse("invalid runtime receipt parent");
  }
}
async function identity(path: string): Promise<Identity> {
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink()) refuse(`not a plain runtime directory: ${path}`);
  return { dev: String(value.dev), ino: String(value.ino) };
}
async function inventory(root: string, prefix = ""): Promise<Entry[]> {
  const result: Entry[] = [];
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = prefix ? `${prefix}/${item.name}` : item.name, absolute = join(root, path);
    if (item.isDirectory()) { result.push({ path, kind: "directory" }); result.push(...await inventory(root, path)); }
    else if (item.isSymbolicLink()) result.push({ path, kind: "link", link: await readlink(absolute), directoryLink: await stat(absolute).then(value => value.isDirectory(), () => false) });
    else if (item.isFile()) { const bytes = await readFile(absolute); result.push({ path, kind: "file", bytes: bytes.length, sha256: hash(bytes) }); }
    else refuse(`unsupported runtime entry: ${path}`);
  }
  return result;
}
function content(entry: Entry): string { const { directoryLink: _directoryLink, ...value } = entry; return json(value); }
function identical(actual: readonly Entry[], expected: readonly Entry[], subset = false): boolean {
  const saved = new Map(expected.map(entry => [entry.path, content(entry)]));
  return (subset || actual.length === expected.length) && actual.every(entry => saved.get(entry.path) === content(entry));
}
export function runtimeTransportReceiptPath(home: string, from: string, to: string, at: string): string { return join(home, "storage-transports", `${hash(json([from, to, at]))}.json`); }

/** Rename on one filesystem; otherwise verify a durable copy before retiring exact original entries. */
export async function transportRuntimeArea(home: string, from: string, to: string, at: string, options: RuntimeTransportOptions = {}): Promise<void> {
  const receiptPath = runtimeTransportReceiptPath(home, from, to, at);
  let receipt = await readFile(receiptPath, "utf8").then(text => JSON.parse(text) as Receipt, error => { if (error.code === "ENOENT") return null; throw error; });
  if (receipt !== null) validateReceipt(receipt);
  if (receipt === null) {
    if (await exists(to)) refuse(`runtime destination is occupied: ${to}`);
    if (!options.forceCopyForTest) {
      try { await rename(from, to); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
    }
    receipt = { from, to, source: await identity(from), entries: await inventory(from), phase: "copying" };
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFileAtomic(receiptPath, json(receipt));
    await mkdir(to);
    receipt = { ...receipt, target: await identity(to) };
    await writeFileAtomic(receiptPath, json(receipt));
  }
  if (receipt.from !== from || receipt.to !== to || receipt.target === undefined || json(await identity(to)) !== json(receipt.target)) refuse("runtime transport receipt does not own the destination");
  const expected = new Map(receipt.entries.map(entry => [entry.path, entry]));
  if (receipt.phase === "copying") {
    if (json(await identity(from)) !== json(receipt.source) || !identical(await inventory(from), receipt.entries)) refuse("runtime source changed before copy");
    for (const actual of await inventory(to)) {
      const saved = expected.get(actual.path);
      if (!saved || saved.kind !== actual.kind) refuse(`unowned runtime landing: ${actual.path}`);
      if (actual.kind === "file" && content(actual) !== content(saved)) {
        const partial = await readFile(join(to, actual.path)), source = await readFile(join(from, actual.path));
        if (partial.length >= source.length || !partial.equals(source.subarray(0, partial.length))) refuse(`modified runtime landing: ${actual.path}`);
        await unlink(join(to, actual.path));
      } else if (content(actual) !== content(saved)) refuse(`modified runtime landing: ${actual.path}`);
    }
    for (const entry of receipt.entries) {
      const destination = join(to, entry.path);
      if (await exists(destination)) continue;
      if (entry.kind === "directory") await mkdir(destination);
      else if (entry.kind === "link") await symlink(entry.link!, destination, entry.directoryLink ? "dir" : "file");
      else await copyFile(join(from, entry.path), destination, constants.COPYFILE_EXCL);
    }
    if (!identical(await inventory(from), receipt.entries) || !identical(await inventory(to), receipt.entries)) refuse("runtime copy does not match the original");
    receipt = { ...receipt, phase: "verified" };
    await writeFileAtomic(receiptPath, json(receipt));
    await options.publicationStepForTest?.("verified");
  }
  if (!identical(await inventory(to), receipt.entries)) refuse("verified runtime destination changed");
  if (await exists(from)) {
    if (json(await identity(from)) !== json(receipt.source)) refuse("runtime source identity changed");
    const remaining = await inventory(from);
    if (!identical(remaining, receipt.entries, true)) refuse("runtime source has new or modified entries");
    for (const entry of remaining.filter(entry => entry.kind !== "directory")) {
      const source = join(from, entry.path), destination = join(to, entry.path);
      const actual = await lstat(source);
      if (entry.kind === "link") {
        if (!actual.isSymbolicLink() || await readlink(source) !== entry.link || await readlink(destination) !== entry.link) refuse(`runtime link changed: ${entry.path}`);
      } else if (!actual.isFile() || hash(await readFile(source)) !== entry.sha256 || hash(await readFile(destination)) !== entry.sha256) refuse(`runtime file changed: ${entry.path}`);
      await unlink(source);
      await options.publicationStepForTest?.("retiring");
    }
    for (const entry of remaining.filter(entry => entry.kind === "directory").sort((a, b) => b.path.length - a.path.length)) await rmdir(join(from, entry.path));
    await rmdir(from);
  }
  await writeFileAtomic(receiptPath, json({ ...receipt, phase: "complete" }));
}
