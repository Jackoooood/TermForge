import type { TerminalFontFamilyId, UiFontFamilyId } from '../constants/app'
import type { DbxThemeMode, ThemePreference } from '../theme/catalog'
import type { LogLevel } from './logging'
import type { WallpaperIntensity } from './wallpaper'

export type {
  ClassicThemeStyle,
  DbxThemeMode,
  DbxThemeStyle,
  ResolvedTheme,
  ThemePreference,
  ThemeStyle,
} from '../theme/catalog'

export type TerminalCursorStyle = 'block' | 'underline' | 'bar'

export interface AppPreferences {
  theme: ThemePreference
  /** Light/dark mode for dbx palettes; classic styles keep their fixed mode. */
  dbxThemeMode: DbxThemeMode
  /** Aurora gradient opacity, 0–100. Obsidian ignores gradient layers. */
  gradientIntensity: number
  uiFontFamily: UiFontFamilyId
  uiFontSize: number
  terminalFontFamily: TerminalFontFamilyId
  terminalFontSize: number
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorBlink: boolean
  terminalScrollback: number
  transferMaxConcurrent: number
  transferMaxPerSession: number
  logLevel: LogLevel
  wallpaperEnabled: boolean
  wallpaperIntensity: WallpaperIntensity
  commandHistoryEnabled: boolean
  autoReconnectEnabled: boolean
}
