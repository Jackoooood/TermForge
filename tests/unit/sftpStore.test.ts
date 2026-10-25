import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OperationResult,
  RemoteDirectoryListing,
  RemoteFileEntry,
  SftpMutationAck,
} from '@shared/types'
import { useSftpStore } from '@renderer/stores/sftpStore'
import { createFakeBridge } from './helpers/fakeBridge'

const TAB = 'sshtab-1'
const SESSION_A = 'ssh-session-a'
const SESSION_B = 'ssh-session-b'

function entry(
  name: string,
  kind: RemoteFileEntry['kind'] = 'file',
  directory = '/home/deploy',
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
  sessionId: string,
  path: string,
  entries: RemoteFileEntry[] = [],
): OperationResult<RemoteDirectoryListing> {
  return {
    ok: true,
    value: { sessionId, path, entries, loadedAt: '2026-10-22T08:00:00.000Z' },
  }
}

function openResult(
  sessionId: string,
  homePath = '/home/deploy',
): OperationResult<{ sessionId: string; homePath: string }> {
  return { ok: true, value: { sessionId, homePath } }
}

function mutationAck(
  sessionId: string,
  path: string,
  operation: SftpMutationAck['operation'] = 'mkdir',
): OperationResult<SftpMutationAck> {
  return { ok: true, value: { sessionId, path, operation } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn
    reject = rejectFn
  })
  return { promise, resolve, reject }
}

function setupBridge(sftp: Parameters<typeof createFakeBridge>[3] = {}) {
  const bridge = createFakeBridge({}, {}, {}, sftp)
  window.termforge = bridge
  return bridge
}

