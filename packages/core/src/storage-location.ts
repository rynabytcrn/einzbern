// SPDX-License-Identifier: Apache-2.0
import { dirname, join } from "node:path";
import { DIRECTORY } from "./names.js";

import { readStorageLocation } from "../../../scripts/lib/storage-location.mjs";
export { readStorageLocation } from "../../../scripts/lib/storage-location.mjs";
export type { StorageLocation } from "../../../scripts/lib/storage-location.mjs";
export function defaultSharedLibraryPath(home: string): string { return readStorageLocation(home)?.library ?? join(dirname(home), DIRECTORY.cloudDefaultParent); }
/** Ether names the directory; the caller chooses its parent on any filesystem. */
export function sharedRuntimePath(library: string, deviceId: string): string { return join(library, DIRECTORY.device, deviceId); }
export function runtimeHome(home: string): string { return readStorageLocation(home)?.runtime ?? home; }
