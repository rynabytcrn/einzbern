// SPDX-License-Identifier: Apache-2.0
export interface StorageLocation { readonly schemaVersion: "einzbern.storage-location.v1"; readonly library: string; readonly runtime: string; readonly at: string; readonly decidedIn: string }
export function readStorageLocation(home: string): StorageLocation | null;
