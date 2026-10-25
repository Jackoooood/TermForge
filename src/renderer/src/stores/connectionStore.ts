import { create } from 'zustand'
import type {
  ConnectionGroup,
  ConnectionInput,
  ConnectionProfile,
  ConnectionRemovalImpact,
  ConnectionTag,
} from '@shared/types'
import { connectionService } from '@renderer/services'
import { useAppStore } from './appStore'
import { usePortForwardStore } from './portForwardStore'
import { useSessionStore } from './sessionStore'

export type ConnectionLoadStatus = 'idle' | 'loading' | 'ready' | 'error'
export type DeleteStatus = 'idle' | 'deleting'
export type DeleteImpactStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ConnectionEditorState {
  open: boolean
  mode: 'create' | 'edit'
  connectionId: string | null
}

interface ConnectionStoreState {
  connections: ConnectionProfile[]
  groups: ConnectionGroup[]
  tags: ConnectionTag[]
  loadStatus: ConnectionLoadStatus
  loadError: string | null
  persistenceError: string | null
  searchQuery: string
  collapsedGroupIds: string[]
  editor: ConnectionEditorState
  deleteTargetId: string | null
  deleteStatus: DeleteStatus
  deleteError: string | null
  deleteImpact: ConnectionRemovalImpact | null
  deleteImpactStatus: DeleteImpactStatus
  deleteImpactError: string | null
  cascadePortForwards: boolean
  loadConnections: () => Promise<void>
  setSearchQuery: (query: string) => void
  toggleGroup: (groupId: string) => void
  clearPersistenceError: () => void
  openCreateEditor: () => void
  openEditEditor: (connectionId: string) => void
  closeEditor: () => void
  createConnection: (input: ConnectionInput) => Promise<ConnectionProfile>
  updateConnection: (connectionId: string, input: ConnectionInput) => Promise<ConnectionProfile>
  toggleFavorite: (connectionId: string) => Promise<void>
  requestDelete: (connectionId: string) => void
  cancelDelete: () => void
  loadDeleteImpact: () => Promise<void>
  setCascadePortForwards: (value: boolean) => void
  confirmDelete: () => Promise<boolean>
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export const useConnectionStore = create<ConnectionStoreState>((set, get) => ({
  connections: [],
  groups: [],
  tags: [],
  loadStatus: 'idle',
  loadError: null,
  persistenceError: null,
  searchQuery: '',
  collapsedGroupIds: [],
  editor: { open: false, mode: 'create', connectionId: null },
  deleteTargetId: null,
  deleteStatus: 'idle',
  deleteError: null,
  deleteImpact: null,
  deleteImpactStatus: 'idle',
  deleteImpactError: null,
  cascadePortForwards: false,

  loadConnections: async () => {
    if (get().loadStatus === 'loading') return
    set({ loadStatus: 'loading', loadError: null })
    try {
      const catalog = await connectionService.load()
      set({
        connections: catalog.connections,
        groups: [...catalog.groups].sort((a, b) => a.sortOrder - b.sortOrder),
        tags: catalog.tags,
        loadStatus: 'ready',
      })
      useSessionStore.getState().syncConnectionProfiles(catalog.connections)
      useSessionStore
        .getState()
        .retainConnections(catalog.connections.map((connection) => connection.id))
    } catch (error) {
      const message = errorMessage(error, '无法读取本地连接配置。')
      set({ loadStatus: 'error', loadError: message, persistenceError: message })
      useAppStore
        .getState()
        .pushToast({ tone: 'danger', title: '连接列表加载失败', description: message })
    }
  },

  setSearchQuery: (searchQuery) => set({ searchQuery }),

  toggleGroup: (groupId) => {
    set((state) => ({
      collapsedGroupIds: state.collapsedGroupIds.includes(groupId)
        ? state.collapsedGroupIds.filter((id) => id !== groupId)
        : [...state.collapsedGroupIds, groupId],
    }))
  },

  clearPersistenceError: () => set({ persistenceError: null }),

  openCreateEditor: () => set({ editor: { open: true, mode: 'create', connectionId: null } }),

  openEditEditor: (connectionId) => {
    const exists = get().connections.some((connection) => connection.id === connectionId)
    if (!exists) return
    set({ editor: { open: true, mode: 'edit', connectionId } })
  },

  closeEditor: () => set({ editor: { open: false, mode: 'create', connectionId: null } }),

  createConnection: async (input) => {
    try {
      const connection = await connectionService.create(input)
      set((state) => ({
        connections: [connection, ...state.connections],
        persistenceError: null,
      }))
      return connection
    } catch (error) {
      const message = errorMessage(error, '无法保存连接配置。')
      set({ persistenceError: message })
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: '保存连接失败',
        description: message,
      })
      throw error
    }
  },

  updateConnection: async (connectionId, input) => {
    try {
      const connection = await connectionService.update(connectionId, input)
      set((state) => ({
        connections: state.connections.map((item) =>
          item.id === connectionId ? connection : item,
        ),
        persistenceError: null,
      }))
      useSessionStore.getState().syncConnectionProfiles(get().connections)
      return connection
    } catch (error) {
      const message = errorMessage(error, '无法保存连接配置。')
      set({ persistenceError: message })
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: '更新连接失败',
        description: message,
      })
      throw error
    }
  },

  toggleFavorite: async (connectionId) => {
    const existing = get().connections.find((connection) => connection.id === connectionId)
    if (!existing) return
    const nextFavorite = !existing.favorite

    set((state) => ({
      connections: state.connections.map((connection) =>
        connection.id === connectionId ? { ...connection, favorite: nextFavorite } : connection,
      ),
    }))

    try {
      const updated = await connectionService.setFavorite(connectionId, nextFavorite)
      set((state) => ({
        connections: state.connections.map((connection) =>
          connection.id === connectionId ? updated : connection,
        ),
        persistenceError: null,
      }))
    } catch (error) {
      const message = errorMessage(error, '无法保存收藏状态。')
      set((state) => ({
        connections: state.connections.map((connection) =>
          connection.id === connectionId
            ? { ...connection, favorite: existing.favorite }
            : connection,
        ),
        persistenceError: message,
      }))
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: '收藏状态未保存',
        description: message,
      })
    }
  },

  requestDelete: (connectionId) => {
    const exists = get().connections.some((connection) => connection.id === connectionId)
    if (!exists) return
    set({
      deleteTargetId: connectionId,
      deleteStatus: 'idle',
      deleteError: null,
      deleteImpact: null,
      deleteImpactStatus: 'loading',
      deleteImpactError: null,
      cascadePortForwards: false,
    })
    void get().loadDeleteImpact()
  },

  cancelDelete: () => {
    if (get().deleteStatus === 'deleting') return
    set({
      deleteTargetId: null,
      deleteStatus: 'idle',
      deleteError: null,
      deleteImpact: null,
      deleteImpactStatus: 'idle',
      deleteImpactError: null,
      cascadePortForwards: false,
    })
  },

  loadDeleteImpact: async () => {
    const targetId = get().deleteTargetId
    if (!targetId) return
    const bridge = window.termforge?.portForwards
    if (!bridge) {
      set({
        deleteImpactStatus: 'error',
        deleteImpactError: '未加载 Electron preload bridge，无法检查关联的端口转发规则。',
      })
      return
    }
    set({ deleteImpactStatus: 'loading', deleteImpactError: null })
    try {
      const result = await bridge.getConnectionRemovalImpact(targetId)
      if (get().deleteTargetId !== targetId) return
      if (!result.ok) {
        set({ deleteImpactStatus: 'error', deleteImpactError: result.error.message })
        return
      }
      set({
        deleteImpact: result.value,
        deleteImpactStatus: 'ready',
        deleteImpactError: null,
      })
    } catch {
      if (get().deleteTargetId !== targetId) return
      set({
        deleteImpactStatus: 'error',
        deleteImpactError: '检查关联端口转发规则失败，请重试后再删除连接。',
      })
    }
  },

  setCascadePortForwards: (cascadePortForwards) => set({ cascadePortForwards }),

  confirmDelete: async () => {
    const targetId = get().deleteTargetId
    if (!targetId || get().deleteStatus === 'deleting') return false
    const connection = get().connections.find((item) => item.id === targetId)
    if (!connection) {
      set({ deleteTargetId: null, deleteStatus: 'idle', deleteError: null })
      return false
    }

    const impact = get().deleteImpact
    if (get().deleteImpactStatus !== 'ready' || !impact) {
      set({
        deleteError: get().deleteImpactError ?? '仍在检查关联的端口转发规则，请稍后再试。',
      })
      return false
    }
    const cascadeRuleCount = impact.portForwardRuleCount
    if (cascadeRuleCount > 0 && !get().cascadePortForwards) {
      set({
        deleteError: `该连接下仍有 ${cascadeRuleCount} 条端口转发规则，请先确认停止并删除这些规则。`,
      })
      return false
    }

    set({ deleteStatus: 'deleting', deleteError: null })
    try {
      await connectionService.remove(
        targetId,
        cascadeRuleCount > 0 ? { cascadePortForwards: true } : undefined,
      )
      await useSessionStore.getState().closeSessionsForConnection(targetId)
      await usePortForwardStore.getState().sync()
      set((state) => ({
        connections: state.connections.filter((item) => item.id !== targetId),
        editor:
          state.editor.open && state.editor.connectionId === targetId
            ? { open: false, mode: 'create', connectionId: null }
            : state.editor,
        deleteTargetId: null,
        deleteStatus: 'idle',
        deleteError: null,
        deleteImpact: null,
        deleteImpactStatus: 'idle',
        deleteImpactError: null,
        cascadePortForwards: false,
        persistenceError: null,
      }))
      useAppStore.getState().pushToast({
        tone: 'success',
        title: '连接已删除',
        description:
          cascadeRuleCount > 0
            ? `${connection.name} 已从本机配置中移除，同时停止并删除了 ${cascadeRuleCount} 条端口转发规则。`
            : `${connection.name} 已从本机配置中移除。远端服务器与主机密钥记录不受影响。`,
      })
      return true
    } catch (error) {
      const message = errorMessage(error, '无法删除连接配置。')
      set({ deleteStatus: 'idle', deleteError: message, persistenceError: message })
      void usePortForwardStore.getState().sync()
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: '删除连接失败',
        description: message,
      })
      return false
    }
  },
}))
