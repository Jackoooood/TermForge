import { z } from 'zod'
import {
  DEFAULT_APP_PREFERENCES,
  GRADIENT_INTENSITY_MAX,
  GRADIENT_INTENSITY_MIN,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_FAMILY_IDS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SCROLLBACK_OPTIONS,
  TRANSFER_MAX_CONCURRENT_OPTIONS,
  TRANSFER_MAX_PER_SESSION_OPTIONS,
  UI_FONT_FAMILY_IDS,
  UI_FONT_SIZES,
  WALLPAPER_INTENSITIES,
} from '../constants/app'
import { CLASSIC_THEME_STYLES, DBX_THEME_MODES, THEME_PREFERENCES } from '../theme/catalog'
import { LOG_LEVELS } from '../types/logging'
import type { AppPreferences, ThemePreference } from '../types/preferences'

export const SETTINGS_STORE_VERSION = 6

const LEGACY_SETTINGS_STORE_VERSION_V5 = 5
const LEGACY_SETTINGS_STORE_VERSION_V4 = 4
const LEGACY_SETTINGS_STORE_VERSION_V3 = 3
const LEGACY_SETTINGS_STORE_VERSION_V2 = 2
const LEGACY_SETTINGS_STORE_VERSION_V1 = 1

function oneOfNumbers(values: readonly number[], message: string) {
  return z
    .number()
    .int(message)
    .refine((value) => values.includes(value), message)
}

const gradientIntensitySchema = z
  .number()
  .int('渐变强度必须是整数')
  .min(GRADIENT_INTENSITY_MIN, '渐变强度超出允许范围')
  .max(GRADIENT_INTENSITY_MAX, '渐变强度超出允许范围')

const terminalFontSizeSchema = z
  .number()
  .int('终端字号必须是整数')
  .min(TERMINAL_FONT_SIZE_MIN, '终端字号不在允许范围内')
  .max(TERMINAL_FONT_SIZE_MAX, '终端字号不在允许范围内')

export const settingsPreferencesSchema = z.strictObject({
  theme: z.enum(THEME_PREFERENCES, { message: '主题选项无效' }),
  dbxThemeMode: z.enum(DBX_THEME_MODES, { message: 'DBX 主题明暗选项无效' }),
  gradientIntensity: gradientIntensitySchema,
  uiFontFamily: z.enum(UI_FONT_FAMILY_IDS, { message: '界面字体选项无效' }),
  uiFontSize: oneOfNumbers(UI_FONT_SIZES, '界面字号不在允许范围内'),
  terminalFontFamily: z.enum(TERMINAL_FONT_FAMILY_IDS, { message: '终端字体选项无效' }),
  terminalFontSize: terminalFontSizeSchema,
  terminalCursorStyle: z.enum(TERMINAL_CURSOR_STYLES, { message: '光标样式选项无效' }),
  terminalCursorBlink: z.boolean({ message: '光标闪烁设置必须是布尔值' }),
  terminalScrollback: oneOfNumbers(TERMINAL_SCROLLBACK_OPTIONS, '回滚行数不在允许范围内'),
  transferMaxConcurrent: oneOfNumbers(
    TRANSFER_MAX_CONCURRENT_OPTIONS,
    '全局传输并发数不在允许范围内',
  ),
  transferMaxPerSession: oneOfNumbers(
    TRANSFER_MAX_PER_SESSION_OPTIONS,
    '单会话传输并发数不在允许范围内',
  ),
  logLevel: z.enum(LOG_LEVELS, { message: '日志级别选项无效' }),
  wallpaperEnabled: z.boolean({ message: '壁纸开关设置必须是布尔值' }),
  wallpaperIntensity: z.enum(WALLPAPER_INTENSITIES, { message: '壁纸浓度选项无效' }),
  commandHistoryEnabled: z.boolean({ message: '命令历史开关设置必须是布尔值' }),
  autoReconnectEnabled: z.boolean({ message: '自动重连开关设置必须是布尔值' }),
}) satisfies z.ZodType<AppPreferences>

export const persistedSettingsSchema = z.strictObject({
  version: z.literal(SETTINGS_STORE_VERSION),
  preferences: settingsPreferencesSchema,
})

const legacyThemePreferenceSchema = z.enum(['dark', 'light', 'system'], {
  message: '主题选项无效',
})

export function migrateLegacyTheme(theme: 'dark' | 'light' | 'system'): ThemePreference {
  if (theme === 'dark') return 'aurora'
  if (theme === 'light') return 'mist'
  return 'system'
}

export type LegacyV5Preferences = Omit<
  AppPreferences,
  'dbxThemeMode' | 'uiFontFamily' | 'uiFontSize'
>

/**
 * Version 5 shipped the three classic palettes without the dbx catalog or
 * interface typography. Those preferences backfill defaults in memory; the
 * file is only rewritten on the next explicit save.
 */
export const legacyV5ThemePreferenceSchema = z.enum([...CLASSIC_THEME_STYLES, 'system'], {
  message: '主题选项无效',
})

export const legacyPreferencesV5Schema = settingsPreferencesSchema
  .omit({
    dbxThemeMode: true,
    uiFontFamily: true,
    uiFontSize: true,
  })
  .extend({ theme: legacyV5ThemePreferenceSchema })

export const legacyPersistedSettingsV5Schema = z.strictObject({
  version: z.literal(LEGACY_SETTINGS_STORE_VERSION_V5),
  preferences: legacyPreferencesV5Schema,
})

