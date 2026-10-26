import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  AlertTriangle,
  Download,
  FolderOpen,
  Gauge,
  Image as ImageIcon,
  ImagePlus,
  Info,
  KeyRound,
  Keyboard,
  LoaderCircle,
  Monitor,
  Palette,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Type,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  DEFAULT_APP_PREFERENCES,
  GRADIENT_INTENSITY_MAX,
  GRADIENT_INTENSITY_MIN,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_FAMILIES,
  TERMINAL_FONT_FAMILY_IDS,
  TERMINAL_FONT_LABELS,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_OPTIONS,
  TRANSFER_MAX_CONCURRENT_OPTIONS,
  TRANSFER_MAX_PER_SESSION_OPTIONS,
  UI_FONT_FAMILIES,
  UI_FONT_FAMILY_IDS,
  UI_FONT_LABELS,
  UI_FONT_SIZES,
  WALLPAPER_INTENSITIES,
} from '@shared/constants'
import type { TerminalFontFamilyId, UiFontFamilyId } from '@shared/constants'
import { DBX_THEME_MODES, THEME_CATALOG, isDbxTheme } from '@shared/theme/catalog'
import type { DbxThemeMode, ThemeCatalogEntry } from '@shared/theme/catalog'
import { LOG_LEVELS } from '@shared/types'
import type {
  HostKeyRecord,
  LogInfo,
  LogLevel,
  TerminalCursorStyle,
  WallpaperIntensity,
} from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useAppStore } from '@renderer/stores/appStore'
import { useQuickCommandStore } from '@renderer/stores/quickCommandStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import type { SettingsStatus } from '@renderer/stores/settingsStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import { useWallpaperStore } from '@renderer/stores/wallpaperStore'
import { formatShortcut } from '@renderer/lib/platform'
import { formatBytes } from '@renderer/lib/utils'

const CLASSIC_THEME_ENTRIES = THEME_CATALOG.filter((entry) => entry.kind === 'classic')
const DBX_THEME_ENTRIES = THEME_CATALOG.filter((entry) => entry.kind === 'dbx')

const DBX_MODE_LABELS: Record<DbxThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

function ThemeOptionCard({
  entry,
  active,
  onSelect,
}: {
  entry: ThemeCatalogEntry
  active: boolean
  onSelect: () => void
}) {
  const light = entry.preview.light
  const dark = entry.preview.dark
  return (
    <button
      type="button"
      className={active ? 'theme-card theme-card--active' : 'theme-card'}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span className="theme-card__swatch" aria-hidden="true">
        <span style={{ background: light.background }} />
        <span style={{ background: dark.background }} />
        <span
          className="theme-card__swatch-accent"
          style={{ background: `linear-gradient(90deg, ${light.primary}, ${dark.primary})` }}
        />
      </span>
      <span className="theme-card__body">
        <span className="theme-card__title">{entry.label}</span>
        <span className="theme-card__hint">{entry.hint}</span>
      </span>
    </button>
  )
}

const CURSOR_LABELS: Record<TerminalCursorStyle, string> = {
  block: '方块',
  underline: '下划线',
  bar: '竖线',
}

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  error: '错误',
  warn: '警告',
  info: '信息',
  debug: '调试',
}

const WALLPAPER_INTENSITY_LABELS: Record<WallpaperIntensity, string> = {
  soft: '轻',
  balanced: '标准',
  strong: '浓',
}

const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  other: '其他',
}

const PROTECTION_LABELS: Record<string, string> = {
  'windows-dpapi': 'Windows DPAPI',
  'macos-keychain': 'macOS Keychain',
  'linux-keyring': 'Linux 密钥环',
  unavailable: '不可用',
}

type SettingsSectionId =
  'appearance' | 'terminal' | 'transfers' | 'logs' | 'storage' | 'app-info' | 'demo' | 'shortcuts'

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string; icon: LucideIcon }> = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'terminal', label: '终端', icon: SquareTerminal },
  { id: 'transfers', label: '文件传输', icon: Gauge },
  { id: 'logs', label: '诊断日志', icon: Download },
  { id: 'storage', label: '本地存储与凭据', icon: ShieldCheck },
  { id: 'app-info', label: '应用信息', icon: Monitor },
  { id: 'demo', label: '会话与传输记录', icon: Trash2 },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
]

