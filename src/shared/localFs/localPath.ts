import type { LocalFileEntry, LocalFileKind } from '../types/localFs'
import { getLocalFileNameError } from '../transfer/localFileName'

/**
 * Pure local-path helpers shared by the renderer and the main process.
 * Windows semantics are primary: `C:\` drives and `\\server\share` UNC roots
 * are recognized, both separators are accepted, and no Node.js `path` module is
 * used so this module stays safe for the renderer bundle. Normalization is
 * display and validation support only — the local filesystem remains the
 * authority on existence, permissions and case.
 */

const MAX_PATH_LENGTH = 4096
const WINDOWS_DRIVE = /^([A-Za-z]):([\\/]|$)/
const DEVICE_PREFIX = /^\\\\[.?][\\/]/

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function getLocalPathError(path: string): string | null {
  if (path.length === 0) return '路径不能为空'
  if (path.length > MAX_PATH_LENGTH) return `路径不能超过 ${MAX_PATH_LENGTH} 个字符`
  if (path.includes('\0')) return '路径不能包含 NUL 字符'
  if (hasControlCharacter(path)) return '路径不能包含控制字符'
  if (DEVICE_PREFIX.test(path)) return '不支持设备路径前缀 \\\\.\\ 或 \\\\?\\'
  return null
}

export function isWindowsStyleLocalPath(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || path.startsWith('\\\\')
}

export function isAbsoluteLocalPath(path: string): boolean {
  return isWindowsStyleLocalPath(path) || path.startsWith('/')
}

interface LocalPathParts {
  /** `C:\`, `\\server\share`, `/`, or '' for relative paths. */
  root: string
  segments: string[]
}

function splitSegments(body: string): string[] {
  return body.split(/[\\/]+/).filter(Boolean)
}

function splitLocalPath(path: string): LocalPathParts {
  const drive = WINDOWS_DRIVE.exec(path)
  if (drive) {
    const rest = path.slice(drive[0].length)
    return { root: `${drive[1]!.toUpperCase()}:\\`, segments: splitSegments(rest) }
  }
  if (path.startsWith('\\\\')) {
    const parts = splitSegments(path.slice(2))
    if (parts.length <= 1) return { root: `\\\\${parts[0] ?? ''}`, segments: [] }
    return { root: `\\\\${parts[0]}\\${parts[1]}`, segments: parts.slice(2) }
  }
  if (path.startsWith('/')) {
    return { root: '/', segments: splitSegments(path.slice(1)) }
  }
  return { root: '', segments: splitSegments(path) }
}

function separatorFor(root: string): string {
  return root === '/' || root === '' ? '/' : '\\'
}

/** Resolves `.`/`..` and unifies separators; keeps drive letters uppercase. */
export function normalizeLocalPath(input: string): string {
  const { root, segments } = splitLocalPath(input)
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '.') continue
    if (segment === '..') {
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  if (root === '') return resolved.join('/')
  if (root === '/') return `/${resolved.join('/')}`
  if (root.endsWith('\\')) {
    return resolved.length === 0 ? root : `${root}${resolved.join('\\')}`
  }
  if (resolved.length === 0) return root
  return `${root}\\${resolved.join('\\')}`
}

/**
 * Returns the parent directory, or null when the path is already a root
 * (`C:\`, a UNC share, `/`) or relative. The UI treats null as “show roots”.
 */
export function localParentPath(path: string): string | null {
  const normalized = normalizeLocalPath(path)
  const { root, segments } = splitLocalPath(normalized)
  if (root === '' || segments.length === 0) return null
  if (segments.length === 1) return root
  const separator = separatorFor(root)
  const base = root === '/' ? '' : root.endsWith('\\') ? root.slice(0, -1) : root
  return `${base}${separator}${segments.slice(0, -1).join(separator)}`
}

export function localPathName(path: string): string {
  const { segments } = splitLocalPath(normalizeLocalPath(path))
  return segments[segments.length - 1] ?? ''
}

export function isLocalPathAtRoot(path: string): boolean {
  const { root, segments } = splitLocalPath(normalizeLocalPath(path))
  return root !== '' && segments.length === 0
}

