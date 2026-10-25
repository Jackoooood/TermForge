import { create } from 'zustand'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import { settingsPreferencesSchema } from '@shared/schemas/settings'
import {
  nextThemeStyle,
  resolveThemeSelection,
  type ResolvedTheme,
  type ThemePreference,
  type ThemeStyle,
} from '@shared/theme/catalog'
import type { AppPreferences } from '@shared/types'
import { useAppStore } from './appStore'

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

interface SettingsState extends AppPreferences {
  resolvedTheme: ResolvedTheme
  /** Concrete palette for the current preference; never 'system'. */
  resolvedStyle: ThemeStyle
  status: SettingsStatus
  warnings: string[]
  error: string | null
  loadSettings: () => Promise<void>
  updatePreferences: (patch: Partial<AppPreferences>) => Promise<boolean>
  setResolvedTheme: (theme: ResolvedTheme) => void
  refreshResolvedTheme: () => void
  setTheme: (theme: ThemePreference) => void
  toggleTheme: () => void
  setTerminalFontSize: (size: number) => void
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolveSelection(theme: ThemePreference, dbxThemeMode: AppPreferences['dbxThemeMode']) {
  return resolveThemeSelection(theme, dbxThemeMode, systemPrefersDark())
}

function preferencesOf(state: SettingsState): AppPreferences {
  return {
    theme: state.theme,
    dbxThemeMode: state.dbxThemeMode,
    gradientIntensity: state.gradientIntensity,
    uiFontFamily: state.uiFontFamily,
    uiFontSize: state.uiFontSize,
    terminalFontFamily: state.terminalFontFamily,
    terminalFontSize: state.terminalFontSize,
    terminalCursorStyle: state.terminalCursorStyle,
    terminalCursorBlink: state.terminalCursorBlink,
    terminalScrollback: state.terminalScrollback,
    transferMaxConcurrent: state.transferMaxConcurrent,
    transferMaxPerSession: state.transferMaxPerSession,
    logLevel: state.logLevel,
    wallpaperEnabled: state.wallpaperEnabled,
    wallpaperIntensity: state.wallpaperIntensity,
    commandHistoryEnabled: state.commandHistoryEnabled,
    autoReconnectEnabled: state.autoReconnectEnabled,
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim().length > 0) return message
  }
  return '设置未能写入本机存储。'
}

/**
 * Settings are applied optimistically so the UI never feels blocked by disk
 * I/O. Writes are serialized, and a failed write rolls back only the fields
 * from that request so a newer edit is not silently discarded.
 */
let writeChain: Promise<unknown> = Promise.resolve()
let localRevision = 0

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_APP_PREFERENCES,
  ...resolveSelection(DEFAULT_APP_PREFERENCES.theme, DEFAULT_APP_PREFERENCES.dbxThemeMode),
  status: 'idle',
  warnings: [],
  error: null,

  loadSettings: async () => {
    if (get().status === 'loading' || get().status === 'ready') return
    const bridge = window.termforge
    if (!bridge?.settings) {
      set({ status: 'unavailable', error: '未检测到 Electron preload bridge，设置不会被持久化。' })
      return
    }

    const revisionAtStart = localRevision
    set({ status: 'loading', error: null })
    try {
      const result = await bridge.settings.get()
      if (!result.ok) {
        set({ status: 'error', error: result.error.message })
        return
      }
      const warnings = [...result.value.warnings]
      if (localRevision !== revisionAtStart) {
        set({ status: 'ready', warnings, error: null })
        return
      }
      const preferences = result.value.preferences
      set({
        ...preferences,
        ...resolveSelection(preferences.theme, preferences.dbxThemeMode),
        status: 'ready',
        warnings,
        error: null,
      })
    } catch {
      set({ status: 'error', error: '无法读取已保存的设置，当前使用默认值。' })
    }
  },

  updatePreferences: async (patch) => {
    const before = preferencesOf(get())
    localRevision += 1
    const parsed = settingsPreferencesSchema.safeParse({ ...before, ...patch })
    if (!parsed.success) {
      set({ status: 'error', error: '设置值未通过校验，未应用任何更改。' })
      return false
    }
    const next = parsed.data
    set({
      ...next,
      ...resolveSelection(next.theme, next.dbxThemeMode),
      status: get().status === 'ready' ? 'ready' : get().status,
      error: null,
    })

    const bridge = window.termforge
    if (!bridge?.settings) {
      set({
        status: 'unavailable',
        error: '未检测到 Electron preload bridge，设置未写入本机存储。',
      })
      return false
    }

    const write = writeChain.then(async () => {
      const result = await bridge.settings.update(next)
      if (!result.ok) throw result.error
      return result.value
    })
    writeChain = write.catch(() => undefined)

    try {
      const snapshot = await write
      set({ status: 'ready', warnings: [...snapshot.warnings], error: null })
      return true
    } catch (error) {
      const message = errorMessage(error)
      const current = preferencesOf(get())
      const rollback: Partial<AppPreferences> = {}
      for (const key of Object.keys(patch) as Array<keyof AppPreferences>) {
        if (current[key] === next[key]) {
          Object.assign(rollback, { [key]: before[key] })
        }
      }
      const restored = { ...current, ...rollback }
      set({
        ...restored,
        ...resolveSelection(restored.theme, restored.dbxThemeMode),
        status: 'error',
        error: message,
      })
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: '设置未保存',
        description: `${message} 已恢复为之前的有效值。`,
      })
      return false
    }
  },

  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),

  refreshResolvedTheme: () => {
    set(resolveSelection(get().theme, get().dbxThemeMode))
  },

  setTheme: (theme) => {
    void get().updatePreferences({ theme })
  },

  toggleTheme: () => {
    const nextStyle = nextThemeStyle(get().resolvedStyle)
    void get().updatePreferences({ theme: nextStyle })
  },

  setTerminalFontSize: (size) => {
    if (!Number.isFinite(size)) return
    const rounded = Math.round(size)
    void get().updatePreferences({ terminalFontSize: rounded })
  },
}))
