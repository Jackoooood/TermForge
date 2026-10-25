import { useEffect } from 'react'
import { remoteParentPath } from '@shared/sftp/remotePath'
import { isTerminalTransferStatus } from '@shared/types'
import type { TransferTask } from '@shared/types'
import { useSftpStore } from '@renderer/stores/sftpStore'
import { useTransferStore } from '@renderer/stores/transferStore'

const REFRESH_DEBOUNCE_MS = 200

function scheduleRemoteRefresh(
  pending: Map<string, number>,
  sessionId: string,
  remoteDirectory: string,
): void {
  const matchedTabs = Object.values(useSftpStore.getState().tabs).filter(
    (tab) => tab.sessionId === sessionId && tab.path === remoteDirectory,
  )
  for (const tab of matchedTabs) {
    const existing = pending.get(tab.tabId)
    if (existing !== undefined) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      pending.delete(tab.tabId)
      const current = useSftpStore.getState().tabs[tab.tabId]
      if (current?.sessionId !== sessionId || current.path !== remoteDirectory) return
      void useSftpStore.getState().refresh(tab.tabId)
    }, REFRESH_DEBOUNCE_MS)
    pending.set(tab.tabId, timer)
  }
}

/**
 * Mirrors the main-process transfer task stream into the renderer projection.
 * Upload completion or failure refreshes any SFTP tab currently showing the
 * destination directory so partial or new entries are never presented as a
 * stale listing.
 */
export function useTransferBridgeEvents(): void {
  useEffect(() => {
    const bridge = window.termforge
    if (!bridge) return

    const pendingRefreshes = new Map<string, number>()
    const unsubscribe = bridge.transfer.onUpdate((event) => {
      const store = useTransferStore.getState()
      const previous: TransferTask | undefined = store.tasks.find(
        (task) => task.id === event.task.id,
      )
      store.applyTask(event.task)

      const task = event.task
      const changed = !previous || previous.status !== task.status
      if (
        task.direction === 'upload' &&
        isTerminalTransferStatus(task.status) &&
        task.status !== 'skipped' &&
        changed
      ) {
        scheduleRemoteRefresh(
          pendingRefreshes,
          task.sessionId,
          remoteParentPath(task.destinationPath),
        )
      }
    })

    void useTransferStore.getState().sync()

    return () => {
      unsubscribe()
      for (const timer of pendingRefreshes.values()) window.clearTimeout(timer)
      pendingRefreshes.clear()
    }
  }, [])
}
