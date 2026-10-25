import { create } from 'zustand'
import type {
  PortForwardCreateInput,
  PortForwardItem,
  PortForwardUpdateEvent,
  PortForwardUpdateInput,
  StartPortForwardInput,
  TermForgeBridge,
} from '@shared/types'

export type PortForwardLoadStatus = 'idle' | 'loading' | 'ready' | 'error'
export type PortForwardPendingAction = 'start' | 'stop' | 'remove'

export interface PortForwardEditorState {
  open: boolean
  mode: 'create' | 'edit'
  ruleId: string | null
}

interface PortForwardStoreState {
  items: PortForwardItem[]
  revision: number
  loadStatus: PortForwardLoadStatus
  loadError: string | null
  actionError: string | null
  editor: PortForwardEditorState
  startTargetId: string | null
  deleteTargetId: string | null
  pending: Record<string, PortForwardPendingAction>
  sync: () => Promise<void>
  applySnapshot: (event: PortForwardUpdateEvent) => void
  createRule: (input: PortForwardCreateInput) => Promise<PortForwardItem>
  updateRule: (id: string, input: PortForwardUpdateInput) => Promise<PortForwardItem>
  removeRule: (id: string) => Promise<void>
  startRule: (input: StartPortForwardInput) => Promise<PortForwardItem>
  stopRule: (id: string) => Promise<PortForwardItem>
  openCreateEditor: () => void
  openEditEditor: (ruleId: string) => void
  closeEditor: () => void
  requestStart: (ruleId: string) => void
  cancelStart: () => void
  requestDelete: (ruleId: string) => void
  cancelDelete: () => void
  clearActionError: () => void
}

function portForwardBridge(): TermForgeBridge['portForwards'] | null {
  return window.termforge?.portForwards ?? null
}

function requirePortForwardBridge(): TermForgeBridge['portForwards'] {
  const bridge = portForwardBridge()
  if (!bridge) {
    throw new Error('未加载 Electron preload bridge，无法管理端口转发。')
  }
  return bridge
}

function mergeItem(items: PortForwardItem[], incoming: PortForwardItem): PortForwardItem[] {
  const index = items.findIndex((item) => item.rule.id === incoming.rule.id)
  if (index === -1) return [...items, incoming]
  const next = [...items]
  next[index] = incoming
  return next
}

export function isPortForwardActive(item: PortForwardItem): boolean {
  return (
    item.runtime.cleanupPending ||
    item.runtime.status === 'starting' ||
    item.runtime.status === 'running' ||
    item.runtime.status === 'stopping'
  )
}