describe('sftpStore', () => {
  beforeEach(() => {
    useSftpStore.getState().reset()
  })

  afterEach(() => {
    useSftpStore.getState().reset()
    delete window.termforge
  })

  it('opens the session, lists the home directory and marks the tab ready', async () => {
    const home = entry('notes.txt')
    const open = vi.fn().mockResolvedValue(openResult(SESSION_A))
    const list = vi.fn().mockResolvedValue(listing(SESSION_A, '/home/deploy', [home]))
    setupBridge({ open, list })

    await useSftpStore.getState().open(TAB, SESSION_A)

    expect(open).toHaveBeenCalledWith(SESSION_A)
    expect(list).toHaveBeenCalledWith(SESSION_A, '/home/deploy')
    const tab = useSftpStore.getState().tabs[TAB]
    expect(tab).toMatchObject({
      sessionId: SESSION_A,
      homePath: '/home/deploy',
      path: '/home/deploy',
      status: 'ready',
      error: null,
      errorCode: null,
    })
    expect(tab?.entries).toEqual([home])

    await useSftpStore.getState().open(TAB, SESSION_A)
    expect(open).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('resets the tab when switching to another SSH session', async () => {
    const open = vi.fn(async (sessionId: string) =>
      openResult(sessionId, sessionId === SESSION_A ? '/home/a' : '/home/b'),
    )
    const list = vi.fn(async (sessionId: string, path: string) =>
      listing(sessionId, path, [entry(sessionId === SESSION_A ? 'a.txt' : 'b.txt', 'file', path)]),
    )
    setupBridge({ open, list })

    await useSftpStore.getState().open(TAB, SESSION_A)
    useSftpStore.getState().select(TAB, '/home/a/a.txt')
    await useSftpStore.getState().open(TAB, SESSION_B)

    const tab = useSftpStore.getState().tabs[TAB]
    expect(tab).toMatchObject({
      sessionId: SESSION_B,
      homePath: '/home/b',
      path: '/home/b',
      status: 'ready',
      selectedPath: null,
    })
    expect(tab?.entries.map((item) => item.name)).toEqual(['b.txt'])
    expect(open).toHaveBeenNthCalledWith(2, SESSION_B)
    expect(list).toHaveBeenLastCalledWith(SESSION_B, '/home/b')
  })

  it('drops a late directory response when a newer path was requested', async () => {
    const slow = deferred<OperationResult<RemoteDirectoryListing>>()
    let slowStarted = false
    const list = vi.fn(async (sessionId: string, path: string) => {
      if (path === '/srv/slow') {
        slowStarted = true
        return slow.promise
      }
      return listing(sessionId, path, [entry('current.txt', 'file', path)])
    })
    setupBridge({ list })

    await useSftpStore.getState().open(TAB, SESSION_A)
    const oldLoad = useSftpStore.getState().load(TAB, SESSION_A, '/srv/slow')
    await vi.waitFor(() => expect(slowStarted).toBe(true))

    await expect(useSftpStore.getState().load(TAB, SESSION_A, '/srv/fresh')).resolves.toBe(true)
    slow.resolve(listing(SESSION_A, '/srv/slow', [entry('stale.txt', 'file', '/srv/slow')]))

    await expect(oldLoad).resolves.toBe(false)
    const tab = useSftpStore.getState().tabs[TAB]
    expect(tab?.path).toBe('/srv/fresh')
    expect(tab?.entries.map((item) => item.name)).toEqual(['current.txt'])
  })

  it('drops a response from a session that has already been replaced', async () => {
    const staleList = deferred<OperationResult<RemoteDirectoryListing>>()
    const list = vi.fn(async (sessionId: string, path: string) => {
      if (sessionId === SESSION_A) return staleList.promise
      return listing(sessionId, path, [entry('b.txt', 'file', path)])
    })
    const open = vi.fn(async (sessionId: string) =>
      openResult(sessionId, sessionId === SESSION_A ? '/home/a' : '/home/b'),
    )
    setupBridge({ open, list })

    await useSftpStore.setState({
      tabs: {
        [TAB]: {
          tabId: TAB,
          sessionId: SESSION_A,
          homePath: '/home/a',
          path: '/home/a',
          entries: [],
          status: 'ready',
          error: null,
          errorCode: null,
          selectedPath: null,
          selectedPaths: [],
          operation: null,
          requestId: 1,
          tree: { expandedPaths: [], listings: {} },
          sort: { field: 'name', direction: 'asc' },
        },
      },
    })

    const oldLoad = useSftpStore.getState().load(TAB, SESSION_A, '/home/a/late')
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith(SESSION_A, '/home/a/late'))
    await useSftpStore.getState().open(TAB, SESSION_B)
    staleList.resolve(listing(SESSION_A, '/home/a/late', [entry('stale.txt', 'file')]))

    await expect(oldLoad).resolves.toBe(false)
    const tab = useSftpStore.getState().tabs[TAB]
    expect(tab).toMatchObject({ sessionId: SESSION_B, homePath: '/home/b', path: '/home/b' })
    expect(tab?.entries.map((item) => item.name)).toEqual(['b.txt'])
  })

  it('rejects a load whose session does not own the tab without touching the bridge', async () => {
    setupBridge()
    await useSftpStore.getState().open(TAB, SESSION_A)
    const list = vi.fn()
    window.termforge = createFakeBridge({}, {}, {}, { list })

    await expect(useSftpStore.getState().load(TAB, SESSION_B, '/srv/app')).resolves.toBe(false)
    expect(list).not.toHaveBeenCalled()
    expect(useSftpStore.getState().tabs[TAB]?.sessionId).toBe(SESSION_A)
  })

  it('maps unavailable errors to disconnected and other failures to error', async () => {
    setupBridge({
      open: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'unavailable', message: 'SSH 会话已断开。' },
      }),
    })
    await useSftpStore.getState().open(TAB, SESSION_A)
    expect(useSftpStore.getState().tabs[TAB]).toMatchObject({
      status: 'disconnected',
      error: 'SSH 会话已断开。',
      errorCode: 'unavailable',
    })

    useSftpStore.getState().reset()
    setupBridge({
      list: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'not-a-directory', message: '该路径不是目录。' },
      }),
    })
    await useSftpStore.getState().open(TAB, SESSION_A)
    expect(useSftpStore.getState().tabs[TAB]).toMatchObject({
      status: 'error',
      error: '该路径不是目录。',
      errorCode: 'not-a-directory',
    })
  })

  it('reports an internal error when the bridge request throws', async () => {
    setupBridge({
      open: vi.fn().mockRejectedValue(new Error('ipc broken')),
    })
    await useSftpStore.getState().open(TAB, SESSION_A)
    expect(useSftpStore.getState().tabs[TAB]).toMatchObject({
      status: 'error',
      errorCode: 'internal',
    })
  })

  it('marks the tab unavailable without a preload bridge and retries later', async () => {
    delete window.termforge
    await useSftpStore.getState().open(TAB, SESSION_A)
    expect(useSftpStore.getState().tabs[TAB]).toMatchObject({
      status: 'error',
      errorCode: 'unavailable',
    })

    setupBridge()
    await useSftpStore.getState().retry(TAB, SESSION_A)
    expect(useSftpStore.getState().tabs[TAB]?.status).toBe('ready')
  })

  it('rejects invalid remote paths before calling the bridge', async () => {
    const list = vi.fn()
    setupBridge({ list })
    await useSftpStore.getState().open(TAB, SESSION_A)

    await expect(useSftpStore.getState().load(TAB, SESSION_A, '/srv/\0bad')).resolves.toBe(false)
    expect(list).toHaveBeenCalledTimes(1)
    expect(useSftpStore.getState().tabs[TAB]).toMatchObject({
      status: 'error',
      errorCode: 'invalid-input',
    })
  })

  it('reloads the same path while preserving entries during refresh', async () => {
    const entries = [entry('a.txt'), entry('b.txt')]
    const list = vi.fn(async (sessionId: string, path: string) => listing(sessionId, path, entries))
    setupBridge({ list })
    await useSftpStore.getState().open(TAB, SESSION_A)
    useSftpStore.getState().select(TAB, entries[1]!.path)

    const load = useSftpStore.getState().refresh(TAB)
    expect(useSftpStore.getState().tabs[TAB]).toMatchObject({
      status: 'loading',
      path: '/home/deploy',
      selectedPath: entries[1]!.path,
    })
    expect(useSftpStore.getState().tabs[TAB]?.entries).toEqual(entries)
    await expect(load).resolves.toBe(true)
    expect(useSftpStore.getState().tabs[TAB]?.selectedPath).toBe(entries[1]!.path)
  })

  it('clears the selection when the refreshed directory no longer contains it', async () => {
    const original = [entry('a.txt'), entry('b.txt')]
    const next = [entry('b.txt')]
    let current = original
    setupBridge({
      list: vi.fn(async (sessionId: string, path: string) => listing(sessionId, path, current)),
    })
    await useSftpStore.getState().open(TAB, SESSION_A)
    useSftpStore.getState().select(TAB, original[0]!.path)

    current = next
    await useSftpStore.getState().refresh(TAB)
    expect(useSftpStore.getState().tabs[TAB]?.selectedPath).toBeNull()
  })

  it('runs mkdir and exposes a transient running operation', async () => {
    const gate = deferred<OperationResult<SftpMutationAck>>()
    const mkdir = vi.fn(() => gate.promise)
    setupBridge({ mkdir })
    await useSftpStore.getState().open(TAB, SESSION_A)

    const operation = useSftpStore.getState().mkdir(TAB, SESSION_A, '/home/deploy', 'releases')
    expect(useSftpStore.getState().tabs[TAB]?.operation).toMatchObject({
      kind: 'mkdir',
      path: '/home/deploy',
      status: 'running',
    })
    expect(mkdir).toHaveBeenCalledWith(SESSION_A, '/home/deploy', 'releases')

    gate.resolve(mutationAck(SESSION_A, '/home/deploy/releases'))
    await expect(operation).resolves.toMatchObject({ ok: true })
    expect(useSftpStore.getState().tabs[TAB]?.operation).toBeNull()
  })

  it('keeps a failed mutation visible with its error code', async () => {
    setupBridge({
      mkdir: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'already-exists', message: '同名目录已存在。' },
      }),
    })
    await useSftpStore.getState().open(TAB, SESSION_A)

    const result = await useSftpStore.getState().mkdir(TAB, SESSION_A, '/home/deploy', 'releases')
    expect(result).toMatchObject({ ok: false, error: { code: 'already-exists' } })
    expect(useSftpStore.getState().tabs[TAB]?.operation).toMatchObject({
      kind: 'mkdir',
      status: 'error',
      error: '同名目录已存在。',
      errorCode: 'already-exists',
    })

    useSftpStore.getState().clearOperation(TAB)
    expect(useSftpStore.getState().tabs[TAB]?.operation).toBeNull()
  })

  it('surfaces outcome-unknown without clearing it automatically', async () => {
    setupBridge({
      rename: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'outcome-unknown',
          message: '重命名操作超时，无法确认服务器是否已执行。',
        },
      }),
    })
    await useSftpStore.getState().open(TAB, SESSION_A)

    const result = await useSftpStore
      .getState()
      .renamePath(TAB, SESSION_A, '/home/deploy/a.txt', '/home/deploy/b.txt')
    expect(result).toMatchObject({ ok: false, error: { code: 'outcome-unknown' } })
    expect(useSftpStore.getState().tabs[TAB]?.operation).toMatchObject({
      kind: 'rename',
      status: 'error',
      errorCode: 'outcome-unknown',
    })
  })

  it('routes directory deletion to removeDirectory and files to deleteFile', async () => {
    const deleteFile = vi.fn(async (sessionId: string, path: string) =>
      mutationAck(sessionId, path, 'delete-file'),
    )
    const removeDirectory = vi.fn(async (sessionId: string, path: string) =>
      mutationAck(sessionId, path, 'remove-directory'),
    )
    setupBridge({ deleteFile, removeDirectory })
    await useSftpStore.getState().open(TAB, SESSION_A)

    await useSftpStore
      .getState()
      .deleteEntry(TAB, SESSION_A, entry('notes.txt', 'file', '/home/deploy'))
    await useSftpStore
      .getState()
      .deleteEntry(TAB, SESSION_A, entry('release', 'directory', '/home/deploy'))
    await useSftpStore
      .getState()
      .deleteEntry(TAB, SESSION_A, entry('current', 'symlink', '/home/deploy'))

    expect(deleteFile).toHaveBeenNthCalledWith(1, SESSION_A, '/home/deploy/notes.txt')
    expect(deleteFile).toHaveBeenNthCalledWith(2, SESSION_A, '/home/deploy/current')
    expect(removeDirectory).toHaveBeenCalledWith(SESSION_A, '/home/deploy/release')
  })

  it('refuses mutations for a mismatched session or a tab that is not ready', async () => {
    const mkdir = vi.fn()
    setupBridge({ mkdir })
    await useSftpStore.getState().open(TAB, SESSION_A)

    await expect(
      useSftpStore.getState().mkdir(TAB, SESSION_B, '/home/deploy', 'x'),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } })

    useSftpStore.setState((state) => ({
      tabs: { ...state.tabs, [TAB]: { ...state.tabs[TAB]!, status: 'loading' } },
    }))
    await expect(
      useSftpStore.getState().mkdir(TAB, SESSION_A, '/home/deploy', 'x'),
    ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('reports a bridge-level failure for mutations when preload is missing', async () => {
    await useSftpStore.setState({
      tabs: {
        [TAB]: {
          tabId: TAB,
          sessionId: SESSION_A,
          homePath: '/home/deploy',
          path: '/home/deploy',
          entries: [],
          status: 'ready',
          error: null,
          errorCode: null,
          selectedPath: null,
          selectedPaths: [],
          operation: null,
          requestId: 1,
          tree: { expandedPaths: [], listings: {} },
          sort: { field: 'name', direction: 'asc' },
        },
      },
    })
    delete window.termforge

    await expect(
      useSftpStore.getState().deleteEntry(TAB, SESSION_A, {
        ...entry('a.txt'),
        path: '/home/deploy/a.txt',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(useSftpStore.getState().tabs[TAB]?.operation).toMatchObject({
      errorCode: 'unavailable',
    })
  })

  it('forgets a tab without touching its neighbours and resets everything', async () => {
    setupBridge()
    await useSftpStore.getState().open(TAB, SESSION_A)
    useSftpStore.getState().setActiveTab(TAB)

    useSftpStore.getState().forgetTab(TAB)
    expect(useSftpStore.getState().tabs[TAB]).toBeUndefined()
    expect(useSftpStore.getState().activeTabId).toBeNull()

    useSftpStore.getState().forgetTab('missing')
    expect(useSftpStore.getState().tabs).toEqual({})

    await useSftpStore.getState().open(TAB, SESSION_A)
    useSftpStore.getState().setActiveTab(TAB)
    useSftpStore.getState().reset()
    expect(useSftpStore.getState().tabs).toEqual({})
    expect(useSftpStore.getState().activeTabId).toBeNull()
  })
})
