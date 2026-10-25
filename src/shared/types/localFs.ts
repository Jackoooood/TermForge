export type LocalFileKind = 'directory' | 'file' | 'symlink'

/**
 * A single local directory entry. Only metadata ever crosses IPC — file
 * contents are read exclusively inside the main process by the transfer
 * pipeline. `hidden` uses the dot-prefix convention; Windows attribute-based
 * hiding is not detected.
 */
export interface LocalFileEntry {
  id: string
  name: string
  /** Absolute normalized local path. */
  path: string
  kind: LocalFileKind
  sizeBytes: number | null
  modifiedAt: string | null
  hidden: boolean
}

export interface LocalDirectoryListing {
  path: string
  /** Null when the listed path is already a volume or share root. */
  parentPath: string | null
  entries: LocalFileEntry[]
  /** True when the directory held more entries than the safety cap. */
  truncated: boolean
  loadedAt: string
}

export interface LocalRootEntry {
  name: string
  path: string
  kind: 'home' | 'drive' | 'root'
}

export interface LocalRootsResult {
  home: string
  roots: LocalRootEntry[]
}

export const MAX_LOCAL_DIRECTORY_ENTRIES = 5000