/**
 * Version 4 shipped the dark/light/system palette. dark maps to Aurora,
 * light to Mist; system keeps resolving against the OS scheme. Gradient
 * intensity backfills the default.
 */
export const legacyPreferencesV4Schema = legacyPreferencesV5Schema
  .omit({ theme: true, gradientIntensity: true })
  .extend({ theme: legacyThemePreferenceSchema })

export const legacyPersistedSettingsV4Schema = z.strictObject({
  version: z.literal(LEGACY_SETTINGS_STORE_VERSION_V4),
  preferences: legacyPreferencesV4Schema,
})

/**
 * Versions 3/2/1 predate the modern theme palette and gradient intensity;
 * they share the legacy theme enum and backfill gradient defaults alongside
 * their own missing fields.
 */
export const legacyPreferencesV3Schema = legacyPreferencesV4Schema.omit({
  autoReconnectEnabled: true,
})

export const legacyPersistedSettingsV3Schema = z.strictObject({
  version: z.literal(LEGACY_SETTINGS_STORE_VERSION_V3),
  preferences: legacyPreferencesV3Schema,
})

export const legacyPreferencesV2Schema = legacyPreferencesV4Schema.omit({
  commandHistoryEnabled: true,
  autoReconnectEnabled: true,
})

export const legacyPersistedSettingsV2Schema = z.strictObject({
  version: z.literal(LEGACY_SETTINGS_STORE_VERSION_V2),
  preferences: legacyPreferencesV2Schema,
})

export const legacyPreferencesV1Schema = legacyPreferencesV4Schema.omit({
  wallpaperEnabled: true,
  wallpaperIntensity: true,
  commandHistoryEnabled: true,
  autoReconnectEnabled: true,
})

export const legacyPersistedSettingsV1Schema = z.strictObject({
  version: z.literal(LEGACY_SETTINGS_STORE_VERSION_V1),
  preferences: legacyPreferencesV1Schema,
})

/**
 * Used only when loading an older or damaged settings file. Unknown keys are
 * dropped and each invalid field independently falls back to its default; the
 * repository reports that recovery so the UI never silently claims a save.
 */
export const recoveredPreferencesSchema = z.object({
  theme: settingsPreferencesSchema.shape.theme.catch(DEFAULT_APP_PREFERENCES.theme),
  dbxThemeMode: settingsPreferencesSchema.shape.dbxThemeMode.catch(
    DEFAULT_APP_PREFERENCES.dbxThemeMode,
  ),
  gradientIntensity: gradientIntensitySchema.catch(DEFAULT_APP_PREFERENCES.gradientIntensity),
  uiFontFamily: settingsPreferencesSchema.shape.uiFontFamily.catch(
    DEFAULT_APP_PREFERENCES.uiFontFamily,
  ),
  uiFontSize: settingsPreferencesSchema.shape.uiFontSize.catch(DEFAULT_APP_PREFERENCES.uiFontSize),
  terminalFontFamily: settingsPreferencesSchema.shape.terminalFontFamily.catch(
    DEFAULT_APP_PREFERENCES.terminalFontFamily,
  ),
  terminalFontSize: settingsPreferencesSchema.shape.terminalFontSize.catch(
    DEFAULT_APP_PREFERENCES.terminalFontSize,
  ),
  terminalCursorStyle: settingsPreferencesSchema.shape.terminalCursorStyle.catch(
    DEFAULT_APP_PREFERENCES.terminalCursorStyle,
  ),
  terminalCursorBlink: settingsPreferencesSchema.shape.terminalCursorBlink.catch(
    DEFAULT_APP_PREFERENCES.terminalCursorBlink,
  ),
  terminalScrollback: settingsPreferencesSchema.shape.terminalScrollback.catch(
    DEFAULT_APP_PREFERENCES.terminalScrollback,
  ),
  transferMaxConcurrent: settingsPreferencesSchema.shape.transferMaxConcurrent.catch(
    DEFAULT_APP_PREFERENCES.transferMaxConcurrent,
  ),
  transferMaxPerSession: settingsPreferencesSchema.shape.transferMaxPerSession.catch(
    DEFAULT_APP_PREFERENCES.transferMaxPerSession,
  ),
  logLevel: settingsPreferencesSchema.shape.logLevel.catch(DEFAULT_APP_PREFERENCES.logLevel),
  wallpaperEnabled: settingsPreferencesSchema.shape.wallpaperEnabled.catch(
    DEFAULT_APP_PREFERENCES.wallpaperEnabled,
  ),
  wallpaperIntensity: settingsPreferencesSchema.shape.wallpaperIntensity.catch(
    DEFAULT_APP_PREFERENCES.wallpaperIntensity,
  ),
  commandHistoryEnabled: settingsPreferencesSchema.shape.commandHistoryEnabled.catch(
    DEFAULT_APP_PREFERENCES.commandHistoryEnabled,
  ),
  autoReconnectEnabled: settingsPreferencesSchema.shape.autoReconnectEnabled.catch(
    DEFAULT_APP_PREFERENCES.autoReconnectEnabled,
  ),
})

export function parsePreferences(value: unknown): AppPreferences | null {
  const strict = settingsPreferencesSchema.safeParse(value)
  if (strict.success) return strict.data

  const recovered = recoveredPreferencesSchema.safeParse(value)
  if (!recovered.success) return null
  return recovered.data
}
