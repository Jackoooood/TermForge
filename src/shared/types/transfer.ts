import type { OperationErrorCode } from './ipc'

export type TransferDirection = 'upload' | 'download'

/**
 * Authoritative task lifecycle. Only the main process may move a task between
 * these states; the renderer store is a read-only projection.
 */
export type TransferStatus =
  | 'queued'
  | 'preparing'
  | 'waitingForConflictResolution'
  | 'transferring'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  /** A task was active when the previous app process ended; its outcome is unknown. */
  | 'interrupted'

export type TransferConflictPolicy = 'overwrite' | 'rename' | 'skip'

export type TransferErrorCode =
  | OperationErrorCode
  | 'source-missing'
  | 'source-not-file'
  | 'source-changed'
  | 'destination-unavailable'
  | 'connection-lost'
  | 'target-changed'
  | 'cancelled'
  | 'cleanup-failed'

export interface TransferConflictInfo {
  /** Absolute path that already exists at the final destination. */
  targetPath: string
  /** Suggested non-conflicting file name (not a full path). */
  suggestedName: string
  /** Full suggested destination path shown to the user. */
  suggestedPath: string
}

export interface TransferTask {
  id: string
  sessionId: string
  direction: TransferDirection
  fileName: string
  sourcePath: string
  /**
   * Final destination: the absolute remote path for uploads and the absolute
   * local path for downloads. When a rename policy is resolved this is the
   * renamed path, never silently rewritten afterwards.
   */
  destinationPath: string
  status: TransferStatus
  /** null means the size is unknown; it must not be rendered as 100%. */
  totalBytes: number | null
  transferredBytes: number
  /** null means indeterminate (unknown or zero-length in flight). 0-100. */
  progress: number | null
  speedBytesPerSecond: number | null
  errorCode: TransferErrorCode | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  attempt: number
  conflictPolicy: TransferConflictPolicy | null
  conflict: TransferConflictInfo | null
  /** Monotonic projection version used to discard stale renderer snapshots. */
  revision: number
}

export interface TransferUpdateEvent {
  task: TransferTask
}

export interface TransferClearAck {
  cleared: number
}

/**
 * Result of an explicit-path upload enqueue (drag & drop or panel selection).
 * Directory sources are expanded into per-file tasks; entries that were
 * deliberately left out are reported as counts, never silently transferred.
 */
export interface TransferUploadEnqueueAck {
  tasks: TransferTask[]
  /** Selectable sources that are symbolic links and were not followed. */
  skippedSymlinks: number
  /** Entries with unsupported types (sockets, pipes, names with separators). */
  skippedUnsupported: number
  /** True when the directory tree exceeded the expanded-task cap. */
  truncated: boolean
  /** The normalized remote directory the sources were dropped onto. */
  remoteDirectory: string
}

export const MAX_TRANSFER_BATCH = 50

export const TRANSFER_STATUSES: readonly TransferStatus[] = [
  'queued',
  'preparing',
  'waitingForConflictResolution',
  'transferring',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'interrupted',
]

export function isActiveTransferStatus(status: TransferStatus): boolean {
  return (
    status === 'queued' ||
    status === 'preparing' ||
    status === 'waitingForConflictResolution' ||
    status === 'transferring' ||
    status === 'cancelling'
  )
}

export function isTerminalTransferStatus(status: TransferStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'skipped' ||
    status === 'interrupted'
  )
}
