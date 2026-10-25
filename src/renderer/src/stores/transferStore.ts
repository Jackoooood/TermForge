import { create } from 'zustand'
import type {
  OperationResult,
  TermForgeBridge,
  TransferClearAck,
  TransferConflictPolicy,
  TransferTask,
  TransferUploadEnqueueAck,
} from '@shared/types'
import { isTerminalTransferStatus } from '@shared/types'

interface TransferStoreState {
  tasks: TransferTask[]
  panelOpen: boolean
  syncing: boolean
  syncError: string | null
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  sync: () => Promise<void>
  applyTask: (task: TransferTask) => void
  enqueueUpload: (
    sessionId: string,
    remoteDirectory: string,
  ) => Promise<OperationResult<TransferTask[]>>
  enqueueUploadPaths: (
    sessionId: string,
    remoteDirectory: string,
    localPaths: string[],
  ) => Promise<OperationResult<TransferUploadEnqueueAck>>
  enqueueDownload: (
    sessionId: string,
    remotePaths: string[],
  ) => Promise<OperationResult<TransferTask[]>>
  enqueueDownloadPaths: (
    sessionId: string,
    remotePaths: string[],
    localDirectory: string,
  ) => Promise<OperationResult<TransferTask[]>>
  cancelTask: (transferId: string) => Promise<OperationResult<TransferTask>>
  retryTask: (transferId: string) => Promise<OperationResult<TransferTask>>
  resolveTaskConflict: (
    transferId: string,
    choice: TransferConflictPolicy,
    newName?: string,
  ) => Promise<OperationResult<TransferTask>>
  clearHistory: () => Promise<OperationResult<TransferClearAck>>
  reset: () => void
}

function sortTasks(tasks: TransferTask[]): TransferTask[] {
  return [...tasks].sort((left, right) => {
    if (left.createdAt === right.createdAt) return 0
    return left.createdAt < right.createdAt ? 1 : -1
  })
}

/**
 * Applies a main-process snapshot. The main process is the only writer of task
 * state; a snapshot with an older revision than the local projection is
 * discarded so that a slow IPC response cannot roll the UI back.
 */
function mergeTask(tasks: TransferTask[], incoming: TransferTask): TransferTask[] {
  const index = tasks.findIndex((task) => task.id === incoming.id)
  if (index === -1) return sortTasks([...tasks, incoming])
  if (incoming.revision <= tasks[index]!.revision) return tasks
  const next = [...tasks]
  next[index] = incoming
  return next
}

function mergeTasks(tasks: TransferTask[], incoming: readonly TransferTask[]): TransferTask[] {
  let next = tasks
  for (const task of incoming) next = mergeTask(next, task)
  return next
}

async function runTransferBridge<T>(
  run: (bridge: TermForgeBridge) => Promise<OperationResult<T>>,
  failureMessage: string,
): Promise<OperationResult<T>> {
  const bridge = window.termforge
  if (!bridge) {
    return {
      ok: false,
      error: { code: 'unavailable', message: '未加载 Electron preload bridge，无法访问传输队列。' },
    }
  }
  try {
    return await run(bridge)
  } catch {
    return { ok: false, error: { code: 'internal', message: failureMessage } }
  }
}

export const useTransferStore = create<TransferStoreState>((set) => {
  const applyEnqueued = (created: TransferTask[]): void => {
    if (created.length === 0) return
    set((state) => ({
      tasks: mergeTasks(state.tasks, created),
      panelOpen: true,
    }))
  }

  const runTaskAction = async (
    transferId: string,
    run: (bridge: TermForgeBridge) => Promise<OperationResult<TransferTask>>,
    failureMessage: string,
  ): Promise<OperationResult<TransferTask>> => {
    const result = await runTransferBridge(run, failureMessage)
    if (result.ok) {
      set((state) => ({ tasks: mergeTask(state.tasks, result.value) }))
    }
    return result
  }

  return {
    tasks: [],
    panelOpen: false,
    syncing: false,
    syncError: null,

    setPanelOpen: (panelOpen) => set({ panelOpen }),

    togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

    sync: async () => {
      const bridge = window.termforge
      if (!bridge) {
        set({
          syncing: false,
          syncError: '未加载 Electron preload bridge，无法同步传输任务。',
        })
        return
      }
      set({ syncing: true, syncError: null })
      try {
        const result = await bridge.transfer.list()
        if (!result.ok) {
          set({ syncing: false, syncError: result.error.message })
          return
        }
        set((state) => ({
          tasks: mergeTasks(state.tasks, result.value),
          syncing: false,
          syncError: null,
        }))
      } catch {
        set({ syncing: false, syncError: '读取传输任务失败，请稍后重试。' })
      }
    },

    applyTask: (incoming) => {
      set((state) => {
        const previous = state.tasks.find((task) => task.id === incoming.id)
        const nextTasks = mergeTask(state.tasks, incoming)
        if (nextTasks === state.tasks) return state
        const needsAttention =
          incoming.status === 'waitingForConflictResolution' &&
          previous?.status !== 'waitingForConflictResolution'
        return {
          tasks: nextTasks,
          panelOpen: needsAttention ? true : state.panelOpen,
        }
      })
    },

    enqueueUpload: async (sessionId, remoteDirectory) => {
      const result = await runTransferBridge(
        (bridge) => bridge.transfer.enqueueUpload(sessionId, remoteDirectory),
        '上传请求失败，请稍后重试。',
      )
      if (result.ok) applyEnqueued(result.value)
      return result
    },

    enqueueUploadPaths: async (sessionId, remoteDirectory, localPaths) => {
      const result = await runTransferBridge(
        (bridge) => bridge.transfer.enqueueUploadPaths(sessionId, remoteDirectory, localPaths),
        '上传请求失败，请稍后重试。',
      )
      if (result.ok) applyEnqueued(result.value.tasks)
      return result
    },

    enqueueDownload: async (sessionId, remotePaths) => {
      const result = await runTransferBridge(
        (bridge) => bridge.transfer.enqueueDownload(sessionId, remotePaths),
        '下载请求失败，请稍后重试。',
      )
      if (result.ok) applyEnqueued(result.value)
      return result
    },

    enqueueDownloadPaths: async (sessionId, remotePaths, localDirectory) => {
      const result = await runTransferBridge(
        (bridge) => bridge.transfer.enqueueDownloadPaths(sessionId, remotePaths, localDirectory),
        '下载请求失败，请稍后重试。',
      )
      if (result.ok) applyEnqueued(result.value)
      return result
    },

    cancelTask: (transferId) =>
      runTaskAction(
        transferId,
        (bridge) => bridge.transfer.cancel(transferId),
        '取消传输请求失败，请稍后重试。',
      ),

    retryTask: (transferId) =>
      runTaskAction(
        transferId,
        (bridge) => bridge.transfer.retry(transferId),
        '重试传输请求失败，请稍后重试。',
      ),

    resolveTaskConflict: (transferId, choice, newName) =>
      runTaskAction(
        transferId,
        (bridge) => bridge.transfer.resolveConflict(transferId, choice, newName),
        '处理文件冲突失败，请稍后重试。',
      ),

    clearHistory: async () => {
      const result = await runTransferBridge(
        (bridge) => bridge.transfer.clearHistory(),
        '清空传输记录失败，请稍后重试。',
      )
      if (result.ok) {
        set((state) => ({
          tasks: state.tasks.filter((task) => !isTerminalTransferStatus(task.status)),
          syncError: null,
        }))
      }
      return result
    },

    reset: () => set({ tasks: [], panelOpen: false, syncing: false, syncError: null }),
  }
})
