import { create } from 'zustand'
import { useAppStore } from './appStore'
import { useSettingsStore } from './settingsStore'

export type WallpaperStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

interface WallpaperStoreState {
  dataUrl: string | null
  fileName: string | null
  updatedAt: string | null
  status: WallpaperStatus
  error: string | null
  busy: boolean
  loadWallpaper: () => Promise<void>
  chooseWallpaper: () => Promise<boolean>
  removeWallpaper: () => Promise<boolean>
}

function applyState(
  state: { dataUrl: string | null; fileName: string | null; updatedAt: string | null },
): {
  dataUrl: string | null
  fileName: string | null
  updatedAt: string | null
  status: WallpaperStatus
  error: null
} {
  return {
    dataUrl: state.dataUrl,
    fileName: state.fileName,
    updatedAt: state.updatedAt,
    status: 'ready',
    error: null,
  }
}

/**
 * Mirrors the main-process wallpaper projection. The image is only a data URL
 * returned by fixed IPC; this store never reads files or browser storage.
 */
export const useWallpaperStore = create<WallpaperStoreState>((set, get) => ({
  dataUrl: null,
  fileName: null,
  updatedAt: null,
  status: 'idle',
  error: null,
  busy: false,

  loadWallpaper: async () => {
    if (get().status === 'loading' || get().status === 'ready') return
    const bridge = window.termforge
    if (!bridge?.wallpaper) {
      set({ status: 'unavailable', error: '未检测到 Electron preload bridge，壁纸功能不可用。' })
      return
    }

    set({ status: 'loading', error: null })
    try {
      const result = await bridge.wallpaper.get()
      if (!result.ok) {
        set({ status: 'unavailable', error: result.error.message })
        return
      }
      set(applyState(result.value))
    } catch {
      set({ status: 'unavailable', error: '无法读取已保存的壁纸。' })
    }
  },

  chooseWallpaper: async () => {
    if (get().busy) return false
    const bridge = window.termforge
    if (!bridge?.wallpaper) {
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: '壁纸功能不可用',
        description: '未检测到 Electron preload bridge。',
      })
      return false
    }

    set({ busy: true, error: null })
    try {
      const result = await bridge.wallpaper.choose()
      if (!result.ok) {
        set({ busy: false, error: result.error.message })
        useAppStore.getState().pushToast({
          tone: 'danger',
          title: '壁纸未导入',
          description: result.error.message,
        })
        return false
      }
      if (result.value.canceled) {
        set({ busy: false })
        return false
      }

      set({ ...applyState(result.value.state), busy: false })
      if (!useSettingsStore.getState().wallpaperEnabled) {
        void useSettingsStore.getState().updatePreferences({ wallpaperEnabled: true })
      }
      useAppStore.getState().pushToast({
        tone: 'success',
        title: '壁纸已更新',
        description: result.value.state.fileName ?? '壁纸模式已启用。',
      })
      return true
    } catch {
      set({ busy: false, error: '壁纸导入失败，请重试。' })
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: '壁纸未导入',
        description: '壁纸导入失败，请重试。',
      })
      return false
    }
  },

  removeWallpaper: async () => {
    if (get().busy) return false
    const bridge = window.termforge
    if (!bridge?.wallpaper) return false

    set({ busy: true, error: null })
    try {
      const result = await bridge.wallpaper.remove()
      if (!result.ok) {
        set({ busy: false, error: result.error.message })
        useAppStore.getState().pushToast({
          tone: 'danger',
          title: '壁纸未移除',
          description: result.error.message,
        })
        return false
      }

      set({ ...applyState(result.value), busy: false })
      if (useSettingsStore.getState().wallpaperEnabled) {
        void useSettingsStore.getState().updatePreferences({ wallpaperEnabled: false })
      }
      useAppStore.getState().pushToast({ tone: 'success', title: '壁纸已移除' })
      return true
    } catch {
      set({ busy: false, error: '壁纸移除失败，请重试。' })
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: '壁纸未移除',
        description: '壁纸移除失败，请重试。',
      })
      return false
    }
  },
}))
