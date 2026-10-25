import { create } from 'zustand'
import type {
  CommandHistoryClearAck,
  CommandHistoryEntry,
  OperationError,
  OperationResult,
  QuickCommand,
  QuickCommandDraft,
  QuickCommandExecuteAck,
  QuickCommandExecuteInput,
} from '@shared/types'
import { isQuickCommandTargetSendable } from '@renderer/lib/quickCommandTargets'
import { flushTerminalInput, insertTerminalInput } from '@renderer/services/terminalRuntime'
import { useSessionStore } from './sessionStore'
import { useTerminalStore } from './terminalStore'
import { useWorkspaceStore } from './workspaceStore'

export type QuickCommandLoadStatus = 'idle' | 'loading' | 'ready' | 'error'
export type QuickCommandPane = 'library' | 'history'
export type QuickCommandIntent = 'insert' | 'send'

export interface CapturedQuickCommandTarget {
  tabId: string
  sessionId: string
}

export type QuickCommandSourceReference =
  { kind: 'command'; commandId: string } | { kind: 'history'; entryId: string }

export interface QuickCommandComposeRequest {
  intent: QuickCommandIntent
  source: QuickCommandSourceReference
}

export interface QuickCommandEditorRequest {
  /** null creates a new custom command. */
  commandId: string | null
}

export interface QuickCommandActionResult<T> {
  ok: boolean
  value?: T
  error?: OperationError
}

interface QuickCommandStoreState {
  drawerOpen: boolean
  activePane: QuickCommandPane
  search: string
  commands: QuickCommand[]
  commandsStatus: QuickCommandLoadStatus
  commandsError: string | null
  history: CommandHistoryEntry[]
  historyStatus: QuickCommandLoadStatus
  historyError: string | null
  capturedTarget: CapturedQuickCommandTarget | null
  editor: QuickCommandEditorRequest | null
  compose: QuickCommandComposeRequest | null
  openDrawer: (tabId?: string | null, pane?: QuickCommandPane) => void
  closeDrawer: () => void
  captureActiveTarget: () => void
  setActivePane: (pane: QuickCommandPane) => void
  setSearch: (value: string) => void
  refreshCommands: () => Promise<void>
  refreshHistory: () => Promise<void>
  openEditor: (commandId: string | null) => void
  closeEditor: () => void
  saveCommand: (
    input: QuickCommandDraft,
    commandId: string | null,
  ) => Promise<OperationResult<QuickCommand>>
  removeCommand: (id: string) => Promise<OperationResult<{ id: string }>>
  toggleFavorite: (command: QuickCommand) => Promise<OperationResult<QuickCommand>>
  openCompose: (intent: QuickCommandIntent, source: QuickCommandSourceReference) => void
  closeCompose: () => void
  insertQuickCommand: (
    tabId: string,
    sessionId: string,
    body: string,
  ) => Promise<QuickCommandActionResult<{ inserted: true }>>
  executeQuickCommand: (
    input: QuickCommandExecuteInput,
  ) => Promise<OperationResult<QuickCommandExecuteAck>>
  removeHistoryEntry: (id: string) => Promise<OperationResult<{ id: string }>>
  clearHistory: () => Promise<OperationResult<CommandHistoryClearAck>>
  reset: () => void
}

function errorResult(message: string): OperationResult<never> {
  return { ok: false, error: { code: 'unavailable', message } }
}

function bridgeUnavailable(): OperationResult<never> {
  return errorResult('未加载 Electron preload bridge，快速命令不可用。')
}

function targetUnavailable(message: string): QuickCommandActionResult<never> {
  return { ok: false, error: { code: 'unavailable', message } }
}

function withCaughtError<T>(error: unknown, fallback: string): OperationResult<T> {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim().length > 0) {
      return { ok: false, error: { code: 'internal', message } }
    }
  }
  return { ok: false, error: { code: 'internal', message: fallback } }
}

function isTargetStillValid(tabId: string, sessionId: string): boolean {
  const session = useSessionStore.getState().sessions[tabId]
  const shell = useTerminalStore.getState().shells[tabId]
  return isQuickCommandTargetSendable(session, shell) && session?.sessionId === sessionId
}

