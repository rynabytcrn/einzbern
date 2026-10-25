// SPDX-License-Identifier: Apache-2.0

export declare const CONFIG_BACKUP_RESERVATION_FILE: ".einzbern-config-backup-reserved.json";
export declare const CONFIG_BACKUP_RESERVATION_SCHEMA_VERSION: "einzbern.config-backup-reservation.v1";
export declare const CONFIG_BACKUP_RESERVED_AREAS: readonly ["config-backups", "config-backup-staging", "config-backup-recovery"];
export declare const CONFIG_BACKUP_RESERVATION_TEXT: string;
export declare class ConfigBackupReservationError extends Error {
  constructor(reasonCode: string, path: string);
  readonly reasonCode: string;
}
export declare function readConfigBackupReservation(root: string): Promise<boolean>;
