import type { AppPreferences } from '../types/preferences'
import type { WallpaperIntensity } from '../types/wallpaper'

export const APP_NAME = 'TermForge'

export const UI_FONT_SIZES = [12, 13, 14, 15] as const

export const DEFAULT_UI_FONT_SIZE = 13

/**
 * UI font families are allow-listed identifiers resolved to fixed stacks; the
 * renderer scales every typography token from DEFAULT_UI_FONT_SIZE.
 */
export const UI_FONT_FAMILIES = {
  system:
    "'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif",
  segoe:
    "'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
  yahei:
    "'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Segoe UI', system-ui, sans-serif",
} as const

export const UI_FONT_FAMILY_IDS = ['system', 'segoe', 'yahei'] as const satisfies readonly (keyof typeof UI_FONT_FAMILIES)[]

export type UiFontFamilyId = (typeof UI_FONT_FAMILY_IDS)[number]

export const UI_FONT_LABELS: Record<UiFontFamilyId, string> = {
  system: '系统默认（Segoe UI / 微软雅黑）',
  segoe: 'Segoe UI 优先',
  yahei: '微软雅黑优先',
}

export const TERMINAL_FONT_SIZE_MIN = 10

export const TERMINAL_FONT_SIZE_MAX = 20

export const TERMINAL_FONT_SIZES = [
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
] as const

export const DEFAULT_TERMINAL_FONT_SIZE = 13

/**
 * Font families are stored as allow-listed identifiers, never as free-form CSS.
 * Renderer code resolves the identifier to one of these fixed stacks. Every
 * stack falls back to a CJK-capable face before the generic monospace family.
 */
export const TERMINAL_FONT_FAMILIES = {
  cascadia:
    "'Cascadia Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei UI', 'PingFang SC', monospace",
  consolas:
    "Consolas, 'Courier New', 'Microsoft YaHei UI', 'PingFang SC', monospace",
  jetbrains:
    "'JetBrains Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei UI', 'PingFang SC', monospace",
  fira:
    "'Fira Code', 'Cascadia Code', Consolas, 'Microsoft YaHei UI', 'PingFang SC', monospace",
  'source-code-pro':
    "'Source Code Pro', 'Cascadia Code', Consolas, 'Microsoft YaHei UI', 'PingFang SC', monospace",
  'sf-mono':
    "'SF Mono', ui-monospace, 'Cascadia Code', 'Microsoft YaHei UI', 'PingFang SC', monospace",
  'ibm-plex':
    "'IBM Plex Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei UI', 'PingFang SC', monospace",
  system:
    "ui-monospace, 'Cascadia Mono', Consolas, 'Microsoft YaHei UI', 'PingFang SC', monospace",
} as const

export const TERMINAL_FONT_FAMILY_IDS = [
  'cascadia',
  'consolas',
  'jetbrains',
  'fira',
  'source-code-pro',
  'sf-mono',
  'ibm-plex',
  'system',
] as const satisfies readonly (keyof typeof TERMINAL_FONT_FAMILIES)[]

export type TerminalFontFamilyId = (typeof TERMINAL_FONT_FAMILY_IDS)[number]

export const TERMINAL_FONT_LABELS: Record<TerminalFontFamilyId, string> = {
  cascadia: 'Cascadia Mono',
  consolas: 'Consolas',
  jetbrains: 'JetBrains Mono',
  fira: 'Fira Code',
  'source-code-pro': 'Source Code Pro',
  'sf-mono': 'SF Mono',
  'ibm-plex': 'IBM Plex Mono',
  system: '系统等宽字体',
}

export const TERMINAL_CURSOR_STYLES = ['block', 'underline', 'bar'] as const

export const TERMINAL_SCROLLBACK_OPTIONS = [1_000, 5_000, 10_000, 20_000] as const

export const DEFAULT_TERMINAL_SCROLLBACK = 5_000

export const TRANSFER_MAX_CONCURRENT_OPTIONS = [1, 2, 3, 4] as const

export const TRANSFER_MAX_PER_SESSION_OPTIONS = [1, 2] as const

export const DEFAULT_TRANSFER_MAX_CONCURRENT = 2

export const DEFAULT_TRANSFER_MAX_PER_SESSION = 1

export const MAX_TAGS = 8
export const MAX_TAG_LENGTH = 24

export const MAX_CONNECTIONS = 2_000
export const MAX_CONNECTION_GROUPS = 200
/**
 * The theoretical maximum for catalogs migrated from v2, where every
 * connection could carry its own distinct set of eight free-text tags.
 */
export const MAX_CONNECTION_TAGS = MAX_CONNECTIONS * MAX_TAGS
export const MAX_CONNECTION_USAGE_RECORDS = 100

export const MAX_JUMP_HOPS = 4

export const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024
export const MAX_LOG_FILES = 5
export const DEFAULT_LOG_LEVEL: AppPreferences['logLevel'] = 'info'

export const WALLPAPER_INTENSITIES = ['soft', 'balanced', 'strong'] as const

export const DEFAULT_WALLPAPER_INTENSITY: WallpaperIntensity = 'balanced'

export const GRADIENT_INTENSITY_MIN = 0
export const GRADIENT_INTENSITY_MAX = 100
export const DEFAULT_GRADIENT_INTENSITY = 35

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  theme: 'aurora',
  dbxThemeMode: 'system',
  gradientIntensity: DEFAULT_GRADIENT_INTENSITY,
  uiFontFamily: 'system',
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  terminalFontFamily: 'cascadia',
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalScrollback: DEFAULT_TERMINAL_SCROLLBACK,
  transferMaxConcurrent: DEFAULT_TRANSFER_MAX_CONCURRENT,
  transferMaxPerSession: DEFAULT_TRANSFER_MAX_PER_SESSION,
  logLevel: 'info',
  wallpaperEnabled: false,
  wallpaperIntensity: DEFAULT_WALLPAPER_INTENSITY,
  commandHistoryEnabled: false,
  autoReconnectEnabled: false,
}
