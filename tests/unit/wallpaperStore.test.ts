import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import { useAppStore } from '@renderer/stores/appStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useWallpaperStore } from '@renderer/stores/wallpaperStore'
import { createFakeBridge } from './helpers/fakeBridge'

const WALLPAPER = {
  dataUrl: 'data:image/jpeg;base64,AAAA',
  fileName: 'desk.jpg',
  updatedAt: '2026-10-22T08:00:00.000Z',
}

const EMPTY = { dataUrl: null, fileName: null, updatedAt: null }

function resetWallpaperStore(): void {
  useWallpaperStore.setState({
    dataUrl: null,
    fileName: null,
    updatedAt: null,
    status: 'idle',
    error: null,
    busy: false,
  })
}

beforeEach(() => {
  resetWallpaperStore()
  useSettingsStore.setState({
    ...DEFAULT_APP_PREFERENCES,
    resolvedTheme: 'dark',
    status: 'ready',
    warnings: [],
    error: null,
  })
  useAppStore.setState({
    appInfo: null,
    bridgeStatus: 'idle',
    bridgeError: null,
    securityStatus: null,
    securityStatusError: null,
    toasts: [],
  })
})

afterEach(() => {
  delete window.termforge
})

describe('wallpaper store', () => {
  it('mirrors the main-process state without reading browser storage', async () => {
    const get = vi.fn(async () => ({ ok: true as const, value: WALLPAPER }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, { get })

    await useWallpaperStore.getState().loadWallpaper()

    expect(get).toHaveBeenCalledTimes(1)
    expect(useWallpaperStore.getState()).toMatchObject({
      ...WALLPAPER,
      status: 'ready',
      error: null,
      busy: false,
    })
  })

  it('reports an unavailable bridge or failed read without inventing an image', async () => {
    await useWallpaperStore.getState().loadWallpaper()
    expect(useWallpaperStore.getState().status).toBe('unavailable')
    expect(useWallpaperStore.getState().error).toContain('bridge')

    resetWallpaperStore()
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, {
      get: async () => ({
        ok: false,
        error: { code: 'storage-read-failed', message: '无法读取已保存的壁纸。' },
      }),
    })
    await useWallpaperStore.getState().loadWallpaper()
    expect(useWallpaperStore.getState()).toMatchObject({
      dataUrl: null,
      status: 'unavailable',
      error: '无法读取已保存的壁纸。',
    })
  })

  it('stores a chosen wallpaper and enables wallpaper mode exactly once', async () => {
    const update = vi.fn(async (preferences) => ({
      ok: true as const,
      value: { preferences: { ...preferences }, warnings: [] },
    }))
    const choose = vi.fn(async () => ({
      ok: true as const,
      value: { state: WALLPAPER, canceled: false },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update }, {}, {}, { choose })

    await expect(useWallpaperStore.getState().chooseWallpaper()).resolves.toBe(true)

    expect(useWallpaperStore.getState()).toMatchObject(WALLPAPER)
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
      tone: 'success',
      title: '壁纸已更新',
      description: 'desk.jpg',
    })
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ wallpaperEnabled: true }),
      )
    })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('keeps wallpaper mode unchanged when the picker is canceled', async () => {
    const update = vi.fn()
    const choose = vi.fn(async () => ({
      ok: true as const,
      value: { state: EMPTY, canceled: true },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update }, {}, {}, { choose })

    await expect(useWallpaperStore.getState().chooseWallpaper()).resolves.toBe(false)

    expect(useWallpaperStore.getState()).toMatchObject({
      ...EMPTY,
      busy: false,
      error: null,
    })
    expect(useAppStore.getState().toasts).toEqual([])
    expect(update).not.toHaveBeenCalled()
  })

  it('surfaces import failures without enabling wallpaper mode', async () => {
    const update = vi.fn()
    const choose = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'storage-write-failed' as const, message: '无法保存壁纸。' },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update }, {}, {}, { choose })

    await expect(useWallpaperStore.getState().chooseWallpaper()).resolves.toBe(false)

    expect(useWallpaperStore.getState()).toMatchObject({
      dataUrl: null,
      busy: false,
      error: '无法保存壁纸。',
    })
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
      tone: 'danger',
      title: '壁纸未导入',
      description: '无法保存壁纸。',
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('clears the wallpaper and disables wallpaper mode after removal', async () => {
    useWallpaperStore.setState({ ...WALLPAPER, status: 'ready' })
    useSettingsStore.setState({ wallpaperEnabled: true })
    const update = vi.fn(async (preferences) => ({
      ok: true as const,
      value: { preferences: { ...preferences }, warnings: [] },
    }))
    const remove = vi.fn(async () => ({ ok: true as const, value: EMPTY }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update }, {}, {}, { remove })

    await expect(useWallpaperStore.getState().removeWallpaper()).resolves.toBe(true)

    expect(useWallpaperStore.getState()).toMatchObject(EMPTY)
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
      tone: 'success',
      title: '壁纸已移除',
    })
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ wallpaperEnabled: false }),
      )
    })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('ignores overlapping requests while a wallpaper operation is running', async () => {
    const choose = vi.fn()
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, { choose })
    useWallpaperStore.setState({ busy: true })

    await expect(useWallpaperStore.getState().chooseWallpaper()).resolves.toBe(false)
    await expect(useWallpaperStore.getState().removeWallpaper()).resolves.toBe(false)
    expect(choose).not.toHaveBeenCalled()
  })
})