export const usePortForwardStore = create<PortForwardStoreState>((set, get) => {
  const setPending = (ruleId: string, action: PortForwardPendingAction): void => {
    set((state) => ({ pending: { ...state.pending, [ruleId]: action } }))
  }

  const clearPending = (ruleId: string): void => {
    set((state) => {
      if (!(ruleId in state.pending)) return state
      const next = { ...state.pending }
      delete next[ruleId]
      return { pending: next }
    })
  }

  return {
    items: [],
    revision: 0,
    loadStatus: 'idle',
    loadError: null,
    actionError: null,
    editor: { open: false, mode: 'create', ruleId: null },
    startTargetId: null,
    deleteTargetId: null,
    pending: {},

    sync: async () => {
      const bridge = portForwardBridge()
      if (!bridge) {
        set({
          loadStatus: 'error',
          loadError: '未加载 Electron preload bridge，无法读取端口转发规则。',
        })
        return
      }
      if (get().loadStatus === 'idle') set({ loadStatus: 'loading', loadError: null })
      try {
        const result = await bridge.list()
        if (!result.ok) {
          set({ loadStatus: 'error', loadError: result.error.message })
          return
        }
        get().applySnapshot({ snapshot: result.value })
        set({ loadStatus: 'ready', loadError: null })
      } catch {
        set({
          loadStatus: 'error',
          loadError: '端口转发规则加载失败，请稍后重试。',
        })
      }
    },

    applySnapshot: (event: PortForwardUpdateEvent) => {
      set((state) =>
        event.snapshot.revision < state.revision
          ? state
          : {
              items: event.snapshot.items,
              revision: event.snapshot.revision,
              loadStatus: 'ready',
              loadError: null,
            },
      )
    },

    createRule: async (input) => {
      const result = await requirePortForwardBridge().create(input)
      if (!result.ok) throw new Error(result.error.message)
      set((state) => ({
        items: mergeItem(state.items, result.value),
        loadStatus: 'ready',
        actionError: null,
      }))
      return result.value
    },

    updateRule: async (id, input) => {
      const result = await requirePortForwardBridge().update(id, input)
      if (!result.ok) throw new Error(result.error.message)
      set((state) => ({
        items: mergeItem(state.items, result.value),
        loadStatus: 'ready',
        actionError: null,
      }))
      return result.value
    },

    removeRule: async (id) => {
      setPending(id, 'remove')
      try {
        const result = await requirePortForwardBridge().remove(id)
        if (!result.ok) throw new Error(result.error.message)
        set((state) => ({
          items: state.items.filter((item) => item.rule.id !== id),
          deleteTargetId: state.deleteTargetId === id ? null : state.deleteTargetId,
          actionError: null,
        }))
      } catch (error) {
        set({
          actionError:
            error instanceof Error && error.message
              ? error.message
              : '端口转发规则删除失败，请稍后重试。',
        })
        throw error
      } finally {
        clearPending(id)
      }
    },

    startRule: async (input) => {
      setPending(input.ruleId, 'start')
      try {
        const result = await requirePortForwardBridge().start(input)
        if (!result.ok) throw new Error(result.error.message)
        set((state) => ({
          items: mergeItem(state.items, result.value),
          startTargetId:
            state.startTargetId === input.ruleId ? null : state.startTargetId,
          actionError: null,
        }))
        return result.value
      } catch (error) {
        set({
          actionError:
            error instanceof Error && error.message
              ? error.message
              : '端口转发未能启动，请稍后重试。',
        })
        throw error
      } finally {
        clearPending(input.ruleId)
      }
    },

    stopRule: async (id) => {
      setPending(id, 'stop')
      try {
        const result = await requirePortForwardBridge().stop(id)
        if (!result.ok) throw new Error(result.error.message)
        set((state) => ({
          items: mergeItem(state.items, result.value),
          actionError: null,
        }))
        return result.value
      } catch (error) {
        set({
          actionError:
            error instanceof Error && error.message
              ? error.message
              : '端口转发未能停止，请稍后重试。',
        })
        throw error
      } finally {
        clearPending(id)
      }
    },

    openCreateEditor: () =>
      set({ editor: { open: true, mode: 'create', ruleId: null }, actionError: null }),

    openEditEditor: (ruleId) => {
      const exists = get().items.some((item) => item.rule.id === ruleId)
      if (!exists) return
      set({ editor: { open: true, mode: 'edit', ruleId }, actionError: null })
    },

    closeEditor: () => set({ editor: { open: false, mode: 'create', ruleId: null } }),

    requestStart: (ruleId) => set({ startTargetId: ruleId, actionError: null }),

    cancelStart: () => set({ startTargetId: null }),

    requestDelete: (ruleId) => set({ deleteTargetId: ruleId, actionError: null }),

    cancelDelete: () => set({ deleteTargetId: null }),

    clearActionError: () => set({ actionError: null }),
  }
})

export function sortPortForwardItems(items: PortForwardItem[]): PortForwardItem[] {
  const order = { local: 0, remote: 1, dynamic: 2 } as const
  return [...items].sort((left, right) => {
    const typeDelta = order[left.rule.type] - order[right.rule.type]
    if (typeDelta !== 0) return typeDelta
    return left.rule.name.localeCompare(right.rule.name, 'zh-Hans-CN')
  })
}