const SETTINGS_STATUS: Record<
  SettingsStatus,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  idle: { label: '本地设置', tone: 'neutral' },
  loading: { label: '读取设置中', tone: 'warning' },
  ready: { label: '已持久化', tone: 'success' },
  unavailable: { label: '仅本会话生效', tone: 'warning' },
  error: { label: '保存失败', tone: 'danger' },
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function SettingsView() {
  const theme = useSettingsStore((state) => state.theme)
  const dbxThemeMode = useSettingsStore((state) => state.dbxThemeMode)
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme)
  const gradientIntensity = useSettingsStore((state) => state.gradientIntensity)
  const uiFontFamily = useSettingsStore((state) => state.uiFontFamily)
  const uiFontSize = useSettingsStore((state) => state.uiFontSize)
  const terminalFontFamily = useSettingsStore((state) => state.terminalFontFamily)
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize)
  const terminalCursorStyle = useSettingsStore((state) => state.terminalCursorStyle)
  const terminalCursorBlink = useSettingsStore((state) => state.terminalCursorBlink)
  const terminalScrollback = useSettingsStore((state) => state.terminalScrollback)
  const transferMaxConcurrent = useSettingsStore((state) => state.transferMaxConcurrent)
  const transferMaxPerSession = useSettingsStore((state) => state.transferMaxPerSession)
  const logLevel = useSettingsStore((state) => state.logLevel)
  const wallpaperEnabled = useSettingsStore((state) => state.wallpaperEnabled)
  const wallpaperIntensity = useSettingsStore((state) => state.wallpaperIntensity)
  const commandHistoryEnabled = useSettingsStore((state) => state.commandHistoryEnabled)
  const autoReconnectEnabled = useSettingsStore((state) => state.autoReconnectEnabled)
  const settingsStatus = useSettingsStore((state) => state.status)
  const settingsWarnings = useSettingsStore((state) => state.warnings)
  const settingsError = useSettingsStore((state) => state.error)
  const updatePreferences = useSettingsStore((state) => state.updatePreferences)
  const loadSettings = useSettingsStore((state) => state.loadSettings)
  const appInfo = useAppStore((state) => state.appInfo)
  const bridgeStatus = useAppStore((state) => state.bridgeStatus)
  const bridgeError = useAppStore((state) => state.bridgeError)
  const securityStatus = useAppStore((state) => state.securityStatus)
  const securityStatusError = useAppStore((state) => state.securityStatusError)
  const loadAppInfo = useAppStore((state) => state.loadAppInfo)
  const loadSecurityStatus = useAppStore((state) => state.loadSecurityStatus)
  const pushToast = useAppStore((state) => state.pushToast)
  const wallpaperDataUrl = useWallpaperStore((state) => state.dataUrl)
  const wallpaperFileName = useWallpaperStore((state) => state.fileName)
  const wallpaperBusy = useWallpaperStore((state) => state.busy)
  const chooseWallpaper = useWallpaperStore((state) => state.chooseWallpaper)
  const removeWallpaper = useWallpaperStore((state) => state.removeWallpaper)
  const resetSessions = useSessionStore((state) => state.reset)
  const clearTransferHistory = useTransferStore((state) => state.clearHistory)
  const [hostKeys, setHostKeys] = useState<HostKeyRecord[]>([])
  const [hostKeyError, setHostKeyError] = useState<string | null>(null)
  const [hostKeysLoading, setHostKeysLoading] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<HostKeyRecord | null>(null)
  const [removing, setRemoving] = useState(false)
  const [logs, setLogs] = useState<LogInfo | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [openingFolder, setOpeningFolder] = useState(false)
  const [confirmClearHistory, setConfirmClearHistory] = useState(false)
  const [clearingCommandHistory, setClearingCommandHistory] = useState(false)
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('appearance')
  const sectionTabRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({})

  const statusBadge = SETTINGS_STATUS[settingsStatus]
  const hasWallpaper = wallpaperDataUrl !== null
  const dbxActive = theme !== 'system' && isDbxTheme(theme)

  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      nextIndex = (index + 1) % SETTINGS_SECTIONS.length
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = SETTINGS_SECTIONS.length - 1
    }
    if (nextIndex === null) return
    event.preventDefault()
    const nextSection = SETTINGS_SECTIONS[nextIndex]
    setActiveSection(nextSection.id)
    sectionTabRefs.current[nextSection.id]?.focus()
  }

  const loadHostKeys = useCallback(async (): Promise<void> => {
    const bridge = window.termforge
    if (!bridge?.hostKeys) {
      setHostKeys([])
      setHostKeyError('未检测到 Electron preload bridge，无法读取主机密钥记录。')
      return
    }
    setHostKeysLoading(true)
    try {
      const result = await bridge.hostKeys.list()
      if (!result.ok) {
        setHostKeyError(result.error.message)
        return
      }
      setHostKeys(result.value)
      setHostKeyError(null)
    } catch {
      setHostKeyError('无法读取已信任的主机密钥。')
    } finally {
      setHostKeysLoading(false)
    }
  }, [])

  const loadLogs = useCallback(async (): Promise<void> => {
    const bridge = window.termforge
    if (!bridge?.logs) {
      setLogs(null)
      setLogError('未检测到 Electron preload bridge，无法读取诊断日志。')
      return
    }
    setLogsLoading(true)
    try {
      const result = await bridge.logs.getInfo()
      if (!result.ok) {
        setLogError(result.error.message)
        return
      }
      setLogs(result.value)
      setLogError(null)
    } catch {
      setLogError('无法读取诊断日志信息。')
    } finally {
      setLogsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHostKeys()
    void loadLogs()
  }, [loadHostKeys, loadLogs])

  const resetAppearance = async (): Promise<void> => {
    const saved = await updatePreferences({
      theme: DEFAULT_APP_PREFERENCES.theme,
      dbxThemeMode: DEFAULT_APP_PREFERENCES.dbxThemeMode,
      gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
      uiFontFamily: DEFAULT_APP_PREFERENCES.uiFontFamily,
      uiFontSize: DEFAULT_APP_PREFERENCES.uiFontSize,
      terminalFontFamily: DEFAULT_APP_PREFERENCES.terminalFontFamily,
      terminalFontSize: DEFAULT_APP_PREFERENCES.terminalFontSize,
      terminalCursorStyle: DEFAULT_APP_PREFERENCES.terminalCursorStyle,
      terminalCursorBlink: DEFAULT_APP_PREFERENCES.terminalCursorBlink,
      terminalScrollback: DEFAULT_APP_PREFERENCES.terminalScrollback,
      wallpaperEnabled: DEFAULT_APP_PREFERENCES.wallpaperEnabled,
      wallpaperIntensity: DEFAULT_APP_PREFERENCES.wallpaperIntensity,
    })
    if (saved) {
      pushToast({
        tone: 'success',
        title: '已恢复默认外观',
        description:
          'Aurora 深色 · 界面 13px · 终端 Cascadia Mono 13px · 默认光标与渐变 · 壁纸关闭。',
      })
    }
  }

  const clearTransfers = async (): Promise<void> => {
    const result = await clearTransferHistory()
    if (!result.ok) {
      pushToast({
        tone: 'danger',
        title: '无法清空传输记录',
        description: result.error.message,
      })
      return
    }
    pushToast({
      tone: 'info',
      title:
        result.value.cleared > 0
          ? `已清空 ${result.value.cleared} 条传输记录`
          : '没有可清空的传输记录',
      description: '进行中或等待处理冲突的任务不会被删除。',
    })
  }

  const clearCommandHistory = async (): Promise<void> => {
    if (clearingCommandHistory) return
    setClearingCommandHistory(true)
    const result = await useQuickCommandStore.getState().clearHistory()
    setClearingCommandHistory(false)
    if (!result.ok) {
      pushToast({
        tone: 'danger',
        title: '无法清空命令历史',
        description: result.error.message,
      })
      return
    }
    setConfirmClearHistory(false)
    pushToast({
      tone: result.value.cleared > 0 ? 'success' : 'info',
      title:
        result.value.cleared > 0
          ? `已清空 ${result.value.cleared} 条命令历史`
          : '没有可清空的命令历史',
      description: '只删除快速命令历史文件中的记录，不影响诊断日志。',
    })
  }

  const closeAllSessions = (): void => {
    resetSessions()
    pushToast({
      tone: 'info',
      title: '已请求断开全部 SSH 会话',
      description: '主进程正在关闭活动连接；本地标签已清空。',
    })
  }

  const updateConcurrency = (value: number): void => {
    const patch =
      value < transferMaxPerSession
        ? { transferMaxConcurrent: value, transferMaxPerSession: value }
        : { transferMaxConcurrent: value }
    void updatePreferences(patch)
  }

  const exportLogs = async (): Promise<void> => {
    const bridge = window.termforge
    if (!bridge?.logs) {
      pushToast({ tone: 'danger', title: '无法导出日志', description: 'preload bridge 不可用。' })
      return
    }
    setExporting(true)
    try {
      const result = await bridge.logs.exportLogs()
      if (!result.ok) {
        pushToast({ tone: 'danger', title: '无法导出日志', description: result.error.message })
        return
      }
      if (!result.value.exported) return
      pushToast({
        tone: 'success',
        title: '诊断日志已导出',
        description: '日志已脱敏；请勿在公开渠道附带完整系统环境信息。',
      })
    } catch {
      pushToast({
        tone: 'danger',
        title: '无法导出日志',
        description: '导出请求未能完成，请稍后重试。',
      })
    } finally {
      setExporting(false)
    }
  }

  const openLogFolder = async (): Promise<void> => {
    const bridge = window.termforge
    if (!bridge?.logs) {
      pushToast({
        tone: 'danger',
        title: '无法打开日志目录',
        description: 'preload bridge 不可用。',
      })
      return
    }
    setOpeningFolder(true)
    try {
      const result = await bridge.logs.openFolder()
      if (!result.ok) {
        pushToast({ tone: 'danger', title: '无法打开日志目录', description: result.error.message })
      } else if (!result.value.opened) {
        pushToast({ tone: 'warning', title: '系统未能打开日志目录' })
      }
    } catch {
      pushToast({ tone: 'danger', title: '无法打开日志目录' })
    } finally {
      setOpeningFolder(false)
    }
  }

  const confirmRemoveHostKey = async (): Promise<void> => {
    const target = removeTarget
    const bridge = window.termforge
    if (!target || !bridge?.hostKeys) return
    setRemoving(true)
    try {
      const result = await bridge.hostKeys.remove(target.host, target.port)
      if (!result.ok) {
        pushToast({
          tone: 'danger',
          title: '无法移除主机密钥信任',
          description: result.error.message,
        })
        return
      }
      if (!result.value.removed) {
        pushToast({ tone: 'info', title: '未找到该主机密钥记录' })
      } else {
        pushToast({
          tone: 'success',
          title: '已移除主机密钥信任',
          description: `${target.host}:${target.port} 下次连接时需要重新确认主机密钥。`,
        })
      }
      setRemoveTarget(null)
      await loadHostKeys()
    } catch {
      pushToast({ tone: 'danger', title: '无法移除主机密钥信任' })
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="module-view">
      <header className="module-header">
        <div className="module-header__main">
          <div className="module-header__eyebrow">
            <span>Preferences</span>
            <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
          </div>
          <h1 className="module-header__title">设置</h1>
          <p className="module-header__description">
            外观、终端、传输并发与日志级别由主进程校验后写入本机用户数据目录；保存失败会回滚到上一个有效值并提示。凭据与主机密钥仍由独立的安全存储管理。
          </p>
        </div>
      </header>

      <div className="module-body">
        <div className="settings-body">
          {settingsStatus === 'error' && settingsError ? (
            <div className="settings-note settings-note--danger" role="alert">
              <AlertTriangle size={13} aria-hidden="true" />
              <span>{settingsError}</span>
              <Button size="sm" variant="ghost" onClick={() => void loadSettings()}>
                重新读取
              </Button>
            </div>
          ) : null}
          {settingsStatus === 'unavailable' && settingsError ? (
            <div className="settings-note" role="status">
              <Info size={13} aria-hidden="true" />
              <span>{settingsError}</span>
            </div>
          ) : null}
          {settingsWarnings.map((warning) => (
            <div className="settings-note" role="status" key={warning}>
              <AlertTriangle size={13} aria-hidden="true" />
              <span>{warning}</span>
            </div>
          ))}

          <div className="settings-layout">
            <nav
              className="settings-nav"
              role="tablist"
              aria-label="设置分类"
              aria-orientation="vertical"
            >
              {SETTINGS_SECTIONS.map((section, index) => {
                const Icon = section.icon
                const selected = activeSection === section.id
                return (
                  <button
                    key={section.id}
                    ref={(node) => {
                      sectionTabRefs.current[section.id] = node
                    }}
                    type="button"
                    role="tab"
                    id={`settings-tab-${section.id}`}
                    aria-controls={`settings-panel-${section.id}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className={
                      selected
                        ? 'settings-nav__item settings-nav__item--active'
                        : 'settings-nav__item'
                    }
                    onClick={() => setActiveSection(section.id)}
                    onKeyDown={(event) => handleSectionKeyDown(event, index)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{section.label}</span>
                  </button>
                )
              })}
            </nav>

            <div className="settings-panels">
              <section
                className="settings-section settings-panel"
                id="settings-panel-appearance"
                role="tabpanel"
                aria-labelledby="settings-tab-appearance"
                hidden={activeSection !== 'appearance'}
              >
                <header className="settings-section__header">
                  <h2 className="settings-section__title" id="settings-appearance">
                    <Palette size={14} aria-hidden="true" />
                    外观
                  </h2>
                  <p className="settings-section__description">
                    3 套经典主题与 13 套扩展色板。扩展色板可独立选择浅色、深色或跟随系统；
                    界面与终端字体均使用固定字体栈，修改后立即生效并持久化。
                  </p>
                </header>
                <div className="settings-section__body">
                  <section className="appearance-group" aria-labelledby="appearance-group-classic">
                    <div className="appearance-group__header">
                      <h3 className="appearance-group__title" id="appearance-group-classic">
                        经典主题
                      </h3>
                      <span className="appearance-group__note">固定深浅色 · 保留原有观感</span>
                    </div>
                    <div className="theme-options" role="group" aria-label="经典主题">
                      {CLASSIC_THEME_ENTRIES.map((entry) => (
                        <ThemeOptionCard
                          key={entry.id}
                          entry={entry}
                          active={theme === entry.id}
                          onSelect={() => void updatePreferences({ theme: entry.id })}
                        />
                      ))}
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        aria-label="经典主题跟随系统深浅色"
                        checked={theme === 'system'}
                        onChange={(event) =>
                          void updatePreferences({
                            theme: event.target.checked ? 'system' : 'aurora',
                          })
                        }
                      />
                      <span>
                        经典主题跟随系统
                        <span className="settings-row__description">
                          {theme === 'system'
                            ? `当前系统解析为 ${
                                resolvedTheme === 'dark' ? 'Aurora（深色）' : 'Mist（浅色）'
                              }；选择扩展色板后由下方深浅色控制接管。`
                            : '深色解析为 Aurora、浅色解析为 Mist；扩展色板使用下方独立的深浅色设置。'}
                        </span>
                      </span>
                    </label>
                  </section>

                  <section className="appearance-group" aria-labelledby="appearance-group-dbx">
                    <div className="appearance-group__header">
                      <h3 className="appearance-group__title" id="appearance-group-dbx">
                        扩展色板
                      </h3>
                      <span className="appearance-group__note">13 套 · 浅色 / 深色双模式</span>
                    </div>
                    <div
                      className="theme-options theme-options--dbx"
                      role="group"
                      aria-label="扩展色板"
                    >
                      {DBX_THEME_ENTRIES.map((entry) => (
                        <ThemeOptionCard
                          key={entry.id}
                          entry={entry}
                          active={theme === entry.id}
                          onSelect={() => void updatePreferences({ theme: entry.id })}
                        />
                      ))}
                    </div>
                    <div className="settings-row">
                      <div>
                        <p className="settings-row__label">扩展色板深浅色</p>
                        <p className="settings-row__description">
                          {dbxActive
                            ? `当前为${resolvedTheme === 'dark' ? '深色' : '浅色'}${
                                dbxThemeMode === 'system' ? '（随操作系统外观切换）' : ''
                              }。终端始终使用该色板的深色 ANSI 配色以保持可读性。`
                            : '仅对扩展色板生效；选择任意扩展色板后可切换浅色、深色或跟随系统。'}
                        </p>
                      </div>
                      <div className="settings-row__control">
                        <div className="segmented" role="group" aria-label="扩展色板深浅色">
                          {DBX_THEME_MODES.map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              disabled={!dbxActive}
                              aria-pressed={dbxActive && dbxThemeMode === mode}
                              onClick={() => void updatePreferences({ dbxThemeMode: mode })}
                            >
                              {DBX_MODE_LABELS[mode]}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>

                  <div className="settings-row">
                    <div className="settings-row__heading">
                      <p className="settings-row__label">
                        渐变强度 <span className="settings-row__value">{gradientIntensity}%</span>
                      </p>
                      <p className="settings-row__description">
                        调节 Aurora 与 Mist 背景光斑的可见度；Obsidian
                        与扩展色板采用纯色背景，不受影响。
                      </p>
                    </div>
                    <input
                      type="range"
                      className="gradient-slider"
                      min={GRADIENT_INTENSITY_MIN}
                      max={GRADIENT_INTENSITY_MAX}
                      step={5}
                      value={gradientIntensity}
                      aria-label="渐变强度"
                      onChange={(event) =>
                        void updatePreferences({
                          gradientIntensity: Number(event.target.value),
                        })
                      }
                    />
                  </div>

                  <div className="wallpaper-card" data-active={wallpaperEnabled && hasWallpaper}>
                    <div className="wallpaper-card__preview" data-empty={!hasWallpaper}>
                      {hasWallpaper && wallpaperDataUrl ? (
                        <img src={wallpaperDataUrl} alt="当前壁纸预览" />
                      ) : (
                        <ImageIcon size={20} aria-hidden="true" />
                      )}
                      <span className="wallpaper-card__state">
                        {hasWallpaper ? (wallpaperEnabled ? '壁纸模式' : '已暂停') : '未导入'}
                      </span>
                    </div>
                    <div className="wallpaper-card__content">
                      <div className="wallpaper-card__heading">
                        <div>
                          <p className="settings-row__label">自定义背景</p>
                          <p className="settings-row__description">
                            用本机图片替代主题背景光斑，面板以半透明遮罩呈现；终端、输入框与正文保持不透明。
                            {hasWallpaper ? ` 当前图片：${wallpaperFileName ?? '本地壁纸'}。` : ''}
                          </p>
                        </div>
                        <label className="checkbox-row">
                          <input
                            type="checkbox"
                            aria-label="启用壁纸模式"
                            checked={wallpaperEnabled && hasWallpaper}
                            disabled={!hasWallpaper}
                            onChange={(event) =>
                              void updatePreferences({ wallpaperEnabled: event.target.checked })
                            }
                          />
                          <span>{wallpaperEnabled && hasWallpaper ? '已开启' : '已关闭'}</span>
                        </label>
                      </div>
                      <div className="wallpaper-card__controls">
                        <div className="wallpaper-card__actions">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={wallpaperBusy}
                            onClick={() => void chooseWallpaper()}
                          >
                            <ImagePlus size={12} aria-hidden="true" />
                            {hasWallpaper ? '更换图片' : '选择本地图片'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!hasWallpaper || wallpaperBusy}
                            onClick={() => void removeWallpaper()}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                            移除
                          </Button>
                        </div>
                        <div className="wallpaper-card__intensity">
                          <span className="settings-row__label">浓度</span>
                          <div className="segmented" role="group" aria-label="壁纸浓度">
                            {WALLPAPER_INTENSITIES.map((intensity) => (
                              <button
                                key={intensity}
                                type="button"
                                disabled={!hasWallpaper}
                                aria-pressed={wallpaperIntensity === intensity}
                                onClick={() =>
                                  void updatePreferences({ wallpaperIntensity: intensity })
                                }
                              >
                                {WALLPAPER_INTENSITY_LABELS[intensity]}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <section className="appearance-group" aria-labelledby="appearance-group-fonts">
                    <div className="appearance-group__header">
                      <h3 className="appearance-group__title" id="appearance-group-fonts">
                        字体
                      </h3>
                      <span className="appearance-group__note">固定字体栈 · 立即生效</span>
                    </div>

                    <div className="font-card">
                      <div className="font-card__header">
                        <div className="font-card__intro">
                          <p className="settings-row__label">界面字体</p>
                          <p className="settings-row__description">
                            仅提供预设字体栈，不接受任意字体名称；字号会等比缩放全部界面排版。
                          </p>
                        </div>
                        <div className="font-card__controls">
                          <select
                            className="select settings-select"
                            aria-label="界面字体"
                            value={uiFontFamily}
                            onChange={(event) =>
                              void updatePreferences({
                                uiFontFamily: event.target.value as UiFontFamilyId,
                              })
                            }
                          >
                            {UI_FONT_FAMILY_IDS.map((id) => (
                              <option value={id} key={id}>
                                {UI_FONT_LABELS[id]}
                              </option>
                            ))}
                          </select>
                          <div className="segmented" role="group" aria-label="界面字号">
                            {UI_FONT_SIZES.map((size) => (
                              <button
                                key={size}
                                type="button"
                                aria-pressed={uiFontSize === size}
                                onClick={() => void updatePreferences({ uiFontSize: size })}
                              >
                                {size}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div
                        className="font-preview"
                        aria-hidden="true"
                        style={{
                          fontFamily: UI_FONT_FAMILIES[uiFontFamily],
                          fontSize: `${uiFontSize}px`,
                        }}
                      >
                        <span className="font-preview__caption">界面预览 · {uiFontSize}px</span>
                        <span className="font-preview__sample">
                          TermForge 终端工作台 AaBbCc 0123456789 · 会话 / 传输 / 端口转发
                        </span>
                      </div>
                    </div>

                    <div className="font-card">
                      <div className="font-card__header">
                        <div className="font-card__intro">
                          <p className="settings-row__label">终端字体</p>
                          <p className="settings-row__description">
                            未安装的字体自动回退到等宽字体；字号变化会重新计算终端行列并同步 PTY
                            尺寸。
                          </p>
                        </div>
                        <div className="font-card__controls">
                          <select
                            className="select settings-select"
                            aria-label="终端字体"
                            value={terminalFontFamily}
                            onChange={(event) =>
                              void updatePreferences({
                                terminalFontFamily: event.target.value as TerminalFontFamilyId,
                              })
                            }
                          >
                            {TERMINAL_FONT_FAMILY_IDS.map((id) => (
                              <option value={id} key={id}>
                                {TERMINAL_FONT_LABELS[id]}
                              </option>
                            ))}
                          </select>
                          <div
                            className="segmented segmented--compact"
                            role="group"
                            aria-label="终端字号"
                          >
                            {TERMINAL_FONT_SIZES.map((size) => (
                              <button
                                key={size}
                                type="button"
                                aria-pressed={terminalFontSize === size}
                                onClick={() => void updatePreferences({ terminalFontSize: size })}
                              >
                                {size}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div
                        className="font-preview font-preview--terminal"
                        aria-hidden="true"
                        style={{
                          fontFamily: TERMINAL_FONT_FAMILIES[terminalFontFamily],
                          fontSize: `${terminalFontSize}px`,
                        }}
                      >
                        <span className="terminal-preview__user">dev@termforge</span>
                        <span className="terminal-preview__muted">:</span>
                        <span className="terminal-preview__path">~/apps</span>
                        <span className="terminal-preview__muted">$ </span>
                        <span>ssh prod-db</span>
                        <br />
                        <span className="terminal-preview__ok">
                          已连接 · xterm-256color · 中文显示正常
                        </span>
                      </div>
                    </div>
                  </section>
                </div>
              </section>

              <section
                className="settings-section settings-panel"
                id="settings-panel-terminal"
                role="tabpanel"
                aria-labelledby="settings-tab-terminal"
                hidden={activeSection !== 'terminal'}
              >
                <header className="settings-section__header">
                  <h2 className="settings-section__title" id="settings-terminal">
                    <SquareTerminal size={14} aria-hidden="true" />
                    终端
                  </h2>
                  <p className="settings-section__description">
                    远程 PTY 由主进程持有、由 xterm.js
                    渲染；以下选项会立即应用到已打开的终端，无需重建 SSH 会话。
                  </p>
                </header>
                <div className="settings-section__body">
                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">
                        <Type
                          size={12}
                          style={{ display: 'inline', marginRight: 5 }}
                          aria-hidden="true"
                        />
                        字体与字号
                      </p>
                      <p className="settings-row__description">
                        当前 {TERMINAL_FONT_LABELS[terminalFontFamily]} · {terminalFontSize}px。
                        字体与字号在外观设置中调整，并提供实时预览。
                      </p>
                    </div>
                    <div className="settings-row__control">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setActiveSection('appearance')}
                      >
                        前往外观设置
                      </Button>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">光标样式</p>
                      <p className="settings-row__description">
                        光标颜色由当前主题的终端 token 决定。
                      </p>
                    </div>
                    <div className="settings-row__control">
                      <div className="segmented" role="group" aria-label="终端光标样式">
                        {TERMINAL_CURSOR_STYLES.map((style) => (
                          <button
                            key={style}
                            type="button"
                            aria-pressed={terminalCursorStyle === style}
                            onClick={() => void updatePreferences({ terminalCursorStyle: style })}
                          >
                            {CURSOR_LABELS[style]}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">光标闪烁</p>
                      <p className="settings-row__description">关闭后光标保持静止。</p>
                    </div>
                    <div className="settings-row__control">
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={terminalCursorBlink}
                          onChange={(event) =>
                            void updatePreferences({ terminalCursorBlink: event.target.checked })
                          }
                        />
                        <span>{terminalCursorBlink ? '已开启' : '已关闭'}</span>
                      </label>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">回滚缓冲区</p>
                      <p className="settings-row__description">
                        较大的缓冲区占用更多内存；仅影响本地渲染，不影响远端进程。
                      </p>
                    </div>
                    <div className="settings-row__control">
                      <select
                        className="select settings-select"
                        aria-label="终端回滚行数"
                        value={terminalScrollback}
                        onChange={(event) =>
                          void updatePreferences({ terminalScrollback: Number(event.target.value) })
                        }
                      >
                        {TERMINAL_SCROLLBACK_OPTIONS.map((lines) => (
                          <option value={lines} key={lines}>
                            {lines.toLocaleString()} 行
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </section>

              <section
                className="settings-section settings-panel"
                id="settings-panel-transfers"
                role="tabpanel"
                aria-labelledby="settings-tab-transfers"
                hidden={activeSection !== 'transfers'}
              >
                <header className="settings-section__header">
                  <h2 className="settings-section__title" id="settings-transfers">
                    <Gauge size={14} aria-hidden="true" />
                    文件传输
                  </h2>
                  <p className="settings-section__description">
                    主进程使用 FIFO 队列限制同时传输的任务数；单会话上限不会超过全局并发。
                  </p>
                </header>
                <div className="settings-section__body">
                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">全局同时传输</p>
                      <p className="settings-row__description">
                        当前 {transferMaxConcurrent} 个任务可同时传输，其余任务保持排队。
                      </p>
                    </div>
                    <div className="settings-row__control">
                      <select
                        className="select settings-select"
                        aria-label="全局传输并发"
                        value={transferMaxConcurrent}
                        onChange={(event) => updateConcurrency(Number(event.target.value))}
                      >
                        {TRANSFER_MAX_CONCURRENT_OPTIONS.map((value) => (
                          <option value={value} key={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">单会话同时传输</p>
                      <p className="settings-row__description">
                        当前每个 SSH 会话最多 {transferMaxPerSession}{' '}
                        个任务。修改全局并发时可能自动下调此值。
                      </p>
                    </div>
                    <div className="settings-row__control">
                      <select
                        className="select settings-select"
                        aria-label="单会话传输并发"
                        value={transferMaxPerSession}
                        onChange={(event) =>
                          void updatePreferences({
                            transferMaxPerSession: Number(event.target.value),
                          })
                        }
                      >
                        {TRANSFER_MAX_PER_SESSION_OPTIONS.filter(
                          (value) => value <= transferMaxConcurrent,
                        ).map((value) => (
                          <option value={value} key={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </section>

              <section
                className="settings-section settings-panel"
                id="settings-panel-logs"
                role="tabpanel"
                aria-labelledby="settings-tab-logs"
                hidden={activeSection !== 'logs'}
              >
                <header className="settings-section__header">
                  <h2 className="settings-section__title" id="settings-logs">
                    <Download size={14} aria-hidden="true" />
                    诊断日志
                  </h2>
                  <p className="settings-section__description">
                    主进程以结构化 JSON
                    行写入滚动日志，自动脱敏密码、令牌、私钥、终端输入输出与文件内容。
                  </p>
                </header>
                <div className="settings-section__body">
                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">日志级别</p>
                      <p className="settings-row__description">
                        调整后立即作用于主进程；debug 仅建议在排查问题时临时启用。
                      </p>
                    </div>
                    <div className="settings-row__control">
                      <select
                        className="select settings-select"
                        aria-label="日志级别"
                        value={logLevel}
                        onChange={(event) =>
                          void updatePreferences({ logLevel: event.target.value as LogLevel })
                        }
                      >
                        {LOG_LEVELS.map((level) => (
                          <option value={level} key={level}>
                            {LOG_LEVEL_LABELS[level]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {logError ? (
                    <div className="settings-note settings-note--danger" role="alert">
                      <AlertTriangle size={13} aria-hidden="true" />
                      <span>{logError}</span>
                    </div>
                  ) : logs ? (
                    <>
                      <dl className="app-info-grid">
                        <div>
                          <dt>日志目录</dt>
                          <dd title={logs.directory}>{logs.directory}</dd>
                        </div>
                        <div>
                          <dt>当前级别</dt>
                          <dd>{logs.level}</dd>
                        </div>
                        <div>
                          <dt>日志文件</dt>
                          <dd>{logs.files.length} 个</dd>
                        </div>
                        <div>
                          <dt>写入失败</dt>
                          <dd>{logs.writeFailures}</dd>
                        </div>
                      </dl>
                      {logs.files.length > 0 ? (
                        <ul className="log-file-list" aria-label="日志文件">
                          {logs.files.map((file) => (
                            <li key={file.name}>
                              <span className="log-file-list__name" title={file.name}>
                                {file.name}
                              </span>
                              <span className="log-file-list__meta">
                                {formatBytes(file.sizeBytes)} · {formatTimestamp(file.modifiedAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="table-muted">尚未生成日志文件。</p>
                      )}
                      {logs.writeFailures > 0 ? (
                        <div className="settings-note" role="status">
                          <AlertTriangle size={13} aria-hidden="true" />
                          <span>
                            有 {logs.writeFailures}{' '}
                            次日志写入失败。应用功能不受影响，但诊断信息可能不完整；请检查日志目录权限。
                          </span>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="table-muted">
                      {logsLoading ? '正在读取日志信息…' : '暂无日志信息。'}
                    </p>
                  )}

                  <div className="settings-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={logsLoading}
                      onClick={() => void loadLogs()}
                    >
                      {logsLoading ? (
                        <LoaderCircle size={13} className="spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw size={13} aria-hidden="true" />
                      )}
                      刷新日志信息
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={exporting}
                      onClick={() => void exportLogs()}
                    >
                      <Download size={13} aria-hidden="true" />
                      {exporting ? '导出中…' : '导出脱敏日志'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={openingFolder}
                      onClick={() => void openLogFolder()}
                    >
                      <FolderOpen size={13} aria-hidden="true" />
                      打开日志目录
                    </Button>
                  </div>
                </div>
              </section>

              <section
                className="settings-section settings-panel"
                id="settings-panel-storage"
                role="tabpanel"
                aria-labelledby="settings-tab-storage"
                hidden={activeSection !== 'storage'}
              >
                <header className="settings-section__header">
                  <h2 className="settings-section__title" id="settings-storage">
                    <ShieldCheck size={14} aria-hidden="true" />
                    本地存储与凭据
                    <Badge tone="neutral" style={{ marginLeft: 6 }}>
                      主进程
                    </Badge>
                  </h2>
                  <p className="settings-section__description">
                    非敏感设置与连接配置由主进程原子写入操作系统用户数据目录；渲染进程只能通过固定
                    IPC 方法访问，不接触文件路径。
                  </p>
                </header>
                <div className="settings-section__body">
                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">设置持久化</p>
                      <p className="settings-row__description">
                        版本化 JSON + 严格 schema
                        校验；损坏或旧版本字段会逐项恢复默认值并显示警告，且不会在仅读取时覆盖原文件。
                      </p>
                    </div>
                    <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
                  </div>

                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">连接配置</p>
                      <p className="settings-row__description">
                        非敏感字段以版本化 JSON
                        保存，写入时使用临时文件原子替换。密码、私钥与私钥口令仅保存在操作系统凭据存储中。
                      </p>
                    </div>
                    <Badge tone={bridgeStatus === 'ready' ? 'success' : 'warning'}>
                      {bridgeStatus === 'ready' ? '本机持久化' : 'bridge 不可用'}
                    </Badge>
                  </div>

                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">凭据保护适配层</p>
                      <p className="settings-row__description">
                        {securityStatus?.credentialStorage.message ??
                          securityStatusError ??
                          '正在读取操作系统安全存储状态…'}
                      </p>
                    </div>
                    <Badge
                      tone={
                        securityStatus?.credentialStorage.available
                          ? 'success'
                          : securityStatusError
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {
                        PROTECTION_LABELS[
                          securityStatus?.credentialStorage.protection ?? 'unavailable'
                        ]
                      }
                    </Badge>
                  </div>

                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">主机密钥策略</p>
                      <p className="settings-row__description">
                        未知主机密钥必须经你显式确认；已变化密钥会立即被拒绝且不会自动更新。移除信任记录后，下次连接需要重新确认。
                      </p>
                    </div>
                    <Badge tone="neutral">显式信任</Badge>
                  </div>

                  <div className="settings-subsection" aria-labelledby="settings-hostkeys">
                    <div className="settings-subsection__header">
                      <h3 className="settings-subsection__title" id="settings-hostkeys">
                        <KeyRound size={13} aria-hidden="true" />
                        已信任的主机密钥
                      </h3>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={hostKeysLoading}
                        onClick={() => void loadHostKeys()}
                      >
                        <RefreshCw
                          size={12}
                          className={hostKeysLoading ? 'spin' : undefined}
                          aria-hidden="true"
                        />
                        刷新
                      </Button>
                    </div>
                    {hostKeyError ? (
                      <div className="settings-note settings-note--danger" role="alert">
                        <AlertTriangle size={13} aria-hidden="true" />
                        <span>{hostKeyError}</span>
                      </div>
                    ) : hostKeys.length === 0 ? (
                      <p className="table-muted">尚未信任任何主机密钥。</p>
                    ) : (
                      <ul className="host-key-list">
                        {hostKeys.map((record) => (
                          <li key={`${record.host}:${record.port}:${record.algorithm}`}>
                            <div className="host-key-list__main">
                              <span className="host-key-list__endpoint">
                                {record.host}:{record.port}
                                <Badge tone="neutral">{record.algorithm}</Badge>
                              </span>
                              <span
                                className="host-key-list__fingerprint"
                                title={record.fingerprint}
                              >
                                {record.fingerprint}
                              </span>
                              <span className="host-key-list__meta">
                                信任时间 {formatTimestamp(record.trustedAt)}
                                {record.updatedAt !== record.trustedAt
                                  ? ` · 更新时间 ${formatTimestamp(record.updatedAt)}`
                                  : ''}
                              </span>
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`移除 ${record.host}:${record.port} 的主机密钥信任`}
                              onClick={() => setRemoveTarget(record)}
                            >
                              <Trash2 size={12} aria-hidden="true" />
                              移除
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="settings-note">
                    <ShieldCheck size={13} aria-hidden="true" />
                    <span>
                      安全存储不可用时，凭据操作会被直接拒绝，绝不回退为明文保存。SSH
                      连接、认证、主机密钥校验、远程 PTY、SFTP
                      与文件传输均由主进程完成；渲染进程只接收任务快照，不接触 SSH Client、SFTP
                      通道或文件流。
                    </span>
                  </div>
                  {securityStatusError ? (
                    <div className="settings-actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void loadSecurityStatus()}
                      >
                        <RotateCcw size={13} aria-hidden="true" />
                        重新读取安全状态
                      </Button>
                    </div>
                  ) : null}
                </div>
              </section>

              <section
                className="settings-section settings-panel"
                id="settings-panel-app-info"
                role="tabpanel"
                aria-labelledby="settings-tab-app-info"
                hidden={activeSection !== 'app-info'}
              >
                <header className="settings-section__header">
                  <h2 className="settings-section__title" id="settings-app-info">
                    <Monitor size={14} aria-hidden="true" />
                    应用信息
                    <Badge tone="neutral" style={{ marginLeft: 6 }}>
                      只读
                    </Badge>
                  </h2>
                  <p className="settings-section__description">
                    来自 preload 中的固定 bridge 方法；所有方法均为固定领域接口，不提供任意 IPC
                    转发能力。
                  </p>
                </header>
                <div className="settings-section__body">
                  {bridgeStatus === 'ready' && appInfo ? (
                    <dl className="app-info-grid">
                      <div>
                        <dt>应用</dt>
                        <dd>{appInfo.appName}</dd>
                      </div>
                      <div>
                        <dt>版本</dt>
                        <dd>{appInfo.appVersion}</dd>
                      </div>
                      <div>
                        <dt>平台</dt>
                        <dd>{PLATFORM_LABELS[appInfo.platform] ?? appInfo.platform}</dd>
                      </div>
                      <div>
                        <dt>构建</dt>
                        <dd>{appInfo.isPackaged ? '已打包' : '开发模式'}</dd>
                      </div>
                      <div>
                        <dt>Electron</dt>
                        <dd>{appInfo.electronVersion}</dd>
                      </div>
                      <div>
                        <dt>Chromium</dt>
                        <dd>{appInfo.chromeVersion}</dd>
                      </div>
                    </dl>
                  ) : bridgeStatus === 'unavailable' ? (
                    <>
                      <div className="demo-note">
                        <Info size={13} aria-hidden="true" />
                        <span>
                          当前环境未加载 Electron preload
                          bridge（可能是浏览器预览）。应用信息不可用，
                          本地设置与连接存储也保持禁用，不会使用浏览器存储作为替代。
                          {bridgeError ? ` 原因：${bridgeError}` : ''}
                        </span>
                      </div>
                      <div className="settings-actions">
                        <Button size="sm" variant="secondary" onClick={() => void loadAppInfo()}>
                          <RotateCcw size={13} aria-hidden="true" />
                          重新读取
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="table-muted">正在读取只读应用信息…</p>
                  )}

                  <div className="settings-note">
                    <ShieldCheck size={13} aria-hidden="true" />
                    <span>
                      安全边界：渲染进程无法访问 Node.js、文件系统或原始 ipcRenderer；IPC
                      仅暴露应用信息、安全状态、设置、主机密钥、诊断日志与连接配置的固定方法。秘密内容不经由渲染进程传输。
                    </span>
                  </div>
                </div>
              </section>

              <section
                className="settings-section settings-panel"
                id="settings-panel-demo"
                role="tabpanel"
                aria-labelledby="settings-tab-demo"
                hidden={activeSection !== 'demo'}
              >
                <header className="settings-section__header">
                  <h2 className="settings-section__title" id="settings-demo">
                    <Trash2 size={14} aria-hidden="true" />
                    会话与传输记录
                  </h2>
                  <p className="settings-section__description">
                    断开当前 SSH 会话，并清理主进程中已经结束的传输历史。
                  </p>
                </header>
                <div className="settings-section__body">
                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">命令历史</p>
                      <p className="settings-row__description">
                        默认关闭。启用后，只有在快速命令发送确认中勾选「记录本次发送」时，才会保存已渲染的命令正文与目标会话信息；终端输入、输出、退出码和普通日志不会进入命令历史。关闭后仍可查看和管理已有记录，但不会新增。
                      </p>
                    </div>
                    <div className="settings-row__control settings-actions">
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={commandHistoryEnabled}
                          onChange={(event) =>
                            void updatePreferences({
                              commandHistoryEnabled: event.target.checked,
                            })
                          }
                        />
                        <span>{commandHistoryEnabled ? '已启用' : '已关闭（默认）'}</span>
                      </label>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setConfirmClearHistory(true)}
                      >
                        <Trash2 size={12} aria-hidden="true" />
                        清空命令历史
                      </Button>
                    </div>
                  </div>
                  <div className="settings-note">
                    <Info size={13} aria-hidden="true" />
                    <span>
                      命令历史独立保存在本机应用数据目录的 command-history.json，最多 200
                      条；该文件未额外加密，不记录终端输出或退出码。清空操作可恢复损坏的历史文件，不会影响诊断日志。
                    </span>
                  </div>
                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">自动重连</p>
                      <p className="settings-row__description">
                        默认关闭。启用后，仅在网络错误、连接超时、DNS
                        解析失败、连接被拒绝或服务器关闭连接时自动重试，最多 5 次，间隔依次为
                        1、2、4、8、15
                        秒。认证失败、主机密钥变化、手动取消、主动断开、关闭标签或应用退出都不会触发自动重试。
                      </p>
                      <p className="settings-row__description">
                        每次重试都会重新执行完整的 SSH
                        认证与主机密钥校验，不会自动信任新密钥，不会重放断线前的终端输入、未确认的快速命令或其他待发送数据，也不会恢复旧的远程
                        Shell、前台进程或工作目录。重试计划仅存在于运行中的应用内，不会写入磁盘。
                      </p>
                    </div>
                    <div className="settings-row__control settings-actions">
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          aria-label="启用自动重连"
                          checked={autoReconnectEnabled}
                          onChange={(event) =>
                            void updatePreferences({
                              autoReconnectEnabled: event.target.checked,
                            })
                          }
                        />
                        <span>{autoReconnectEnabled ? '已启用' : '已关闭（默认）'}</span>
                      </label>
                    </div>
                  </div>
                  <div className="settings-row">
                    <div>
                      <p className="settings-row__label">重置会话状态</p>
                      <p className="settings-row__description">
                        断开所有 SSH
                        会话不会影响本机连接配置、凭据存储或主机密钥信任记录。清空传输记录只会移除已结束的任务，进行中的任务仍由主进程管理。
                      </p>
                    </div>
                    <div className="settings-row__control settings-actions">
                      <Button size="sm" variant="secondary" onClick={() => void resetAppearance()}>
                        <RotateCcw size={12} aria-hidden="true" />
                        恢复默认外观
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => void clearTransfers()}>
                        <Trash2 size={12} aria-hidden="true" />
                        清空传输记录
                      </Button>
                      <Button size="sm" variant="danger" onClick={closeAllSessions}>
                        断开全部 SSH 会话
                      </Button>
                    </div>
                  </div>
                </div>
              </section>

              <section
                className="settings-section settings-panel"
                id="settings-panel-shortcuts"
                role="tabpanel"
                aria-labelledby="settings-tab-shortcuts"
                hidden={activeSection !== 'shortcuts'}
              >
                <header className="settings-section__header">
                  <h2 className="settings-section__title" id="settings-shortcuts">
                    <Keyboard size={14} aria-hidden="true" />
                    快捷键
                  </h2>
                </header>
                <div className="settings-section__body">
                  <div className="shortcut-list">
                    <span className="shortcut-list__item">
                      <kbd className="kbd">{formatShortcut('K')}</kbd> 全局搜索
                    </span>
                    <span className="shortcut-list__item">
                      <kbd className="kbd">{formatShortcut('P', { shift: true })}</kbd> 命令面板
                    </span>
                    <span className="shortcut-list__item">
                      <kbd className="kbd">{formatShortcut('K', { shift: true })}</kbd>{' '}
                      快速命令与命令历史
                    </span>
                    <span className="shortcut-list__item">
                      <kbd className="kbd">{formatShortcut('B')}</kbd> 收起 / 展开服务器侧栏
                    </span>
                    <span className="shortcut-list__item">
                      <kbd className="kbd">{formatShortcut(',')}</kbd> 打开设置
                    </span>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>

      {removeTarget ? (
        <Modal
          title="移除主机密钥信任？"
          description="该操作只影响本机信任记录。"
          width={470}
          onClose={() => {
            if (!removing) setRemoveTarget(null)
          }}
          footer={
            <>
              <Button
                variant="danger"
                disabled={removing}
                onClick={() => void confirmRemoveHostKey()}
              >
                <Trash2 size={13} aria-hidden="true" />
                {removing ? '移除中…' : '移除信任'}
              </Button>
              <Button variant="ghost" disabled={removing} onClick={() => setRemoveTarget(null)}>
                取消
              </Button>
            </>
          }
        >
          <div className="delete-confirm">
            <div className="delete-confirm__target">
              <span className="delete-confirm__icon" aria-hidden="true">
                <KeyRound size={16} />
              </span>
              <div>
                <p className="delete-confirm__name">
                  {removeTarget.host}:{removeTarget.port}
                </p>
                <p className="delete-confirm__address">{removeTarget.algorithm}</p>
              </div>
            </div>
            <p className="delete-confirm__message">
              移除后，下次连接该端点时需要重新核对并显式接受主机密钥。若远端密钥已变化，应用仍会拒绝自动信任。
            </p>
            <div className="delete-confirm__note">
              <Info size={13} aria-hidden="true" />
              <span>不会断开现有 SSH 会话，也不会修改远端服务器上的任何配置。</span>
            </div>
          </div>
        </Modal>
      ) : null}

      {confirmClearHistory ? (
        <Modal
          title="清空命令历史？"
          description="该操作会删除本机保存的全部快速命令历史。"
          width={470}
          onClose={() => {
            if (!clearingCommandHistory) setConfirmClearHistory(false)
          }}
          footer={
            <>
              <Button
                variant="danger"
                disabled={clearingCommandHistory}
                onClick={() => void clearCommandHistory()}
              >
                <Trash2 size={13} aria-hidden="true" />
                {clearingCommandHistory ? '清空中…' : '确认清空'}
              </Button>
              <Button
                variant="ghost"
                disabled={clearingCommandHistory}
                onClick={() => setConfirmClearHistory(false)}
              >
                取消
              </Button>
            </>
          }
        >
          <div className="delete-confirm">
            <p className="delete-confirm__message">
              清空只影响本机应用数据目录中的命令历史，不会删除自定义命令、诊断日志或连接配置。
            </p>
            <div className="delete-confirm__note">
              <Info size={13} aria-hidden="true" />
              <span>
                命令历史文件未额外加密；清空后无法恢复。若历史文件已损坏，该操作会写入空历史以恢复可用状态。
              </span>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
