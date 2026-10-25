import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import { useAppStore } from '@renderer/stores/appStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { createFakeBridge } from './helpers/fakeBridge'

function resetSettingsStore(): void {
  useSettingsStore.setState({
    ...DEFAULT_APP_PREFERENCES,
    resolvedTheme: 'dark',
    status: 'idle',
    warnings: [],
    error: null,
  })
}

beforeEach(() => {
  resetSettingsStore()
  useAppStore.setState({ toasts: [] })
})

afterEach(() => {
  delete window.termforge
  vi.unstubAllGlobals()
})

describe('settings store', () => {
  it('loads persisted preferences, warnings and marks them ready', async () => {
    window.termforge = createFakeBridge(
      {},
      {},
      {},
      {},
      {},
      {
        get: async () => ({
          ok: true,
          value: {
            preferences: {
              ...DEFAULT_APP_PREFERENCES,
              theme: 'mist',
              terminalFontSize: 16,
              transferMaxConcurrent: 4,
            },
            warnings: ['部分字段已恢复默认值'],
          },
        }),
      },
    )

    await useSettingsStore.getState().loadSettings()

    const state = useSettingsStore.getState()
    expect(state.status).toBe('ready')
    expect(state.theme).toBe('mist')
    expect(state.resolvedTheme).toBe('light')
    expect(state.resolvedStyle).toBe('mist')
    expect(state.terminalFontSize).toBe(16)
    expect(state.transferMaxConcurrent).toBe(4)
    expect(state.warnings).toEqual(['部分字段已恢复默认值'])
  })

  it('applies an update optimistically and persists the complete preference object', async () => {
    const update = vi.fn(async (preferences) => ({
      ok: true as const,
      value: { preferences: { ...preferences }, warnings: [] },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update })
    useSettingsStore.setState({ status: 'ready' })

    const pending = useSettingsStore.getState().updatePreferences({ theme: 'mist' })
    expect(useSettingsStore.getState().theme).toBe('mist')
    expect(useSettingsStore.getState().resolvedTheme).toBe('light')

    await expect(pending).resolves.toBe(true)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      ...DEFAULT_APP_PREFERENCES,
      theme: 'mist',
    })
    expect(useSettingsStore.getState().status).toBe('ready')
  })

  it('rolls back a failed write, reports the error and keeps a toast', async () => {
    const update = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'storage-write-failed' as const, message: '磁盘不可写。' },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update })
    useSettingsStore.setState({ status: 'ready' })

    await expect(
      useSettingsStore.getState().updatePreferences({
        theme: 'mist',
        terminalFontSize: 16,
      }),
    ).resolves.toBe(false)

    const state = useSettingsStore.getState()
    expect(state.theme).toBe('aurora')
    expect(state.terminalFontSize).toBe(DEFAULT_APP_PREFERENCES.terminalFontSize)
    expect(state.resolvedTheme).toBe('dark')
    expect(state.resolvedStyle).toBe('aurora')
    expect(state.status).toBe('error')
    expect(state.error).toContain('磁盘不可写')
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
      tone: 'danger',
      title: '设置未保存',
    })
    expect(useAppStore.getState().toasts.at(-1)?.description).toContain('磁盘不可写')
  })

  it('rejects invalid preference combinations before touching the bridge', async () => {
    const update = vi.fn()
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update })

    await expect(
      useSettingsStore.getState().updatePreferences({ terminalFontSize: 7 }),
    ).resolves.toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().terminalFontSize).toBe(
      DEFAULT_APP_PREFERENCES.terminalFontSize,
    )
    expect(useSettingsStore.getState().error).toContain('未通过校验')
  })

  it('resolves system theme from matchMedia and refreshes it on OS changes', async () => {
    const matchMedia = vi.fn(() => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    vi.stubGlobal('matchMedia', matchMedia)
    window.termforge = createFakeBridge()

    await useSettingsStore.getState().updatePreferences({ theme: 'system' })
    expect(useSettingsStore.getState().resolvedTheme).toBe('light')
    expect(useSettingsStore.getState().resolvedStyle).toBe('mist')

    matchMedia.mockReturnValue({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
    useSettingsStore.getState().refreshResolvedTheme()
    expect(useSettingsStore.getState().resolvedTheme).toBe('dark')
    expect(useSettingsStore.getState().resolvedStyle).toBe('aurora')
  })

  it('resolves dbx light/dark modes independently from classic themes', async () => {
    const matchMedia = vi.fn(() => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    vi.stubGlobal('matchMedia', matchMedia)
    window.termforge = createFakeBridge()

    await useSettingsStore.getState().updatePreferences({
      theme: 'dbx-cobalt',
      dbxThemeMode: 'system',
    })
    expect(useSettingsStore.getState().resolvedStyle).toBe('dbx-cobalt')
    expect(useSettingsStore.getState().resolvedTheme).toBe('light')

    matchMedia.mockReturnValue({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
    useSettingsStore.getState().refreshResolvedTheme()
    expect(useSettingsStore.getState().resolvedTheme).toBe('dark')

    await useSettingsStore.getState().updatePreferences({ dbxThemeMode: 'light' })
    expect(useSettingsStore.getState().resolvedTheme).toBe('light')
    matchMedia.mockReturnValue({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
    useSettingsStore.getState().refreshResolvedTheme()
    expect(useSettingsStore.getState().resolvedTheme).toBe('light')

    await useSettingsStore.getState().updatePreferences({ theme: 'mist' })
    expect(useSettingsStore.getState().resolvedStyle).toBe('mist')
    expect(useSettingsStore.getState().resolvedTheme).toBe('light')
  })

  it('reports settings as session-only when the preload bridge is missing', async () => {
    delete window.termforge

    await useSettingsStore.getState().loadSettings()
    expect(useSettingsStore.getState().status).toBe('unavailable')
    expect(useSettingsStore.getState().error).toContain('bridge')

    await useSettingsStore.getState().updatePreferences({ theme: 'mist' })
    expect(useSettingsStore.getState().theme).toBe('mist')
    expect(useSettingsStore.getState().status).toBe('unavailable')
  })
})
