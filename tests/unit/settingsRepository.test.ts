// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import { SETTINGS_STORE_VERSION } from '@shared/schemas/settings'
import { SettingsRepository } from '../../src/main/storage/settingsRepository'

function withoutV6Appearance(preferences: Record<string, unknown>): Record<string, unknown> {
  const next = { ...preferences }
  delete next.dbxThemeMode
  delete next.uiFontFamily
  delete next.uiFontSize
  return next
}

describe('settings repository', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-settings-'))
    filePath = join(directory, 'settings.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('uses validated defaults without creating a file when none exists', async () => {
    const snapshot = await new SettingsRepository(filePath).get()
    expect(snapshot).toEqual({ preferences: DEFAULT_APP_PREFERENCES, warnings: [] })
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists a versioned envelope and reloads it across instances', async () => {
    const repository = new SettingsRepository(filePath)
    const preferences = {
      ...DEFAULT_APP_PREFERENCES,
      theme: 'system' as const,
      terminalFontFamily: 'jetbrains' as const,
      terminalCursorStyle: 'bar' as const,
      terminalCursorBlink: false,
      terminalScrollback: 20_000,
      transferMaxConcurrent: 4,
      transferMaxPerSession: 2,
      logLevel: 'debug' as const,
    }

    await expect(repository.update(preferences)).resolves.toEqual({ preferences, warnings: [] })

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      preferences: unknown
    }
    expect(persisted.version).toBe(SETTINGS_STORE_VERSION)
    expect(persisted.preferences).toEqual(preferences)

    const reloaded = await new SettingsRepository(filePath).get()
    expect(reloaded.preferences).toEqual(preferences)
    expect(reloaded.warnings).toEqual([])
  })

  it('migrates version 1 settings in memory without warning or rewriting the file', async () => {
    const legacyPreferences = {
      theme: 'light',
      terminalFontFamily: 'jetbrains',
      terminalFontSize: 16,
      terminalCursorStyle: 'block',
      terminalCursorBlink: true,
      terminalScrollback: 5_000,
      transferMaxConcurrent: 3,
      transferMaxPerSession: 2,
      logLevel: 'warn',
    }
    const original = JSON.stringify({ version: 1, preferences: legacyPreferences })
    await writeFile(filePath, original, 'utf8')

    const snapshot = await new SettingsRepository(filePath).get()
    expect(snapshot.warnings).toEqual([])
    expect(snapshot.preferences).toEqual({
      ...legacyPreferences,
      theme: 'mist',
      dbxThemeMode: DEFAULT_APP_PREFERENCES.dbxThemeMode,
      gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
      uiFontFamily: DEFAULT_APP_PREFERENCES.uiFontFamily,
      uiFontSize: DEFAULT_APP_PREFERENCES.uiFontSize,
      wallpaperEnabled: DEFAULT_APP_PREFERENCES.wallpaperEnabled,
      wallpaperIntensity: DEFAULT_APP_PREFERENCES.wallpaperIntensity,
      commandHistoryEnabled: false,
      autoReconnectEnabled: false,
    })
    expect(await readFile(filePath, 'utf8')).toBe(original)

    const repository = new SettingsRepository(filePath)
    await repository.get()
    await repository.update({ ...snapshot.preferences, wallpaperEnabled: true })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      preferences: { wallpaperEnabled: boolean; wallpaperIntensity: string }
    }
    expect(persisted.version).toBe(SETTINGS_STORE_VERSION)
    expect(persisted.preferences).toMatchObject({
      wallpaperEnabled: true,
      wallpaperIntensity: DEFAULT_APP_PREFERENCES.wallpaperIntensity,
    })
  })

  it('migrates version 3 settings and keeps automatic reconnect disabled by default', async () => {
    const legacyPreferences = withoutV6Appearance({
      ...DEFAULT_APP_PREFERENCES,
      theme: 'light',
      commandHistoryEnabled: true,
    })
    delete legacyPreferences.autoReconnectEnabled
    delete legacyPreferences.gradientIntensity
    const original = JSON.stringify({ version: 3, preferences: legacyPreferences })
    await writeFile(filePath, original, 'utf8')

    const snapshot = await new SettingsRepository(filePath).get()
    expect(snapshot.warnings).toEqual([])
    expect(snapshot.preferences).toEqual({
      ...legacyPreferences,
      theme: 'mist',
      dbxThemeMode: DEFAULT_APP_PREFERENCES.dbxThemeMode,
      gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
      uiFontFamily: DEFAULT_APP_PREFERENCES.uiFontFamily,
      uiFontSize: DEFAULT_APP_PREFERENCES.uiFontSize,
      autoReconnectEnabled: false,
    })
    expect(await readFile(filePath, 'utf8')).toBe(original)

    const repository = new SettingsRepository(filePath)
    await repository.get()
    await repository.update({ ...snapshot.preferences, autoReconnectEnabled: true })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      preferences: { autoReconnectEnabled: boolean }
    }
    expect(persisted.version).toBe(SETTINGS_STORE_VERSION)
    expect(persisted.preferences.autoReconnectEnabled).toBe(true)
  })

  it('migrates version 2 settings and keeps history and automatic reconnect disabled', async () => {
    const legacyPreferences = withoutV6Appearance({
      ...DEFAULT_APP_PREFERENCES,
      theme: 'light',
      wallpaperEnabled: true,
      wallpaperIntensity: 'strong',
    })
    delete legacyPreferences.commandHistoryEnabled
    delete legacyPreferences.autoReconnectEnabled
    delete legacyPreferences.gradientIntensity
    const original = JSON.stringify({ version: 2, preferences: legacyPreferences })
    await writeFile(filePath, original, 'utf8')

    const snapshot = await new SettingsRepository(filePath).get()
    expect(snapshot.warnings).toEqual([])
    expect(snapshot.preferences).toEqual({
      ...legacyPreferences,
      theme: 'mist',
      dbxThemeMode: DEFAULT_APP_PREFERENCES.dbxThemeMode,
      gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
      uiFontFamily: DEFAULT_APP_PREFERENCES.uiFontFamily,
      uiFontSize: DEFAULT_APP_PREFERENCES.uiFontSize,
      commandHistoryEnabled: false,
      autoReconnectEnabled: false,
    })
    expect(await readFile(filePath, 'utf8')).toBe(original)

    const repository = new SettingsRepository(filePath)
    await repository.get()
    await repository.update({ ...snapshot.preferences, commandHistoryEnabled: true })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      preferences: { commandHistoryEnabled: boolean; autoReconnectEnabled: boolean }
    }
    expect(persisted.version).toBe(SETTINGS_STORE_VERSION)
    expect(persisted.preferences.commandHistoryEnabled).toBe(true)
    expect(persisted.preferences.autoReconnectEnabled).toBe(false)
  })

  it('migrates version 4 theme preferences in memory without rewriting the file', async () => {
    const legacyPreferences = withoutV6Appearance({
      ...DEFAULT_APP_PREFERENCES,
      theme: 'dark',
      terminalFontSize: 16,
    })
    delete legacyPreferences.gradientIntensity
    const original = JSON.stringify({ version: 4, preferences: legacyPreferences })
    await writeFile(filePath, original, 'utf8')

    const snapshot = await new SettingsRepository(filePath).get()
    expect(snapshot.warnings).toEqual([])
    expect(snapshot.preferences).toEqual({
      ...legacyPreferences,
      theme: 'aurora',
      dbxThemeMode: DEFAULT_APP_PREFERENCES.dbxThemeMode,
      gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
      uiFontFamily: DEFAULT_APP_PREFERENCES.uiFontFamily,
      uiFontSize: DEFAULT_APP_PREFERENCES.uiFontSize,
    })
    expect(await readFile(filePath, 'utf8')).toBe(original)

    const repository = new SettingsRepository(filePath)
    await repository.get()
    await repository.update({ ...snapshot.preferences, theme: 'mist' })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      preferences: { theme: string; gradientIntensity: number }
    }
    expect(persisted.version).toBe(SETTINGS_STORE_VERSION)
    expect(persisted.preferences).toMatchObject({
      theme: 'mist',
      gradientIntensity: DEFAULT_APP_PREFERENCES.gradientIntensity,
    })
  })

  it('migrates version 5 settings and backfills dbx mode and interface fonts', async () => {
    const legacyPreferences = withoutV6Appearance({
      ...DEFAULT_APP_PREFERENCES,
      theme: 'obsidian',
      terminalFontFamily: 'fira',
      terminalFontSize: 14,
      wallpaperEnabled: true,
    })
    const original = JSON.stringify({ version: 5, preferences: legacyPreferences })
    await writeFile(filePath, original, 'utf8')

    const snapshot = await new SettingsRepository(filePath).get()
    expect(snapshot.warnings).toEqual([])
    expect(snapshot.preferences).toEqual({
      ...legacyPreferences,
      dbxThemeMode: DEFAULT_APP_PREFERENCES.dbxThemeMode,
      uiFontFamily: DEFAULT_APP_PREFERENCES.uiFontFamily,
      uiFontSize: DEFAULT_APP_PREFERENCES.uiFontSize,
    })
    expect(await readFile(filePath, 'utf8')).toBe(original)

    const repository = new SettingsRepository(filePath)
    await repository.get()
    await repository.update({ ...snapshot.preferences, dbxThemeMode: 'dark' })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      preferences: { theme: string; dbxThemeMode: string }
    }
    expect(persisted.version).toBe(SETTINGS_STORE_VERSION)
    expect(persisted.preferences).toMatchObject({ theme: 'obsidian', dbxThemeMode: 'dark' })
  })

  it('recovers invalid fields individually, warns, and never overwrites on load', async () => {
    const damaged = {
      version: SETTINGS_STORE_VERSION,
      preferences: {
        ...DEFAULT_APP_PREFERENCES,
        theme: 'mist',
        terminalFontSize: 999,
        logLevel: 'verbose',
        unexpected: 'ignored',
      },
    }
    const original = JSON.stringify(damaged)
    await writeFile(filePath, original, 'utf8')

    const snapshot = await new SettingsRepository(filePath).get()
    expect(snapshot.preferences).toMatchObject({
      theme: 'mist',
      terminalFontSize: DEFAULT_APP_PREFERENCES.terminalFontSize,
      logLevel: DEFAULT_APP_PREFERENCES.logLevel,
    })
    expect(snapshot.warnings).toHaveLength(1)
    expect(snapshot.warnings[0]).toContain('terminalFontSize')
    expect(snapshot.warnings[0]).toContain('logLevel')
    expect(await readFile(filePath, 'utf8')).toBe(original)
  })

  it('falls back to defaults for corrupt or unreadable files without clobbering them', async () => {
    await writeFile(filePath, '{not-json', 'utf8')
    const corrupt = await new SettingsRepository(filePath).get()
    expect(corrupt.preferences).toEqual(DEFAULT_APP_PREFERENCES)
    expect(corrupt.warnings[0]).toContain('默认值')
    expect(await readFile(filePath, 'utf8')).toBe('{not-json')

    const unreadablePath = join(directory, 'settings-directory.json')
    await mkdir(unreadablePath)
    const unreadable = await new SettingsRepository(unreadablePath).get()
    expect(unreadable.preferences).toEqual(DEFAULT_APP_PREFERENCES)
    expect(unreadable.warnings).toHaveLength(1)
  })

  it('rejects invalid updates and reports write failures without changing memory state', async () => {
    const directoryPath = join(directory, 'settings-as-directory.json')
    await mkdir(directoryPath)
    const repository = new SettingsRepository(directoryPath)
    const initial = await repository.get()

    await expect(
      repository.update({ ...initial.preferences, terminalFontSize: 7 }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(repository.update(initial.preferences)).rejects.toMatchObject({
      code: 'storage-write-failed',
    })

    await expect(repository.get()).resolves.toEqual(initial)
    expect((await repository.get()).preferences).toEqual(DEFAULT_APP_PREFERENCES)
  })

  it('serializes concurrent updates instead of interleaving writes', async () => {
    const repository = new SettingsRepository(filePath)
    await repository.get()

    await Promise.all([
      repository.update({ ...DEFAULT_APP_PREFERENCES, theme: 'mist' }),
      repository.update({ ...DEFAULT_APP_PREFERENCES, theme: 'system' }),
      repository.update({ ...DEFAULT_APP_PREFERENCES, terminalFontSize: 16 }),
    ])

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      preferences: { terminalFontSize: number }
    }
    expect(persisted.preferences.terminalFontSize).toBe(16)
  })
})
