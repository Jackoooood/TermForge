import type {
  RemoteTextEncoding,
  RemoteTextEol,
} from '../sftp/remoteText'

export type { RemoteTextEncoding, RemoteTextEol } from '../sftp/remoteText'

export type RemoteFileKind = 'directory' | 'file' | 'symlink'

/**
 * A single directory entry as reported by the remote SFTP server.
 * Metadata can be absent on servers that omit attributes; consumers must
 * render “unknown” instead of inventing size or timestamps.
 */
export interface RemoteFileEntry {
  id: string
  name: string
  /** Normalized absolute POSIX path built from the listed directory. */
  path: string
  kind: RemoteFileKind
  sizeBytes: number | null
  modifiedAt: string | null
  /** POSIX mode string such as `-rw-r--r--`, or null when unavailable. */
  permissions: string | null
}

export interface RemoteDirectoryListing {
  sessionId: string
  path: string
  entries: RemoteFileEntry[]
  loadedAt: string
}

export interface SftpOpenResult {
  sessionId: string
  /** Absolute path returned by the server's `realpath('.')`. */
  homePath: string
}

export interface SftpMutationAck {
  sessionId: string
  path: string
  operation: 'mkdir' | 'rename' | 'delete-file' | 'remove-directory'
}

export interface SftpCloseAck {
  sessionId: string
  closed: boolean
}

export interface RemoteTextFile {
  sessionId: string
  path: string
  content: string
  encoding: RemoteTextEncoding
  eol: RemoteTextEol
  /** Opaque version marker derived from remote size + mtime. */
  revision: string
  sizeBytes: number
  modifiedAt: string | null
  permissions: string | null
}

export interface SftpTextWriteInput {
  sessionId: string
  path: string
  content: string
  encoding: RemoteTextEncoding
  eol: RemoteTextEol
  /** Revision returned by the read call; null skips the conflict check. */
  expectedRevision: string | null
  /** Explicit user choice to overwrite a file that changed on the server. */
  force: boolean
}

export interface SftpTextWriteAck {
  sessionId: string
  path: string
  revision: string
  sizeBytes: number
  modifiedAt: string | null
  backupCleanupFailed: boolean
}
