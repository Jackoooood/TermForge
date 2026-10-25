// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  compareRemoteEntries,
  compareRemoteEntriesBy,
  getRemoteEntryNameError,
  getRemotePathError,
  isRootRemotePath,
  joinRemotePath,
  normalizeRemotePath,
  remoteParentPath,
  remotePathName,
  resolveRemotePath,
  sortRemoteEntries,
  sortRemoteEntriesBy,
} from '@shared/sftp/remotePath'

describe('POSIX remote path helpers', () => {
  it('normalizes absolute POSIX paths without Windows separators', () => {
    expect(normalizeRemotePath('/')).toBe('/')
    expect(normalizeRemotePath('///var//www/./termforge/')).toBe('/var/www/termforge')
    expect(normalizeRemotePath('/var/www/../log/./nginx')).toBe('/var/log/nginx')
    expect(normalizeRemotePath('/../../etc')).toBe('/etc')
    expect(normalizeRemotePath('/data/发布 2026/日志')).toBe('/data/发布 2026/日志')
    expect(normalizeRemotePath('/data\\logs')).toBe('/data\\logs')
  })

  it('rejects NUL characters instead of truncating them', () => {
    expect(() => normalizeRemotePath('/var/www\0backup')).toThrow(/NUL/)
  })

  it('resolves absolute and relative input against the current directory', () => {
    expect(resolveRemotePath('/var/www', '/etc/nginx')).toBe('/etc/nginx')
    expect(resolveRemotePath('/var/www', 'releases')).toBe('/var/www/releases')
    expect(resolveRemotePath('/var/www', '../log')).toBe('/var/log')
    expect(resolveRemotePath('/var/www', '')).toBe('/var/www')
    expect(resolveRemotePath('/', 'release-2026.10')).toBe('/release-2026.10')
    expect(resolveRemotePath('/var/www', '..')).toBe('/var')
  })

  it('computes parents and names at the root and in nested directories', () => {
    expect(remoteParentPath('/')).toBe('/')
    expect(remoteParentPath('/var')).toBe('/')
    expect(remoteParentPath('/var/www/')).toBe('/var')
    expect(remotePathName('/')).toBe('/')
    expect(remotePathName('/var/www/')).toBe('www')
    expect(remotePathName('/数据/发布 版')).toBe('发布 版')
    expect(isRootRemotePath('/')).toBe(true)
    expect(isRootRemotePath('/var')).toBe(false)
  })

  it('validates user-created names while allowing spaces and Unicode', () => {
    expect(getRemoteEntryNameError('release-2026.10')).toBeNull()
    expect(getRemoteEntryNameError('发布 版本 v1')).toBeNull()
    expect(getRemoteEntryNameError(' leading-space')).toBeNull()
    expect(getRemoteEntryNameError('back\\slash')).toBeNull()
    expect(getRemoteEntryNameError('')).toMatch(/不能为空/)
    expect(getRemoteEntryNameError('   ')).toMatch(/空白/)
    expect(getRemoteEntryNameError('.')).toMatch(/\./)
    expect(getRemoteEntryNameError('..')).toMatch(/\./)
    expect(getRemoteEntryNameError('nested/name')).toMatch(/斜杠/)
    expect(getRemoteEntryNameError('nul\0name')).toMatch(/NUL/)
    expect(getRemoteEntryNameError('line\nbreak')).toMatch(/控制字符/)
    expect(getRemoteEntryNameError('x'.repeat(256))).toMatch(/255/)
  })

  it('validates absolute remote paths separately from names', () => {
    expect(getRemotePathError('/')).toBeNull()
    expect(getRemotePathError('/var/www/release 2026')).toBeNull()
    expect(getRemotePathError('')).toMatch(/不能为空/)
    expect(getRemotePathError('relative/path')).toMatch(/绝对路径/)
    expect(getRemotePathError('/bad\0path')).toMatch(/NUL/)
    expect(getRemotePathError('/bad\npath')).toMatch(/控制字符/)
    expect(getRemotePathError(`/${'x'.repeat(4096)}`)).toMatch(/4096/)
  })

  it('joins a directory and name using POSIX rules', () => {
    expect(joinRemotePath('/', 'etc')).toBe('/etc')
    expect(joinRemotePath('/var/www', 'release 2026')).toBe('/var/www/release 2026')
    expect(joinRemotePath('/var/www/', 'logs')).toBe('/var/www/logs')
    expect(joinRemotePath('/var/www', '数据')).toBe('/var/www/数据')
    expect(() => joinRemotePath('/var/www', '../escape')).toThrow(/名称/)
  })

  it('sorts directories before symlinks and files, with natural case-insensitive names', () => {
    const entries = [
      { name: 'file10.txt', kind: 'file' as const },
      { name: 'file2.txt', kind: 'file' as const },
      { name: 'Release', kind: 'directory' as const },
      { name: 'archive', kind: 'directory' as const },
      { name: 'current', kind: 'symlink' as const },
      { name: 'README.md', kind: 'file' as const },
    ]

    expect(sortRemoteEntries(entries).map((entry) => entry.name)).toEqual([
      'archive',
      'Release',
      'current',
      'file2.txt',
      'file10.txt',
      'README.md',
    ])
    expect(compareRemoteEntries(entries[0]!, entries[1]!)).toBeGreaterThan(0)
  })

  it('keeps equal-name comparisons deterministic when case differs', () => {
    expect(
      compareRemoteEntries({ name: 'Release', kind: 'file' }, { name: 'release', kind: 'file' }),
    ).not.toBe(0)
  })

  it('sorts by size and modified time while pinning unknown values last', () => {
    const entries = [
      {
        name: 'folder',
        kind: 'directory' as const,
        sizeBytes: null,
        modifiedAt: null,
      },
      {
        name: 'big.bin',
        kind: 'file' as const,
        sizeBytes: 900,
        modifiedAt: '2026-10-21T08:00:00.000Z',
      },
      {
        name: 'small.txt',
        kind: 'file' as const,
        sizeBytes: 10,
        modifiedAt: '2026-10-23T08:00:00.000Z',
      },
      {
        name: 'unknown.dat',
        kind: 'file' as const,
        sizeBytes: null,
        modifiedAt: null,
      },
    ]

    expect(
      sortRemoteEntriesBy(entries, { field: 'size', direction: 'asc' }).map((item) => item.name),
    ).toEqual(['folder', 'small.txt', 'big.bin', 'unknown.dat'])
    expect(
      sortRemoteEntriesBy(entries, { field: 'size', direction: 'desc' }).map((item) => item.name),
    ).toEqual(['folder', 'big.bin', 'small.txt', 'unknown.dat'])
    expect(
      sortRemoteEntriesBy(entries, { field: 'modified', direction: 'asc' }).map(
        (item) => item.name,
      ),
    ).toEqual(['folder', 'big.bin', 'small.txt', 'unknown.dat'])
    expect(
      sortRemoteEntriesBy(entries, { field: 'modified', direction: 'desc' }).map(
        (item) => item.name,
      ),
    ).toEqual(['folder', 'small.txt', 'big.bin', 'unknown.dat'])
  })

  it('breaks size and time ties by name in both directions', () => {
    const entries = [
      { name: 'b.txt', kind: 'file' as const, sizeBytes: 10, modifiedAt: '2026-10-23T08:00:00Z' },
      { name: 'a.txt', kind: 'file' as const, sizeBytes: 10, modifiedAt: '2026-10-23T08:00:00Z' },
    ]
    expect(
      sortRemoteEntriesBy(entries, { field: 'size', direction: 'desc' }).map((item) => item.name),
    ).toEqual(['a.txt', 'b.txt'])
    expect(
      compareRemoteEntriesBy(entries[0]!, entries[1]!, { field: 'modified', direction: 'desc' }),
    ).toBeGreaterThan(0)
  })
})
