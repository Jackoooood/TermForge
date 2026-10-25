/**
 * Main-process naming convention for partial files. Both local and remote
 * temporary files must stay in the destination directory so the final commit
 * is a same-directory rename, never a copy across filesystems.
 */
export const TRANSFER_TEMP_PREFIX = '.termforge-part-'
export const TRANSFER_BACKUP_PREFIX = '.termforge-backup-'

export function isTransferTempName(name: string): boolean {
  return name.startsWith(TRANSFER_TEMP_PREFIX) && name.length > TRANSFER_TEMP_PREFIX.length
}

export function isTransferBackupName(name: string): boolean {
  return name.startsWith(TRANSFER_BACKUP_PREFIX) && name.length > TRANSFER_BACKUP_PREFIX.length
}
