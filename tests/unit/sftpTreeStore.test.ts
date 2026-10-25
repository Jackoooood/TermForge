import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperationResult, RemoteDirectoryListing, RemoteFileEntry } from '@shared/types'
import { useSftpStore } from '@renderer/stores/sftpStore'
import { createFakeBridge } from './helpers/fakeBridge'

const TAB = 'tab-tree'
const SESSION = 'ssh-tree'

function entry(
  directory: string,
  name: string,
  kind: RemoteFileEntry['kind'] = 'file',
): RemoteFileEntry {
  return {
    id: `${directory}/${name}`,
    name,
    path: `${directory}/${name}`,
    kind,
    sizeBytes: kind === 'file' ? 10 : null,
    modifiedAt: '2026-10-22T08:00:00.000Z',
    permissions: kind === 'directory' ? 'drwxr-xr-x' : '-rw-r--r--',
  }
}

function listing(
  path: string,
  entries: RemoteFileEntry[],
): OperationResult<RemoteDirectoryListing> {
  return {
    ok: true,
    value: { sessionId: SESSION, path, entries, loadedAt: '2026-10-22T08:00:00.000Z' },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn
  })
  return { promise, resolve }
}

describe('sftpStore tree and sorting', () => {
  beforeEach(() => {
    useSftpStore.getState().reset()
  })

  afterEach(() => {
    delete window.termforge
  })

  async function openTab(
    list: (sessionId: string, path: string) => Promise<OperationResult<RemoteDirectoryListing>>,
  ): Promise<void> {
    window.termforge = createFakeBridge({}, {}, {}, { list })
    await useSftpStore.getState().open(TAB, SESSION)
    expect(useSftpStore.getState().tabs[TAB]?.status).toBe('ready')
  }

  it('lazily lists only directories and caches ready listings', async () => {
    const list = vi.fn(async (_sessionId: string, path: string) =>
      path === '/srv'
        ? listing('/srv', [
            entry('/srv', 'zeta', 'directory'),
            entry('/srv', 'notes.txt'),
            entry('/srv', 'alpha', 'directory'),
          ])
        : listing(path, []),
    )
    await openTab(list)

    await useSftpStore.getState().loadTreeDirectory(TAB, SESSION, '/srv')
    const treeListing = useSftpStore.getState().tabs[TAB]?.tree.listings['/srv']
    expect(treeListing?.status).toBe('ready')
    expect(treeListing?.directories.map((item) => item.name)).toEqual(['alpha', 'zeta'])

    const callsAfterFirstLoad = list.mock.calls.length
    await useSftpStore.getState().loadTreeDirectory(TAB, SESSION, '/srv')
    expect(list.mock.calls.length).toBe(callsAfterFirstLoad)

    await useSftpStore.getState().loadTreeDirectory(TAB, SESSION, '/srv', { force: true })
    expect(list.mock.calls.length).toBe(callsAfterFirstLoad + 1)
  })

  it('keeps the latest forced tree response when an older request resolves late', async () => {
    const first = deferred<OperationResult<RemoteDirectoryListing>>()
    const second = deferred<OperationResult<RemoteDirectoryListing>>()
    let treeCalls = 0
    const list = vi.fn(async (_sessionId: string, path: string) => {
      if (path !== '/srv') return listing(path, [])
      treeCalls += 1
      return treeCalls === 1 ? first.promise : second.promise
    })
    await openTab(list)

    const staleLoad = useSftpStore.getState().loadTreeDirectory(TAB, SESSION, '/srv', { force: true })
    const freshLoad = useSftpStore.getState().loadTreeDirectory(TAB, SESSION, '/srv', { force: true })

    second.resolve(listing('/srv', [entry('/srv', 'fresh', 'directory')]))
    await freshLoad
    first.resolve(listing('/srv', [entry('/srv', 'stale', 'directory')]))
    await staleLoad

    expect(
      useSftpStore.getState().tabs[TAB]?.tree.listings['/srv']?.directories.map((item) => item.name),
    ).toEqual(['fresh'])
  })

  it('stores tree errors and refreshes expanded paths plus the current directory', async () => {
    const list = vi.fn(async (_sessionId: string, path: string) => {
      if (path === '/srv') {
        return {
          ok: false as const,
          error: { code: 'permission-denied' as const, message: '权限不足' },
        }
      }
      return listing(path, [])
    })
    await openTab(list)

    await useSftpStore.getState().loadTreeDirectory(TAB, SESSION, '/srv')
    const failed = useSftpStore.getState().tabs[TAB]?.tree.listings['/srv']
    expect(failed?.status).toBe('error')
    expect(failed?.errorCode).toBe('permission-denied')

    list.mockClear()
    useSftpStore.getState().setTreeExpanded(TAB, '/var/www', true)
    useSftpStore.getState().setTreeExpanded(TAB, '/srv', true)
    await useSftpStore.getState().refreshTree(TAB, SESSION)
    const requested = list.mock.calls.map((call) => call[1])
    expect(requested).toContain('/home/deploy')
    expect(requested).toContain('/var/www')
    expect(requested).toContain('/srv')
  })

  it('normalizes expansion paths and toggles sort direction on repeated fields', async () => {
    const list = vi.fn(async (_sessionId: string, path: string) => listing(path, []))
    await openTab(list)

    useSftpStore.getState().setTreeExpanded(TAB, '//var//www/', true)
    expect(useSftpStore.getState().tabs[TAB]?.tree.expandedPaths).toEqual(['/var/www'])
    useSftpStore.getState().setTreeExpanded(TAB, '/var/www', false)
    expect(useSftpStore.getState().tabs[TAB]?.tree.expandedPaths).toEqual([])

    expect(useSftpStore.getState().tabs[TAB]?.sort).toEqual({ field: 'name', direction: 'asc' })
    useSftpStore.getState().setSort(TAB, 'size')
    expect(useSftpStore.getState().tabs[TAB]?.sort).toEqual({ field: 'size', direction: 'asc' })
    useSftpStore.getState().setSort(TAB, 'size')
    expect(useSftpStore.getState().tabs[TAB]?.sort).toEqual({ field: 'size', direction: 'desc' })
    useSftpStore.getState().setSort(TAB, 'modified')
    expect(useSftpStore.getState().tabs[TAB]?.sort).toEqual({
      field: 'modified',
      direction: 'asc',
    })
  })
})
