import * as fsp from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { AppOperationError } from '../../errors'
import {
  appendLocalName,
  getLocalPathError,
  isAbsoluteLocalPath,
  localParentPath,
  normalizeLocalPath,
  sortLocalEntries,
} from '../../../shared/localFs/localPath'
import { localFsListInputSchema } from '../../../shared/schemas/localFs'
import type {
  LocalDirectoryListing,
  LocalFileEntry,
  LocalFileKind,
  LocalRootEntry,
  LocalRootsResult,
} from '../../../shared/types/localFs'
import { MAX_LOCAL_DIRECTORY_ENTRIES } from '../../../shared/types/localFs'

export interface LocalFsServiceDependencies {
  /** Injected so tests do not depend on the Electron `app` module. */
  getHomeDirectory: () => string
  now?: () => Date
  maxEntries?: number
  entryStatConcurrency?: number
}

/** Metadata-only local browsing surface consumed by the IPC layer. */
export interface LocalFsServicePort {
  roots(): Promise<LocalRootsResult>
  list(path: string): Promise<LocalDirectoryListing>
}

const DEFAULT_ENTRY_STAT_CONCURRENCY = 32
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

function toNodeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await run(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Main-process owner of local filesystem browsing. The renderer can list
 * directory metadata only; it never receives file contents, raw `fs` errors or
 * a path API that bypasses validation. File reads stay in the transfer
 * pipeline, which re-validates every source path before streaming.
 */
export class LocalFsService implements LocalFsServicePort {
  private readonly now: () => Date
  private readonly maxEntries: number
  private readonly statConcurrency: number

  constructor(private readonly dependencies: LocalFsServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.maxEntries = dependencies.maxEntries ?? MAX_LOCAL_DIRECTORY_ENTRIES
    this.statConcurrency = dependencies.entryStatConcurrency ?? DEFAULT_ENTRY_STAT_CONCURRENCY
  }

  async roots(): Promise<LocalRootsResult> {
    const home = normalizeLocalPath(this.dependencies.getHomeDirectory())
    const roots: LocalRootEntry[] = []
    if (home) roots.push({ name: '主目录', path: home, kind: 'home' })
    roots.push(...(await this.listVolumeRoots()))
    return { home, roots }
  }

  private async listVolumeRoots(): Promise<LocalRootEntry[]> {
    if (process.platform !== 'win32') {
      return [{ name: '/', path: '/', kind: 'root' }]
    }
    const drives = await Promise.all(
      DRIVE_LETTERS.map(async (letter): Promise<LocalRootEntry | null> => {
        const root = `${letter}:\\`
        try {
          await fsp.access(root)
          return { name: root, path: root, kind: 'drive' }
        } catch {
          return null
        }
      }),
    )
    return drives.filter((drive): drive is LocalRootEntry => drive !== null)
  }

  async list(rawPath: string): Promise<LocalDirectoryListing> {
    const parsed = localFsListInputSchema.safeParse({ path: rawPath })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '本地路径格式无效。')
    }
    const pathError = getLocalPathError(parsed.data.path)
    if (pathError || !isAbsoluteLocalPath(parsed.data.path)) {
      throw new AppOperationError('invalid-input', '请使用合法的绝对本地路径。')
    }
    const target = normalizeLocalPath(parsed.data.path)

    let stats: Stats
    try {
      stats = await fsp.stat(target)
    } catch (error) {
      throw this.toDirectoryError(error)
    }
    if (!stats.isDirectory()) {
      throw new AppOperationError('not-a-directory', '该本地路径不是目录。')
    }

    let dirents: Dirent[]
    try {
      dirents = await fsp.readdir(target, { withFileTypes: true })
    } catch (error) {
      throw this.toDirectoryError(error)
    }

    const truncated = dirents.length > this.maxEntries
    const limited = truncated ? dirents.slice(0, this.maxEntries) : dirents
    const described = await mapWithConcurrency(limited, this.statConcurrency, (dirent) =>
      this.describeEntry(target, dirent),
    )
    const entries = described.filter((entry): entry is LocalFileEntry => entry !== null)

    return {
      path: target,
      parentPath: localParentPath(target),
      entries: sortLocalEntries(entries),
      truncated,
      loadedAt: this.now().toISOString(),
    }
  }

  private toDirectoryError(error: unknown): AppOperationError {
    const code = toNodeErrorCode(error)
    if (code === 'ENOENT') return new AppOperationError('not-found', '本地目录不存在或已被移动。')
    if (code === 'EACCES' || code === 'EPERM') {
      return new AppOperationError('permission-denied', '没有权限读取该本地目录。')
    }
    if (code === 'ENOTDIR') return new AppOperationError('not-a-directory', '该本地路径不是目录。')
    return new AppOperationError('unavailable', '无法读取本地目录，请稍后重试。')
  }

  private async describeEntry(directory: string, dirent: Dirent): Promise<LocalFileEntry | null> {
    const name = dirent.name
    if (name === '' || name.includes('/') || name.includes('\\')) return null
    const path = appendLocalName(directory, name)
    const hidden = name.startsWith('.')

    if (dirent.isSymbolicLink()) {
      return {
        id: path,
        name,
        path,
        kind: 'symlink',
        sizeBytes: null,
        modifiedAt: await this.modifiedAtOrNull(path),
        hidden,
      }
    }

    let kind: LocalFileKind
    if (dirent.isDirectory()) kind = 'directory'
    else if (dirent.isFile()) kind = 'file'
    else return null

    let stats: Stats
    try {
      stats = await fsp.lstat(path)
    } catch {
      // The entry vanished between readdir and lstat; omit it rather than
      // inventing metadata for a file the user can no longer see.
      return null
    }
    return {
      id: path,
      name,
      path,
      kind,
      sizeBytes: kind === 'file' && Number.isSafeInteger(stats.size) ? stats.size : null,
      modifiedAt: stats.mtime.toISOString(),
      hidden,
    }
  }

  private async modifiedAtOrNull(path: string): Promise<string | null> {
    try {
      const stats = await fsp.lstat(path)
      return stats.mtime.toISOString()
    } catch {
      return null
    }
  }
}