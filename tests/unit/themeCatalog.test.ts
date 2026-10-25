// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  CLASSIC_THEME_STYLES,
  DBX_THEME_STYLES,
  THEME_CATALOG,
  THEME_STYLES,
  type ThemeStyle,
  nextThemeStyle,
  resolveThemeBackground,
  resolveThemeMode,
  resolveThemeSelection,
  themePreview,
} from '@shared/theme/catalog'

describe('theme catalog', () => {
  it('ships every classic and dbx palette with previews for both modes', () => {
    expect(CLASSIC_THEME_STYLES).toEqual(['aurora', 'obsidian', 'mist'])
    expect(DBX_THEME_STYLES).toHaveLength(13)
    expect(THEME_CATALOG.map((entry) => entry.id)).toEqual([...THEME_STYLES])

    for (const entry of THEME_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.hint.length).toBeGreaterThan(0)
      expect(entry.modes.length).toBeGreaterThan(0)
      for (const mode of ['light', 'dark'] as const) {
        expect(entry.preview[mode].background.length).toBeGreaterThan(0)
        expect(entry.preview[mode].panel.length).toBeGreaterThan(0)
        expect(entry.preview[mode].primary.length).toBeGreaterThan(0)
      }
    }
  })

  it('keeps classic themes fixed while dbx palettes follow their own mode', () => {
    expect(resolveThemeMode('aurora', 'light', false)).toBe('dark')
    expect(resolveThemeMode('obsidian', 'light', true)).toBe('dark')
    expect(resolveThemeMode('mist', 'dark', true)).toBe('light')

    expect(resolveThemeMode('dbx-pearl', 'system', false)).toBe('light')
    expect(resolveThemeMode('dbx-pearl', 'system', true)).toBe('dark')
    expect(resolveThemeMode('dbx-pearl', 'dark', false)).toBe('dark')
    expect(resolveThemeMode('dbx-pearl', 'light', true)).toBe('light')

    expect(resolveThemeSelection('system', 'dark', false)).toEqual({
      resolvedStyle: 'mist',
      resolvedTheme: 'light',
    })
    expect(resolveThemeSelection('dbx-sage', 'dark', false)).toEqual({
      resolvedStyle: 'dbx-sage',
      resolvedTheme: 'dark',
    })
  })

  it('cycles through every palette and wraps back to aurora', () => {
    const visited: ThemeStyle[] = [THEME_STYLES[0]]
    for (let index = 1; index < THEME_STYLES.length; index += 1) {
      visited.push(nextThemeStyle(visited[visited.length - 1]!))
    }
    expect(visited).toEqual([...THEME_STYLES])
    expect(nextThemeStyle(THEME_STYLES[THEME_STYLES.length - 1]!)).toBe('aurora')
  })

  it('uses the palette background and falls back to a supported mode', () => {
    expect(resolveThemeBackground('dbx-pearl', 'light')).toBe(
      themePreview('dbx-pearl', 'light').background,
    )
    expect(resolveThemeBackground('dbx-pearl', 'dark')).toBe(
      themePreview('dbx-pearl', 'dark').background,
    )
    expect(resolveThemeBackground('aurora', 'light')).toBe(
      themePreview('aurora', 'dark').background,
    )
    expect(resolveThemeBackground('mist', 'dark')).toBe(themePreview('mist', 'light').background)
  })
})
