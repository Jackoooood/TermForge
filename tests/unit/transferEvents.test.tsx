import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { RemoteDirectoryListing, TransferUpdateEvent } from '@shared/types'
import { useTransferBridgeEvents } from '@renderer/hooks/useTransferBridgeEvents'
import { useSftpStore } from '@renderer/stores/sftpStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import { createFakeBridge, fakeTransferTask } from './helpers/fakeBridge'

const TAB = 'tab-sftp-transfer'
const SESSION = 'ssh-transfer-events'

function seedTab(): void {
  useSftpStore.setState({
    tabs: {
      [TAB]: {
        tabId: TAB,
        sessionId: SESSION,
        homePath: '/home/deploy',
        path: '/home/deploy',
        entries: [],
        status: 'ready',
        error: null,
        errorCode: null,
        selectedPath: null,
        selectedPaths: [],
        operation: null,
        requestId: 2,
        tree: { expandedPaths: [], listings: {} },
        sort: { field: 'name', direction: 'asc' },
      },
    },
  })
}

function listing(sessionId: string, path: string): RemoteDirectoryListing {
  return {
    sessionId,
    path,
    entries: [],
    loadedAt: '2026-10-22T08:00:00.000Z',
  }
}

describe('useTransferBridgeEvents', () => {
  beforeEach(() => {
    useTransferStore.getState().reset()
    seedTab()
  })

  afterEach(() => {
    useTransferStore.getState().reset()
    useSftpStore.setState({ tabs: {} })
    delete window.termforge
  })

  it('mirrors task updates and refreshes the upload destination after debounce', async () => {
    let emit: ((event: TransferUpdateEvent) => void) | null = null
    const list = vi.fn(async (sessionId: string, path: string) => ({
      ok: true as const,
      value: listing(sessionId, path),
    }))
    const queued = fakeTransferTask({ sessionId: SESSION, status: 'queued' })
    window.termforge = createFakeBridge(
      {},
      {},
      {},
      { list },
      {
        list: async () => ({ ok: true, value: [queued] }),
        onUpdate: (listener) => {
          emit = listener
          return () => {
            emit = null
          }
        },
      },
    )

    const { unmount } = renderHook(() => useTransferBridgeEvents())
    await waitFor(() => expect(useTransferStore.getState().tasks).toHaveLength(1))

    act(() => {
      emit!({
        task: {
          ...queued,
          status: 'completed',
          progress: 100,
          transferredBytes: 1024,
          revision: 4,
        },
      })
    })
    expect(useTransferStore.getState().tasks[0]?.status).toBe('completed')

    await waitFor(() => expect(list).toHaveBeenCalledWith(SESSION, '/home/deploy'), {
      timeout: 1_500,
    })
    expect(list).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('ignores downloads and skipped uploads and stops timers on unmount', async () => {
    let emit: ((event: TransferUpdateEvent) => void) | null = null
    const list = vi.fn(async (sessionId: string, path: string) => ({
      ok: true as const,
      value: listing(sessionId, path),
    }))
    window.termforge = createFakeBridge(
      {},
      {},
      {},
      { list },
      {
        list: async () => ({ ok: true, value: [] }),
        onUpdate: (listener) => {
          emit = listener
          return () => {
            emit = null
          }
        },
      },
    )

    const { unmount } = renderHook(() => useTransferBridgeEvents())
    await waitFor(() => expect(useTransferStore.getState().syncing).toBe(false))

    const emitTask = (task: ReturnType<typeof fakeTransferTask>): void => {
      act(() => emit!({ task }))
    }

    emitTask(
      fakeTransferTask({
        id: 'transfer-download',
        sessionId: SESSION,
        direction: 'download',
        sourcePath: '/home/deploy/a.txt',
        destinationPath: 'C:\\tmp\\a.txt',
        status: 'completed',
        revision: 2,
      }),
    )
    emitTask(
      fakeTransferTask({
        id: 'transfer-skipped',
        sessionId: SESSION,
        status: 'skipped',
        revision: 2,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(list).not.toHaveBeenCalled()

    emitTask(
      fakeTransferTask({
        id: 'transfer-upload-1',
        sessionId: SESSION,
        status: 'completed',
        revision: 2,
      }),
    )
    emitTask(
      fakeTransferTask({
        id: 'transfer-upload-2',
        sessionId: SESSION,
        status: 'completed',
        revision: 2,
      }),
    )
    unmount()

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(list).not.toHaveBeenCalled()
  })
})
