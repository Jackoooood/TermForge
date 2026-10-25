import { describe, expect, it } from 'vitest'
import {
  appendLocalName,
  compareLocalEntries,
  getLocalPathError,
  isAbsoluteLocalPath,
  isLocalPathAtRoot,
  isWindowsStyleLocalPath,
  joinLocalPath,
  localParentPath,
  localPathName,
  normalizeLocalPath,
  resolveLocalPath,
  sortLocalEntries,
  splitLocalBreadcrumbs,
} from '@shared/localFs/localPath'

describe('localPath', () => {
  it('rejects empty, over-long, NUL, control and device-prefixed paths', () => {
    expect(getLocalPathError('')).toContain('不能为空')
    expect(getLocalPathError('a'.repeat(4097))).toContain('4096')
    expect(getLocalPathError('C:\\bad\0name')).toContain('NUL')
    expect(getLocalPathError('C:\\bad\u0001name')).toContain('控制字符')
    expect(getLocalPathError('\\\\?\\C:\\x')).toContain('设备路径前缀')
    expect(getLocalPathError('\\\\.\\pipe\\x')).toContain('设备路径前缀')
    expect(getLocalPathError('C:\\Users\\deploy\\notes.txt')).toBeNull()
  })

  it('normalizes separators, resolves . and .., and uppercases drive letters', () => {
    expect(normalizeLocalPath('c:/Users/./docs/../files')).toBe('C:\\Users\\files')
    expect(normalizeLocalPath('C:\\')).toBe('C:\\')
    expect(normalizeLocalPath('C:\\..\\..')).toBe('C:\\')
    expect(normalizeLocalPath('//unix//path/')).toBe('/unix/path')
    expect(normalizeLocalPath('\\\\server\\share\\a\\..\\b')).toBe('\\\\server\\share\\b')
    expect(normalizeLocalPath('relative\\dir')).toBe('relative/dir')
  })

  it('classifies absolute paths and volume roots', () => {
    expect(isWindowsStyleLocalPath('C:\\Users')).toBe(true)
    expect(isWindowsStyleLocalPath('\\\\server\\share')).toBe(true)
    expect(isWindowsStyleLocalPath('/usr')).toBe(false)
    expect(isAbsoluteLocalPath('/usr')).toBe(true)
    expect(isAbsoluteLocalPath('relative')).toBe(false)

    expect(isLocalPathAtRoot('C:\\')).toBe(true)
    expect(isLocalPathAtRoot('C:\\Users')).toBe(false)
    expect(isLocalPathAtRoot('/')).toBe(true)
    expect(isLocalPathAtRoot('\\\\server\\share')).toBe(true)
    expect(isLocalPathAtRoot('\\\\server\\share\\dir')).toBe(false)
    expect(isLocalPathAtRoot('relative')).toBe(false)
  })

  it('returns null parents only at root or relative paths', () => {
    expect(localParentPath('C:\\')).toBeNull()
    expect(localParentPath('C:\\Users')).toBe('C:\\')
    expect(localParentPath('C:\\Users\\a\\b')).toBe('C:\\Users\\a')
    expect(localParentPath('\\\\server\\share')).toBeNull()
    expect(localParentPath('\\\\server\\share\\dir')).toBe('\\\\server\\share')
    expect(localParentPath('/')).toBeNull()
    expect(localParentPath('/usr/local')).toBe('/usr')
    expect(localParentPath('relative')).toBeNull()
  })

  it('derives entry names and rebuilds breadcrumbs', () => {
    expect(localPathName('C:\\Users\\docs')).toBe('docs')
    expect(localPathName('C:\\')).toBe('')
    expect(localPathName('/')).toBe('')
    expect(localPathName('/usr/local')).toBe('local')

    expect(splitLocalBreadcrumbs('C:\\Users\\docs')).toEqual([
      { label: 'C:\\', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'docs', path: 'C:\\Users\\docs' },
    ])
    expect(splitLocalBreadcrumbs('/usr/local')).toEqual([
      { label: '/', path: '/' },
      { label: 'usr', path: '/usr' },
      { label: 'local', path: '/usr/local' },
    ])
    expect(splitLocalBreadcrumbs('')).toEqual([])
  })

  it('joins typed names with validation but appends filesystem names verbatim', () => {
    expect(joinLocalPath('C:\\Users', 'notes.txt')).toBe('C:\\Users\\notes.txt')
    expect(joinLocalPath('C:\\', 'notes.txt')).toBe('C:\\notes.txt')
    expect(joinLocalPath('/', 'notes.txt')).toBe('/notes.txt')
    expect(() => joinLocalPath('C:\\Users', 'a/b')).toThrow()
    expect(() => joinLocalPath('C:\\Users', '..')).toThrow()
    expect(() => joinLocalPath('', 'notes.txt')).toThrow()

    expect(appendLocalName('C:\\Users', 'a/b')).toBe('C:\\Users\\a/b')
    expect(appendLocalName('C:\\', 'name')).toBe('C:\\name')
    expect(appendLocalName('', 'name')).toBe('name')
  })

  it('resolves typed input against the current directory', () => {
    expect(resolveLocalPath('C:\\Users', 'sub\\file.txt')).toBe('C:\\Users\\sub\\file.txt')
    expect(resolveLocalPath('C:\\Users', '..\\other')).toBe('C:\\other')
    expect(resolveLocalPath('C:\\Users', 'D:/tmp')).toBe('D:\\tmp')
    expect(resolveLocalPath('C:\\Users', '')).toBe('C:\\Users')
    expect(resolveLocalPath('', 'rel')).toBe('/rel')
  })

  it('sorts directories first and honours field, direction and stable ties', () => {
    const directory = { name: 'z-folder', kind: 'directory' as const, sizeBytes: null, modifiedAt: null }
    const small = {
      name: 'small.txt',
      kind: 'file' as const,
      sizeBytes: 1,
      modifiedAt: '2026-10-22T08:00:00.000Z',
    }
    const big = {
      name: 'big.txt',
      kind: 'file' as const,
      sizeBytes: 10,
      modifiedAt: '2026-10-21T08:00:00.000Z',
    }
    const entries = [big, directory, small]

    expect(sortLocalEntries(entries).map((entry) => entry.name)).toEqual([
      'z-folder',
      'big.txt',
      'small.txt',
    ])
    expect(sortLocalEntries(entries, 'size', 'desc').map((entry) => entry.name)).toEqual([
      'z-folder',
      'big.txt',
      'small.txt',
    ])
    expect(sortLocalEntries(entries, 'size', 'asc').map((entry) => entry.name)).toEqual([
      'z-folder',
      'small.txt',
      'big.txt',
    ])
    expect(sortLocalEntries(entries, 'time', 'asc').map((entry) => entry.name)).toEqual([
      'z-folder',
      'big.txt',
      'small.txt',
    ])

    const tieA = { name: 'a.txt', kind: 'file' as const, sizeBytes: 5, modifiedAt: null }
    const tieB = { name: 'b.txt', kind: 'file' as const, sizeBytes: 5, modifiedAt: null }
    expect(sortLocalEntries([tieB, tieA], 'size', 'desc').map((entry) => entry.name)).toEqual([
      'a.txt',
      'b.txt',
    ])
    expect(compareLocalEntries(tieA, tieB, 'name', 'desc')).toBeGreaterThan(0)
  })

  it('orders numeric names naturally', () => {
    const file2 = { name: 'file2.log', kind: 'file' as const, sizeBytes: 1, modifiedAt: null }
    const file10 = { name: 'file10.log', kind: 'file' as const, sizeBytes: 1, modifiedAt: null }
    expect(sortLocalEntries([file10, file2]).map((entry) => entry.name)).toEqual([
      'file2.log',
      'file10.log',
    ])
  })
})