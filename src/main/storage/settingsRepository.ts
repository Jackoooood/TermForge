import { DEFAULT_APP_PREFERENCES } from '../../shared/constants/app'
import {
  legacyPersistedSettingsV1Schema,
  legacyPersistedSettingsV2Schema,
  legacyPersistedSettingsV3Schema,
  legacyPersistedSettingsV4Schema,
  legacyPersistedSettingsV5Schema,
  migrateLegacyTheme,
  parsePreferences,
  persistedSettingsSchema,
  SETTINGS_STORE_VERSION,
  settingsPreferencesSchema,
  type LegacyV5Preferences,
} from '../../shared/schemas/settings'
import type { AppPreferences } from '../../shared/types/preferences'
import type { SettingsSnapshot } from '../../shared/types/ipc'
import { AppOperationError } from '../errors'
import { readJsonFile, writeJsonFileAtomic } from './jsonFile'

export interface SettingsStore {
  get(): Promise<SettingsSnapshot>
  update(preferences: AppPreferences): Promise<SettingsSnapshot>
}

function clonePreferences(preferences: AppPreferences): AppPreferences {
  return { ...preferences }
}

function withCurrentAppearance(preferences: LegacyV5Preferences): AppPreferences {
  return {
    ...preferences,
    dbxThemeMode: DEFAULT_APP_PREFERENCES.dbxThemeMode,
    uiFontFamily: DEFAULT_APP_PREFERENCES.uiFontFamily,
    uiFontSize: DEFAULT_APP_PREFERENCES.uiFontSize,
  }
}

function recoveryWarnings(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['设置文件内容无效，已恢复全部默认值；原文件未被覆盖。']
  }
  const record = value as Record<string, unknown>
  const preferences = record.preferences
  if (preferences === null || typeof preferences !== 'object' || Array.isArray(preferences)) {
    return ['设置文件缺少有效的 preferences 字段，已恢复默认值；原文件未被覆盖。']
  }
  const strict = settingsPreferencesSchema.safeParse(preferences)
  if (strict.success) return []
  const fields = new Set(
    strict.error.issues.map((issue) => String(issue.path[0] ?? 'unknown')).filter(Boolean),
  )
  return [
    `设置文件中有 ${fields.size} 个字段无效（${[...fields].join('、')}），已对这些字段使用默认值；请在设置页确认后重新保存。`,
  ]
}

/**
 * Persists only non-sensitive UI/terminal/transfer/logging preferences. The
 * file is versioned, schema-validated and written atomically; a damaged file is
 * never overwritten merely by loading it.
 */
export class SettingsRepository implements SettingsStore {
  private preferences: AppPreferences | null = null
  private warnings: string[] = []
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  get(): Promise<SettingsSnapshot> {
    return this.exclusive(async () => {
      await this.loadState()
      return this.snapshot()
    })
  }

  update(preferences: AppPreferences): Promise<SettingsSnapshot> {
    return this.exclusive(async () => {
      const parsed = settingsPreferencesSchema.safeParse(preferences)
      if (!parsed.success) {
        throw new AppOperationError('invalid-input', '设置参数未通过校验，未写入任何数据。')
      }
      const envelope = {
        version: SETTINGS_STORE_VERSION,
        preferences: parsed.data,
      }
      await writeJsonFileAtomic(this.filePath, envelope, '应用设置')
      this.preferences = clonePreferences(parsed.data)
      this.warnings = []
      return this.snapshot()
    })
  }

  private snapshot(): SettingsSnapshot {
    return {
      preferences: clonePreferences(this.preferences ?? DEFAULT_APP_PREFERENCES),
      warnings: [...this.warnings],
    }
  }

  private async loadState(): Promise<void> {
    if (this.preferences) return

    let raw: unknown
    try {
      raw = await readJsonFile(this.filePath, '应用设置')
    } catch {
      this.preferences = clonePreferences(DEFAULT_APP_PREFERENCES)
      this.warnings = [
        '无法读取应用设置，已使用默认值；请检查本机用户数据目录权限。现有设置文件未被覆盖。',
      ]
      return
    }
    if (raw === null) {
      this.preferences = clonePreferences(DEFAULT_APP_PREFERENCES)
      this.warnings = []
      return
    }

    const persisted = persistedSettingsSchema.safeParse(raw)
    if (persisted.success) {
      this.preferences = clonePreferences(persisted.data.preferences)
      this.warnings = []
      return
    }

    const legacyV5 = legacyPersistedSettingsV5Schema.safeParse(raw)
    if (legacyV5.success) {
      this.preferences = withCurrentAppearance(legacyV5.data.preferences)
      this.warnings = []
      return
    }

    const legacyV4 = legacyPersistedSettingsV4Schema.safeParse(raw)
    if (legacyV4.success) {
      this.preferences = withCurrentAppearance({
        ...legacyV4.data.preferences,
        theme: migrateLegacyTheme(legacyV4.data.preferences.theme),
        gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
      })
      this.warnings = []
      return
    }

    const legacyV3 = legacyPersistedSettingsV3Schema.safeParse(raw)
    if (legacyV3.success) {
      this.preferences = withCurrentAppearance({
        ...legacyV3.data.preferences,
        theme: migrateLegacyTheme(legacyV3.data.preferences.theme),
        gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
        autoReconnectEnabled: DEFAULT_APP_PREFERENCES.autoReconnectEnabled,
      })
      this.warnings = []
      return
    }

    const legacyV2 = legacyPersistedSettingsV2Schema.safeParse(raw)
    if (legacyV2.success) {
      this.preferences = withCurrentAppearance({
        ...legacyV2.data.preferences,
        theme: migrateLegacyTheme(legacyV2.data.preferences.theme),
        gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
        commandHistoryEnabled: DEFAULT_APP_PREFERENCES.commandHistoryEnabled,
        autoReconnectEnabled: DEFAULT_APP_PREFERENCES.autoReconnectEnabled,
      })
      this.warnings = []
      return
    }

    const legacyV1 = legacyPersistedSettingsV1Schema.safeParse(raw)
    if (legacyV1.success) {
      this.preferences = withCurrentAppearance({
        ...legacyV1.data.preferences,
        theme: migrateLegacyTheme(legacyV1.data.preferences.theme),
        gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
        wallpaperEnabled: DEFAULT_APP_PREFERENCES.wallpaperEnabled,
        wallpaperIntensity: DEFAULT_APP_PREFERENCES.wallpaperIntensity,
        commandHistoryEnabled: DEFAULT_APP_PREFERENCES.commandHistoryEnabled,
        autoReconnectEnabled: DEFAULT_APP_PREFERENCES.autoReconnectEnabled,
      })
      this.warnings = []
      return
    }

    this.warnings = recoveryWarnings(raw)
    const recovered =
      (raw && typeof raw === 'object' && 'preferences' in raw
        ? parsePreferences((raw as { preferences?: unknown }).preferences)
        : null) ?? clonePreferences(DEFAULT_APP_PREFERENCES)
    this.preferences = recovered
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