/**
 * Joins a user-supplied entry name onto a trusted local directory. The name is
 * validated with the Windows-first file-name policy, so separators cannot be
 * smuggled in from typed input. Directory listings build child paths from real
 * filesystem names instead of this helper.
 */
export function joinLocalPath(directory: string, name: string): string {
  const nameError = getLocalFileNameError(name)
  if (nameError) throw new Error(nameError)
  const normalized = normalizeLocalPath(directory)
  if (normalized === '') throw new Error('本地目录不能为空')
  if (normalized === '/') return `/${name}`
  if (normalized.endsWith('\\')) return `${normalized}${name}`
  return `${normalized}${separatorFor(normalized)}${name}`
}

/**
 * Appends a filesystem-provided entry name without file-name validation.
 * Only for names that came from `readdir` results; callers must verify the
 * name contains no separators. Typed input goes through {@link joinLocalPath}.
 */
export function appendLocalName(directory: string, name: string): string {
  const normalized = normalizeLocalPath(directory)
  if (normalized === '') return name
  if (normalized === '/') return `/${name}`
  if (normalized.endsWith('\\')) return `${normalized}${name}`
  return `${normalized}${separatorFor(normalized)}${name}`
}

/** Resolves typed path input against the current directory. */
export function resolveLocalPath(basePath: string, input: string): string {
  if (input.length === 0) return normalizeLocalPath(basePath)
  if (isAbsoluteLocalPath(input)) return normalizeLocalPath(input)
  const base = normalizeLocalPath(basePath)
  if (base === '' || base === '/') return normalizeLocalPath(`/${input}`)
  const prefix = base.endsWith('\\') ? '' : '\\'
  return normalizeLocalPath(`${base}${prefix}${input}`)
}

export function splitLocalBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const { root, segments } = splitLocalPath(normalizeLocalPath(path))
  if (root === '') return []
  const separator = separatorFor(root)
  const crumbs = [{ label: root, path: root }]
  let current = root
  for (const segment of segments) {
    current = current.endsWith(separator)
      ? `${current}${segment}`
      : `${current}${separator}${segment}`
    crumbs.push({ label: segment, path: current })
  }
  return crumbs
}

export type LocalSortField = 'name' | 'size' | 'time'
export type LocalSortDirection = 'asc' | 'desc'

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

const KIND_ORDER: Record<LocalFileKind, number> = {
  directory: 0,
  symlink: 1,
  file: 2,
}

type ComparableLocalEntry = Pick<
  LocalFileEntry,
  'name' | 'kind' | 'sizeBytes' | 'modifiedAt'
>

/**
 * Directories stay first regardless of the sort field; the chosen field (and
 * direction) orders entries inside each kind group, and names break ties in
 * ascending order so the order stays stable.
 */
export function compareLocalEntries(
  left: ComparableLocalEntry,
  right: ComparableLocalEntry,
  field: LocalSortField = 'name',
  direction: LocalSortDirection = 'asc',
): number {
  const kindDifference = KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
  if (kindDifference !== 0) return kindDifference
  const sign = direction === 'asc' ? 1 : -1
  if (field === 'size') {
    const leftSize = left.sizeBytes ?? -1
    const rightSize = right.sizeBytes ?? -1
    if (leftSize !== rightSize) return (leftSize - rightSize) * sign
  } else if (field === 'time') {
    const leftTime = left.modifiedAt ?? ''
    const rightTime = right.modifiedAt ?? ''
    if (leftTime !== rightTime) return (leftTime < rightTime ? -1 : 1) * sign
  }
  const primary = collator.compare(left.name, right.name)
  if (primary !== 0) return field === 'name' ? primary * sign : primary
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function sortLocalEntries<T extends ComparableLocalEntry>(
  entries: readonly T[],
  field: LocalSortField = 'name',
  direction: LocalSortDirection = 'asc',
): T[] {
  return [...entries].sort((left, right) => compareLocalEntries(left, right, field, direction))
}

export { MAX_PATH_LENGTH as MAX_LOCAL_PATH_LENGTH }