import type { FileEntryWithStats, Stats } from 'ssh2'
import type { RemoteFileEntry, RemoteFileKind } from '../../../shared/types/sftp'
import {
  joinRemotePath,
  normalizeRemotePath,
  remotePathName,
  sortRemoteEntries,
} from '../../../shared/sftp/remotePath'

const TYPE_MASK = 0o170000
const DIRECTORY_TYPE = 0o040000
const SYMLINK_TYPE = 0o120000
const SECOND_MS = 1000
const MAX_DATE_MS = 8.64e15

function isSafeEntryName(name: string): boolean {
  return (
    name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
  )
}

function kindFromMode(mode: unknown): RemoteFileKind | null {
  if (typeof mode !== 'number' || !Number.isFinite(mode)) return null
  const type = mode & TYPE_MASK
  if (type === DIRECTORY_TYPE) return 'directory'
  if (type === SYMLINK_TYPE) return 'symlink'
  if (type !== 0) return 'file'
  return null
}

function kindFromLongname(longname: unknown): RemoteFileKind | null {
  if (typeof longname !== 'string' || longname.length === 0) return null
  if (longname.startsWith('d')) return 'directory'
  if (longname.startsWith('l')) return 'symlink'
  if (longname.startsWith('-')) return 'file'
  return null
}

/**
 * ssh2 offers helper methods, but some servers/forks return attributes without
 * them. Mode bits and the longname prefix are safe read-only fallbacks.
 */
export function resolveRemoteKind(
  attrs: Partial<Stats> | null | undefined,
  longname?: string,
): RemoteFileKind {
  if (attrs) {
    try {
      if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()) return 'symlink'
      if (typeof attrs.isDirectory === 'function' && attrs.isDirectory()) return 'directory'
      if (typeof attrs.isFile === 'function' && attrs.isFile()) return 'file'
    } catch {
      // Fall through to raw attributes.
    }
    const fromMode = kindFromMode(attrs.mode)
    if (fromMode) return fromMode
  }
  return kindFromLongname(longname) ?? 'file'
}

export function formatRemotePermissions(mode: unknown, kind: RemoteFileKind): string | null {
  if (typeof mode !== 'number' || !Number.isFinite(mode) || mode < 0) return null
  const type = kind === 'directory' ? 'd' : kind === 'symlink' ? 'l' : '-'
  const bits = mode & 0o7777
  const flags = [
    bits & 0o400 ? 'r' : '-',
    bits & 0o200 ? 'w' : '-',
    bits & 0o100 ? 'x' : '-',
    bits & 0o040 ? 'r' : '-',
    bits & 0o020 ? 'w' : '-',
    bits & 0o010 ? 'x' : '-',
    bits & 0o004 ? 'r' : '-',
    bits & 0o002 ? 'w' : '-',
    bits & 0o001 ? 'x' : '-',
  ]
  return `${type}${flags.join('')}`
}

function readSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.trunc(value)
}

function readModifiedAt(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const milliseconds = value * SECOND_MS
  if (milliseconds > MAX_DATE_MS) return null
  const date = new Date(milliseconds)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export function createRemoteFileEntry(
  path: string,
  name: string,
  attrs: Partial<Stats> | null | undefined,
  longname?: string,
): RemoteFileEntry {
  const kind = resolveRemoteKind(attrs, longname)
  const mode = attrs?.mode
  return {
    id: path,
    name,
    path,
    kind,
    sizeBytes: kind === 'file' ? readSize(attrs?.size) : null,
    modifiedAt: readModifiedAt(attrs?.mtime),
    permissions: formatRemotePermissions(mode, kind),
  }
}

export function mapRemoteDirectoryEntries(
  directory: string,
  entries: readonly FileEntryWithStats[] | null | undefined,
): RemoteFileEntry[] {
  const normalizedDirectory = normalizeRemotePath(directory)
  const result: RemoteFileEntry[] = []
  if (!Array.isArray(entries)) return result

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const name = typeof entry.filename === 'string' ? entry.filename : ''
    if (!isSafeEntryName(name)) continue
    const path = joinRemotePath(normalizedDirectory, name)
    const attrs = entry.attrs && typeof entry.attrs === 'object' ? entry.attrs : null
    result.push(createRemoteFileEntry(path, name, attrs, entry.longname))
  }
  return sortRemoteEntries(result)
}

export function mapRemoteStatEntry(
  path: string,
  stats: Stats | null | undefined,
  longname?: string,
): RemoteFileEntry {
  const normalized = normalizeRemotePath(path)
  return createRemoteFileEntry(normalized, remotePathName(normalized), stats, longname)
}

export { isSafeEntryName }
