import type { RemoteFileEntry, RemoteFileKind } from '../types/sftp'

/**
 * Shared POSIX remote-path helpers. The renderer and main process both use
 * these so that remote paths never inherit Windows `path.join` semantics.
 * Normalization improves UX only; the SFTP server remains the authority on
 * permissions and path validity.
 */

const ROOT = '/'
const MAX_PATH_LENGTH = 4096
const MAX_NAME_LENGTH = 255

export function normalizeRemotePath(input: string): string {
  if (input.includes('\0')) {
    throw new Error('远程路径不能包含 NUL 字符')
  }

  const segments: string[] = []
  for (const segment of input.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `${ROOT}${segments.join('/')}`
}

/**
 * Resolves a user-supplied path against a directory. Relative paths and `..`
 * are resolved locally; the result is always an absolute normalized path.
 */
export function resolveRemotePath(basePath: string, input: string): string {
  if (input.length === 0) return normalizeRemotePath(basePath)
  if (input.startsWith('/')) return normalizeRemotePath(input)
  const base = normalizeRemotePath(basePath)
  return normalizeRemotePath(`${base === ROOT ? '' : base}/${input}`)
}

export function remoteParentPath(path: string): string {
  const normalized = normalizeRemotePath(path)
  if (normalized === ROOT) return ROOT
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? ROOT : normalized.slice(0, index)
}

export function remotePathName(path: string): string {
  const normalized = normalizeRemotePath(path)
  if (normalized === ROOT) return ROOT
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function getRemoteEntryNameError(name: string): string | null {
  if (name.length === 0) return '名称不能为空'
  if (name.length > MAX_NAME_LENGTH) return `名称不能超过 ${MAX_NAME_LENGTH} 个字符`
  if (name.trim().length === 0) return '名称不能只包含空白字符'
  if (name === '.' || name === '..') return '名称不能是 . 或 ..'
  if (name.includes('/')) return '名称不能包含斜杠'
  if (name.includes('\0')) return '名称不能包含 NUL 字符'
  if (hasControlCharacter(name)) return '名称不能包含控制字符'
  return null
}

export function getRemotePathError(path: string): string | null {
  if (path.length === 0) return '路径不能为空'
  if (path.length > MAX_PATH_LENGTH) return `路径不能超过 ${MAX_PATH_LENGTH} 个字符`
  if (!path.startsWith('/')) return '请使用以 / 开头的绝对路径'
  if (path.includes('\0')) return '路径不能包含 NUL 字符'
  if (hasControlCharacter(path)) return '路径不能包含控制字符'
  return null
}

export function joinRemotePath(directory: string, name: string): string {
  const nameError = getRemoteEntryNameError(name)
  if (nameError) throw new Error(nameError)
  const normalized = normalizeRemotePath(directory)
  return normalized === ROOT ? `${ROOT}${name}` : `${normalized}/${name}`
}

export function isRootRemotePath(path: string): boolean {
  return normalizeRemotePath(path) === ROOT
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

const KIND_ORDER: Record<RemoteFileKind, number> = {
  directory: 0,
  symlink: 1,
  file: 2,
}

export function compareRemoteEntries(
  left: Pick<RemoteFileEntry, 'name' | 'kind'>,
  right: Pick<RemoteFileEntry, 'name' | 'kind'>,
): number {
  const kindDifference = KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
  if (kindDifference !== 0) return kindDifference
  const primary = collator.compare(left.name, right.name)
  if (primary !== 0) return primary
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function sortRemoteEntries<T extends Pick<RemoteFileEntry, 'name' | 'kind'>>(
  entries: readonly T[],
): T[] {
  return [...entries].sort(compareRemoteEntries)
}

export type RemoteSortField = 'name' | 'size' | 'modified'
export type RemoteSortDirection = 'asc' | 'desc'

export interface RemoteSortState {
  field: RemoteSortField
  direction: RemoteSortDirection
}

type SortableRemoteEntry = Pick<RemoteFileEntry, 'name' | 'kind' | 'sizeBytes' | 'modifiedAt'>

function modifiedTimestamp(value: string | null): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

export function compareRemoteEntriesBy(
  left: SortableRemoteEntry,
  right: SortableRemoteEntry,
  sort: RemoteSortState,
): number {
  const kindDifference = KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
  if (kindDifference !== 0) return kindDifference

  let primary = 0
  if (sort.field === 'name') {
    primary = collator.compare(left.name, right.name)
  } else {
    const leftValue = sort.field === 'size' ? left.sizeBytes : modifiedTimestamp(left.modifiedAt)
    const rightValue = sort.field === 'size' ? right.sizeBytes : modifiedTimestamp(right.modifiedAt)
    if (leftValue === null || rightValue === null) {
      if (leftValue === null && rightValue === null) primary = 0
      else return leftValue === null ? 1 : -1
    } else {
      primary = leftValue - rightValue
    }
  }

  if (primary !== 0) return sort.direction === 'asc' ? primary : -primary

  const byName = collator.compare(left.name, right.name)
  if (byName !== 0) return byName
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function sortRemoteEntriesBy<T extends SortableRemoteEntry>(
  entries: readonly T[],
  sort: RemoteSortState,
): T[] {
  return [...entries].sort((left, right) => compareRemoteEntriesBy(left, right, sort))
}

export { MAX_NAME_LENGTH, MAX_PATH_LENGTH }
