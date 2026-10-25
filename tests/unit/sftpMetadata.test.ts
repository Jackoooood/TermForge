// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { FileEntryWithStats, Stats } from 'ssh2'
import {
  createRemoteFileEntry,
  formatRemotePermissions,
  isSafeEntryName,
  mapRemoteDirectoryEntries,
  mapRemoteStatEntry,
  resolveRemoteKind,
} from '../../src/main/services/sftp/sftpMetadata'

function stats(options: {
  kind?: 'directory' | 'file' | 'symlink' | 'fifo'
  mode: number
  size?: number
  mtime?: number
}): Stats {
  const kind = options.kind ?? 'file'
  return {
    mode: options.mode,
    size: options.size ?? 0,
    mtime: options.mtime ?? 0,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  } as unknown as Stats
}

describe('SFTP metadata mapping', () => {
  it('maps directories, files and symlinks with nullable metadata', () => {
    const directory = createRemoteFileEntry(
      '/var/www',
      'www',
      stats({ kind: 'directory', mode: 0o040755, size: 4096, mtime: 1_700_000_000 }),
    )
    expect(directory).toEqual({
      id: '/var/www',
      name: 'www',
      path: '/var/www',
      kind: 'directory',
      sizeBytes: null,
      modifiedAt: '2023-11-14T22:13:20.000Z',
      permissions: 'drwxr-xr-x',
    })

    const file = createRemoteFileEntry(
      '/var/www/index.html',
      'index.html',
      stats({ mode: 0o100644, size: 1234, mtime: 1_700_000_000 }),
    )
    expect(file).toMatchObject({
      kind: 'file',
      sizeBytes: 1234,
      modifiedAt: '2023-11-14T22:13:20.000Z',
      permissions: '-rw-r--r--',
    })

    const symlink = createRemoteFileEntry(
      '/var/www/current',
      'current',
      stats({ kind: 'symlink', mode: 0o120777, size: 18, mtime: 1_700_000_000 }),
    )
    expect(symlink).toMatchObject({
      kind: 'symlink',
      sizeBytes: null,
      permissions: 'lrwxrwxrwx',
    })
  })

  it('does not invent metadata when attributes are absent or incomplete', () => {
    expect(createRemoteFileEntry('/home/deploy/unknown', 'unknown', null)).toEqual({
      id: '/home/deploy/unknown',
      name: 'unknown',
      path: '/home/deploy/unknown',
      kind: 'file',
      sizeBytes: null,
      modifiedAt: null,
      permissions: null,
    })

    expect(
      createRemoteFileEntry('/home/deploy/partial', 'partial', {
        mode: undefined,
        size: undefined,
        mtime: undefined,
      } as Partial<Stats>),
    ).toEqual({
      id: '/home/deploy/partial',
      name: 'partial',
      path: '/home/deploy/partial',
      kind: 'file',
      sizeBytes: null,
      modifiedAt: null,
      permissions: null,
    })
  })

  it('falls back to mode type bits when helper methods are unavailable', () => {
    expect(resolveRemoteKind({ mode: 0o040755 } as Stats)).toBe('directory')
    expect(resolveRemoteKind({ mode: 0o120777 } as Stats)).toBe('symlink')
    expect(resolveRemoteKind({ mode: 0o100644 } as Stats)).toBe('file')
    expect(resolveRemoteKind({ mode: 0o010644 } as Stats)).toBe('file')
  })

  it('uses the longname prefix only when mode bits are unusable', () => {
    expect(
      resolveRemoteKind(
        { mode: 0 } as Stats,
        'drwxr-xr-x 2 deploy deploy 4096 Oct 22 08:00 releases',
      ),
    ).toBe('directory')
    expect(resolveRemoteKind(null, 'lrwxrwxrwx 1 deploy deploy 18 Oct 22 08:00 current')).toBe(
      'symlink',
    )
    expect(resolveRemoteKind(undefined, '-rw-r--r-- 1 deploy deploy 12 Oct 22 08:00 notes')).toBe(
      'file',
    )
    expect(resolveRemoteKind(null, '?rw-r--r--')).toBe('file')
  })

  it('formats POSIX permissions and rejects missing modes', () => {
    expect(formatRemotePermissions(0o040755, 'directory')).toBe('drwxr-xr-x')
    expect(formatRemotePermissions(0o100600, 'file')).toBe('-rw-------')
    expect(formatRemotePermissions(0o120777, 'symlink')).toBe('lrwxrwxrwx')
    expect(formatRemotePermissions(undefined, 'file')).toBeNull()
    expect(formatRemotePermissions(Number.NaN, 'file')).toBeNull()
    expect(formatRemotePermissions(-1, 'file')).toBeNull()
  })

  it('drops invalid timestamps and negative or non-finite sizes', () => {
    expect(
      createRemoteFileEntry('/data/a', 'a', stats({ mode: 0o100644, size: -1, mtime: 0 })),
    ).toMatchObject({ sizeBytes: null, modifiedAt: null })
    expect(
      createRemoteFileEntry(
        '/data/b',
        'b',
        stats({ mode: 0o100644, size: Number.POSITIVE_INFINITY, mtime: 8.64e15 }),
      ),
    ).toMatchObject({ sizeBytes: null, modifiedAt: null })
  })

  it('maps and sorts directory entries while filtering unsafe names', () => {
    const entries = [
      {
        filename: 'file10.txt',
        longname: '-rw-r--r-- 1 deploy deploy 10 Oct 22 08:00 file10.txt',
        attrs: stats({ mode: 0o100644, size: 10, mtime: 1_700_000_000 }),
      },
      {
        filename: 'release 2026',
        longname: 'drwxr-xr-x 2 deploy deploy 4096 Oct 22 08:00 release 2026',
        attrs: stats({ kind: 'directory', mode: 0o040755 }),
      },
      {
        filename: '发布 日志.txt',
        longname: '-rw-r--r-- 1 deploy deploy 20 Oct 22 08:00 发布 日志.txt',
        attrs: null,
      },
      {
        filename: '.',
        longname: 'drwxr-xr-x',
        attrs: stats({ kind: 'directory', mode: 0o040755 }),
      },
      {
        filename: '..',
        longname: 'drwxr-xr-x',
        attrs: stats({ kind: 'directory', mode: 0o040755 }),
      },
      {
        filename: 'nested/name',
        longname: '-rw-r--r--',
        attrs: stats({ mode: 0o100644 }),
      },
      {
        filename: 'nul\0name',
        longname: '-rw-r--r--',
        attrs: stats({ mode: 0o100644 }),
      },
    ] as unknown as FileEntryWithStats[]

    const mapped = mapRemoteDirectoryEntries('/srv/app/', entries)
    expect(mapped.map((entry) => entry.name)).toEqual([
      'release 2026',
      'file10.txt',
      '发布 日志.txt',
    ])
    expect(mapped[0]).toMatchObject({
      path: '/srv/app/release 2026',
      kind: 'directory',
    })
    expect(mapped[1]).toMatchObject({
      path: '/srv/app/file10.txt',
      kind: 'file',
      sizeBytes: 10,
    })
    expect(mapped[2]).toMatchObject({
      path: '/srv/app/发布 日志.txt',
      kind: 'file',
      sizeBytes: null,
      modifiedAt: null,
      permissions: null,
    })
  })

  it('returns an empty list for missing or non-array readdir results', () => {
    expect(mapRemoteDirectoryEntries('/var/www', null)).toEqual([])
    expect(mapRemoteDirectoryEntries('/var/www', undefined)).toEqual([])
  })

  it('maps stat results using the normalized path basename', () => {
    expect(
      mapRemoteStatEntry('/srv/app/config/', stats({ mode: 0o100600, size: 64 })),
    ).toMatchObject({
      name: 'config',
      path: '/srv/app/config',
      kind: 'file',
      sizeBytes: 64,
      permissions: '-rw-------',
    })
  })

  it('recognizes safe entry names only', () => {
    expect(isSafeEntryName('release-2026.10')).toBe(true)
    expect(isSafeEntryName('发布 版本')).toBe(true)
    expect(isSafeEntryName('')).toBe(false)
    expect(isSafeEntryName('.')).toBe(false)
    expect(isSafeEntryName('..')).toBe(false)
    expect(isSafeEntryName('nested/name')).toBe(false)
    expect(isSafeEntryName('nul\0name')).toBe(false)
  })
})