function captureSendableTarget(
  tabId: string | null | undefined,
): CapturedQuickCommandTarget | null {
  const session = tabId ? useSessionStore.getState().sessions[tabId] : undefined
  const shell = tabId ? useTerminalStore.getState().shells[tabId] : undefined
  if (!session?.sessionId || !isQuickCommandTargetSendable(session, shell)) return null
  return { tabId: session.id, sessionId: session.sessionId }
}

function upsertCommand(commands: QuickCommand[], command: QuickCommand): QuickCommand[] {
  const index = commands.findIndex((item) => item.id === command.id)
  if (index === -1) return [...commands, command]
  const next = [...commands]
  next[index] = command
  return next
}

export const useQuickCommandStore = create<QuickCommandStoreState>((set, get) => ({
  drawerOpen: false,
  activePane: 'library',
  search: '',
  commands: [],
  commandsStatus: 'idle',
  commandsError: null,
  history: [],
  historyStatus: 'idle',
  historyError: null,
  capturedTarget: null,
  editor: null,
  compose: null,

  openDrawer: (tabId, pane) => {
    const workspace = useWorkspaceStore.getState()
    const capturedTarget = captureSendableTarget(tabId ?? workspace.activeTabId)

    set({
      drawerOpen: true,
      activePane: pane ?? 'library',
      search: '',
      capturedTarget,
      editor: null,
      compose: null,
    })
    void get().refreshCommands()
    void get().refreshHistory()
  },

  closeDrawer: () => {
    set({ drawerOpen: false, editor: null, compose: null, capturedTarget: null })
  },

  captureActiveTarget: () => {
    const workspace = useWorkspaceStore.getState()
    const capturedTarget = captureSendableTarget(workspace.activeTabId)
    if (capturedTarget) set({ capturedTarget })
  },

  setActivePane: (activePane) => {
    set({ activePane, search: '' })
    if (activePane === 'history') void get().refreshHistory()
  },

  setSearch: (search) => set({ search }),

  refreshCommands: async () => {
    const bridge = window.termforge?.quickCommands
    if (!bridge) {
      set({
        commandsStatus: 'error',
        commandsError: '未加载 Electron preload bridge，无法读取快速命令。',
      })
      return
    }
    if (get().commandsStatus === 'loading') return
    set({ commandsStatus: 'loading', commandsError: null })
    try {
      const result = await bridge.list()
      if (!result.ok) {
        set({ commandsStatus: 'error', commandsError: result.error.message })
        return
      }
      set({ commands: result.value.commands, commandsStatus: 'ready', commandsError: null })
    } catch {
      set({ commandsStatus: 'error', commandsError: '读取快速命令失败，请稍后重试。' })
    }
  },

  refreshHistory: async () => {
    const bridge = window.termforge?.commandHistory
    if (!bridge) {
      set({
        historyStatus: 'error',
        historyError: '未加载 Electron preload bridge，无法读取命令历史。',
      })
      return
    }
    if (get().historyStatus === 'loading') return
    set({ historyStatus: 'loading', historyError: null })
    try {
      const result = await bridge.list()
      if (!result.ok) {
        set({ historyStatus: 'error', historyError: result.error.message })
        return
      }
      set({ history: result.value.entries, historyStatus: 'ready', historyError: null })
    } catch {
      set({ historyStatus: 'error', historyError: '读取命令历史失败，请稍后重试。' })
    }
  },

  openEditor: (commandId) => set({ editor: { commandId } }),

  closeEditor: () => set({ editor: null }),

  saveCommand: async (input, commandId) => {
    const bridge = window.termforge?.quickCommands
    if (!bridge) return bridgeUnavailable()
    try {
      const result = commandId ? await bridge.update(commandId, input) : await bridge.create(input)
      if (!result.ok) return result
      set((state) => ({ commands: upsertCommand(state.commands, result.value) }))
      void get().refreshCommands()
      return result
    } catch (error) {
      return withCaughtError(error, '保存快速命令失败，请稍后重试。')
    }
  },

  removeCommand: async (id) => {
    const bridge = window.termforge?.quickCommands
    if (!bridge) return bridgeUnavailable()
    try {
      const result = await bridge.remove(id)
      if (!result.ok) return result
      set((state) => ({
        commands: state.commands.filter((command) => command.id !== id),
        editor: state.editor?.commandId === id ? null : state.editor,
      }))
      return result
    } catch (error) {
      return withCaughtError(error, '删除快速命令失败，请稍后重试。')
    }
  },

  toggleFavorite: async (command) => {
    const bridge = window.termforge?.quickCommands
    if (!bridge) return bridgeUnavailable()
    try {
      const result = await bridge.setFavorite(command.id, !command.favorite)
      if (!result.ok) return result
      set((state) => ({ commands: upsertCommand(state.commands, result.value) }))
      return result
    } catch (error) {
      return withCaughtError(error, '更新收藏失败，请稍后重试。')
    }
  },

  openCompose: (intent, source) => set({ compose: { intent, source } }),

  closeCompose: () => set({ compose: null }),

  insertQuickCommand: async (tabId, sessionId, body) => {
    if (!isTargetStillValid(tabId, sessionId)) {
      return targetUnavailable('目标终端已变化或不可用，命令未插入。请重新选择终端。')
    }
    try {
      const inserted = await insertTerminalInput(tabId, sessionId, body)
      if (!inserted) {
        return targetUnavailable('目标终端已关闭或输入通道不可用，命令未插入。请重新选择终端。')
      }
      return { ok: true, value: { inserted: true } }
    } catch {
      return targetUnavailable('无法写入目标终端，命令未插入。请重新选择终端。')
    }
  },

  executeQuickCommand: async (input) => {
    const bridge = window.termforge?.quickCommands
    if (!bridge) return bridgeUnavailable()
    if (!isTargetStillValid(input.tabId, input.sessionId)) {
      return {
        ok: false,
        error: {
          code: 'conflict',
          message: '目标终端已变化或不可用，快速命令未发送。请重新选择终端。',
        },
      }
    }

    await flushTerminalInput(input.tabId)
    if (!isTargetStillValid(input.tabId, input.sessionId)) {
      return {
        ok: false,
        error: {
          code: 'conflict',
          message: '目标终端在发送前发生变化，快速命令未发送。请重新选择终端。',
        },
      }
    }

    try {
      const result = await bridge.execute(input)
      if (result.ok && result.value.historyRecorded) {
        void get().refreshHistory()
      }
      return result
    } catch (error) {
      return withCaughtError(
        error,
        '快速命令发送请求失败，发送结果未知，请检查终端后再决定是否重试。',
      )
    }
  },

  removeHistoryEntry: async (id) => {
    const bridge = window.termforge?.commandHistory
    if (!bridge) return bridgeUnavailable()
    try {
      const result = await bridge.remove(id)
      if (!result.ok) return result
      set((state) => ({ history: state.history.filter((entry) => entry.id !== id) }))
      return result
    } catch (error) {
      return withCaughtError(error, '删除命令历史失败，请稍后重试。')
    }
  },

  clearHistory: async () => {
    const bridge = window.termforge?.commandHistory
    if (!bridge) return bridgeUnavailable()
    try {
      const result = await bridge.clear()
      if (!result.ok) return result
      set({ history: [], historyStatus: 'ready', historyError: null })
      return result
    } catch (error) {
      return withCaughtError(error, '清空命令历史失败，请稍后重试。')
    }
  },

  reset: () =>
    set({
      drawerOpen: false,
      activePane: 'library',
      search: '',
      commands: [],
      commandsStatus: 'idle',
      commandsError: null,
      history: [],
      historyStatus: 'idle',
      historyError: null,
      capturedTarget: null,
      editor: null,
      compose: null,
    }),
}))

/**
 * One request ID per compose dialog. Retrying after an ambiguous transport
 * failure reuses it, so the main process can reject a duplicate instead of
 * writing the command twice.
 */
export function createQuickCommandRequestId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
