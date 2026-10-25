import { create } from 'zustand'
import type { AppInfo, SecurityStatus } from '@shared/types'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastMessage {
  id: number
  tone: ToastTone
  title: string
  description?: string
}

export type BridgeStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

interface AppStoreState {
  appInfo: AppInfo | null
  bridgeStatus: BridgeStatus
  bridgeError: string | null
  securityStatus: SecurityStatus | null
  securityStatusError: string | null
  toasts: ToastMessage[]
  loadAppInfo: () => Promise<void>
  loadSecurityStatus: () => Promise<void>
  pushToast: (toast: Omit<ToastMessage, 'id'>) => void
  dismissToast: (id: number) => void
}

let nextToastId = 1

export const useAppStore = create<AppStoreState>((set, get) => ({
  appInfo: null,
  bridgeStatus: 'idle',
  bridgeError: null,
  securityStatus: null,
  securityStatusError: null,
  toasts: [],

  loadAppInfo: async () => {
    const status = get().bridgeStatus
    if (status === 'loading' || status === 'ready') return

    const bridge = window.termforge
    if (!bridge) {
      set({
        bridgeStatus: 'unavailable',
        bridgeError: '未检测到 Electron preload bridge（当前可能是浏览器预览）',
      })
      return
    }

    set({ bridgeStatus: 'loading', bridgeError: null })
    try {
      const appInfo = await bridge.getAppInfo()
      set({ appInfo, bridgeStatus: 'ready' })
    } catch (error) {
      set({
        bridgeStatus: 'unavailable',
        bridgeError: error instanceof Error ? error.message : '无法读取只读应用信息',
      })
    }
  },

  loadSecurityStatus: async () => {
    const bridge = window.termforge
    if (!bridge) {
      set({
        securityStatus: null,
        securityStatusError: '未检测到 Electron preload bridge，无法读取安全存储状态。',
      })
      return
    }

    try {
      const securityStatus = await bridge.getSecurityStatus()
      set({ securityStatus, securityStatusError: null })
    } catch {
      set({
        securityStatus: null,
        securityStatusError: '无法读取操作系统安全存储状态；凭据保存保持禁用。',
      })
    }
  },

  pushToast: (toast) => {
    const id = nextToastId
    nextToastId += 1
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },
}))
