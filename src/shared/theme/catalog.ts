export const CLASSIC_THEME_STYLES = ['aurora', 'obsidian', 'mist'] as const

export const DBX_THEME_STYLES = [
  'dbx-pearl',
  'dbx-mist',
  'dbx-graphite',
  'dbx-cobalt',
  'dbx-sage',
  'dbx-amber',
  'dbx-blush',
  'dbx-vscode',
  'dbx-idea',
  'dbx-xcode',
  'dbx-jetbrains',
  'dbx-cursor',
  'dbx-claude',
] as const

export const THEME_STYLES = [...CLASSIC_THEME_STYLES, ...DBX_THEME_STYLES] as const

export const THEME_PREFERENCES = [...THEME_STYLES, 'system'] as const

export type ClassicThemeStyle = (typeof CLASSIC_THEME_STYLES)[number]
export type DbxThemeStyle = (typeof DBX_THEME_STYLES)[number]
export type ThemeStyle = (typeof THEME_STYLES)[number]
export type ThemePreference = (typeof THEME_PREFERENCES)[number]

export type ResolvedTheme = 'light' | 'dark'

export const DBX_THEME_MODES = ['system', 'light', 'dark'] as const

export type DbxThemeMode = (typeof DBX_THEME_MODES)[number]

export interface ThemePreview {
  background: string
  panel: string
  primary: string
}

export interface ThemeCatalogEntry {
  id: ThemeStyle
  label: string
  hint: string
  kind: 'classic' | 'dbx'
  /** Modes this palette ships with; classic styles are fixed. */
  modes: readonly ResolvedTheme[]
  preview: Record<ResolvedTheme, ThemePreview>
}

const PEARL_LIGHT: ThemePreview = {
  background: 'rgb(255 255 255)',
  panel: 'rgb(250 250 250)',
  primary: 'rgb(23 23 23)',
}
const PEARL_DARK: ThemePreview = {
  background: 'rgb(19 20 22)',
  panel: 'rgb(25 25 28)',
  primary: 'rgb(208 208 214)',
}
const MIST_LIGHT: ThemePreview = {
  background: 'rgb(250 251 253)',
  panel: 'rgb(239 242 246)',
  primary: 'rgb(46 95 166)',
}
const MIST_DARK: ThemePreview = {
  background: 'rgb(31 33 37)',
  panel: 'rgb(34 37 42)',
  primary: 'rgb(157 177 205)',
}
const GRAPHITE_LIGHT: ThemePreview = {
  background: 'rgb(249 250 252)',
  panel: 'rgb(235 238 243)',
  primary: 'rgb(72 80 93)',
}
const GRAPHITE_DARK: ThemePreview = {
  background: 'rgb(30 32 36)',
  panel: 'rgb(33 35 40)',
  primary: 'rgb(174 181 192)',
}
const COBALT_LIGHT: ThemePreview = {
  background: 'rgb(247 250 253)',
  panel: 'rgb(232 239 248)',
  primary: 'rgb(43 99 183)',
}
const COBALT_DARK: ThemePreview = {
  background: 'rgb(25 31 42)',
  panel: 'rgb(28 35 48)',
  primary: 'rgb(137 173 223)',
}
const SAGE_LIGHT: ThemePreview = {
  background: 'rgb(248 250 248)',
  panel: 'rgb(235 242 238)',
  primary: 'rgb(58 123 106)',
}
const SAGE_DARK: ThemePreview = {
  background: 'rgb(27 35 33)',
  panel: 'rgb(30 39 36)',
  primary: 'rgb(138 184 169)',
}
const AMBER_LIGHT: ThemePreview = {
  background: 'rgb(255 252 242)',
  panel: 'rgb(247 238 213)',
  primary: 'rgb(149 95 28)',
}
const AMBER_DARK: ThemePreview = {
  background: 'rgb(37 34 27)',
  panel: 'rgb(41 37 29)',
  primary: 'rgb(213 169 75)',
}
const BLUSH_LIGHT: ThemePreview = {
  background: 'rgb(255 248 251)',
  panel: 'rgb(248 234 241)',
  primary: 'rgb(184 86 123)',
}
const BLUSH_DARK: ThemePreview = {
  background: 'rgb(42 35 40)',
  panel: 'rgb(47 38 45)',
  primary: 'rgb(226 160 184)',
}
const VSCODE_LIGHT: ThemePreview = {
  background: 'rgb(255 255 255)',
  panel: 'rgb(243 243 243)',
  primary: 'rgb(0 122 204)',
}
const VSCODE_DARK: ThemePreview = {
  background: 'rgb(30 30 30)',
  panel: 'rgb(37 37 38)',
  primary: 'rgb(0 122 204)',
}
const IDEA_LIGHT: ThemePreview = {
  background: 'rgb(250 250 250)',
  panel: 'rgb(235 236 240)',
  primary: 'rgb(75 110 175)',
}
const IDEA_DARK: ThemePreview = {
  background: 'rgb(43 43 43)',
  panel: 'rgb(49 51 53)',
  primary: 'rgb(106 135 197)',
}
const XCODE_LIGHT: ThemePreview = {
  background: 'rgb(250 252 255)',
  panel: 'rgb(242 245 250)',
  primary: 'rgb(10 132 255)',
}
const XCODE_DARK: ThemePreview = {
  background: 'rgb(31 35 41)',
  panel: 'rgb(37 41 50)',
  primary: 'rgb(10 132 255)',
}
const JETBRAINS_LIGHT: ThemePreview = {
  background: 'rgb(248 249 251)',
  panel: 'rgb(242 243 245)',
  primary: 'rgb(108 93 211)',
}
const JETBRAINS_DARK: ThemePreview = {
  background: 'rgb(30 31 34)',
  panel: 'rgb(43 45 48)',
  primary: 'rgb(123 97 255)',
}
const CURSOR_LIGHT: ThemePreview = {
  background: 'rgb(251 252 254)',
  panel: 'rgb(244 245 247)',
  primary: 'rgb(59 130 246)',
}
const CURSOR_DARK: ThemePreview = {
  background: 'rgb(15 17 26)',
  panel: 'rgb(21 24 33)',
  primary: 'rgb(107 164 255)',
}
const CLAUDE_LIGHT: ThemePreview = {
  background: 'rgb(251 247 239)',
  panel: 'rgb(239 231 220)',
  primary: 'rgb(184 107 60)',
}
const CLAUDE_DARK: ThemePreview = {
  background: 'rgb(33 31 28)',
  panel: 'rgb(42 39 35)',
  primary: 'rgb(210 138 95)',
}

export const THEME_CATALOG: readonly ThemeCatalogEntry[] = [
  {
    id: 'aurora',
    label: 'Aurora 极光',
    hint: '蓝紫青弥散渐变 · 推荐',
    kind: 'classic',
    modes: ['dark'],
    preview: {
      dark: { background: '#10141f', panel: '#1a2130', primary: '#6d7cff' },
      light: { background: '#10141f', panel: '#1a2130', primary: '#6d7cff' },
    },
  },
  {
    id: 'obsidian',
    label: 'Obsidian 曜石',
    hint: '纯色深色 · 低干扰',
    kind: 'classic',
    modes: ['dark'],
    preview: {
      dark: { background: '#0d1017', panel: '#151a24', primary: '#7e8fe8' },
      light: { background: '#0d1017', panel: '#151a24', primary: '#7e8fe8' },
    },
  },
  {
    id: 'mist',
    label: 'Mist 柔光',
    hint: '浅色低饱和渐变',
    kind: 'classic',
    modes: ['light'],
    preview: {
      dark: { background: '#edeff6', panel: '#f7f8fc', primary: '#5a6ce0' },
      light: { background: '#edeff6', panel: '#f7f8fc', primary: '#5a6ce0' },
    },
  },
  {
    id: 'dbx-pearl',
    label: 'Pearl 珍珠',
    hint: '中性黑白 · 高对比',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: PEARL_LIGHT, dark: PEARL_DARK },
  },
  {
    id: 'dbx-mist',
    label: 'Mist 晨雾',
    hint: '冷静灰蓝 · 沉稳',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: MIST_LIGHT, dark: MIST_DARK },
  },
  {
    id: 'dbx-graphite',
    label: 'Graphite 石墨',
    hint: '石墨灰 · 专注',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: GRAPHITE_LIGHT, dark: GRAPHITE_DARK },
  },
  {
    id: 'dbx-cobalt',
    label: 'Cobalt 钴蓝',
    hint: '深邃钴蓝 · 工程师',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: COBALT_LIGHT, dark: COBALT_DARK },
  },
  {
    id: 'dbx-sage',
    label: 'Sage 鼠尾草',
    hint: '低饱和绿 · 柔和',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: SAGE_LIGHT, dark: SAGE_DARK },
  },
  {
    id: 'dbx-amber',
    label: 'Amber 琥珀',
    hint: '暖琥珀 · 舒适',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: AMBER_LIGHT, dark: AMBER_DARK },
  },
  {
    id: 'dbx-blush',
    label: 'Blush 胭脂',
    hint: '柔和胭脂粉',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: BLUSH_LIGHT, dark: BLUSH_DARK },
  },
  {
    id: 'dbx-vscode',
    label: 'VS Code',
    hint: '经典编辑器配色',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: VSCODE_LIGHT, dark: VSCODE_DARK },
  },
  {
    id: 'dbx-idea',
    label: 'IDEA',
    hint: 'JetBrains 经典浅色',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: IDEA_LIGHT, dark: IDEA_DARK },
  },
  {
    id: 'dbx-xcode',
    label: 'Xcode',
    hint: 'Apple 工具链配色',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: XCODE_LIGHT, dark: XCODE_DARK },
  },
  {
    id: 'dbx-jetbrains',
    label: 'JetBrains',
    hint: '新 UI 紫调',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: JETBRAINS_LIGHT, dark: JETBRAINS_DARK },
  },
  {
    id: 'dbx-cursor',
    label: 'Cursor',
    hint: '编辑器深空蓝',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: CURSOR_LIGHT, dark: CURSOR_DARK },
  },
  {
    id: 'dbx-claude',
    label: 'Claude',
    hint: '暖陶土 · 纸感',
    kind: 'dbx',
    modes: ['light', 'dark'],
    preview: { light: CLAUDE_LIGHT, dark: CLAUDE_DARK },
  },
]

const THEME_BY_ID = new Map<ThemeStyle, ThemeCatalogEntry>(
  THEME_CATALOG.map((entry) => [entry.id, entry]),
)

export function isDbxTheme(style: ThemeStyle): style is DbxThemeStyle {
  return (DBX_THEME_STYLES as readonly string[]).includes(style)
}

export function isClassicTheme(style: ThemeStyle): style is ClassicThemeStyle {
  return (CLASSIC_THEME_STYLES as readonly string[]).includes(style)
}

export function themeCatalogEntry(style: ThemeStyle): ThemeCatalogEntry {
  const entry = THEME_BY_ID.get(style)
  if (!entry) throw new Error(`Unknown theme style: ${style}`)
  return entry
}

export function themeLabel(theme: ThemePreference): string {
  if (theme === 'system') return '跟随系统'
  return themeCatalogEntry(theme).label
}

/** Classic styles are fixed: Mist is light, Aurora and Obsidian are dark. */
export function classicThemeMode(style: ClassicThemeStyle): ResolvedTheme {
  return style === 'mist' ? 'light' : 'dark'
}

export function resolveThemeStyle(theme: ThemePreference, prefersDark: boolean): ThemeStyle {
  if (theme === 'system') return prefersDark ? 'aurora' : 'mist'
  return theme
}

export function resolveThemeMode(
  theme: ThemePreference,
  dbxThemeMode: DbxThemeMode,
  prefersDark: boolean,
): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  if (!isDbxTheme(theme)) return classicThemeMode(theme)
  if (dbxThemeMode === 'system') return prefersDark ? 'dark' : 'light'
  return dbxThemeMode
}

export interface ResolvedThemeSelection {
  resolvedTheme: ResolvedTheme
  resolvedStyle: ThemeStyle
}

export function resolveThemeSelection(
  theme: ThemePreference,
  dbxThemeMode: DbxThemeMode,
  prefersDark: boolean,
): ResolvedThemeSelection {
  return {
    resolvedTheme: resolveThemeMode(theme, dbxThemeMode, prefersDark),
    resolvedStyle: resolveThemeStyle(theme, prefersDark),
  }
}

export function nextThemeStyle(style: ThemeStyle): ThemeStyle {
  const index = THEME_STYLES.indexOf(style)
  return THEME_STYLES[(index + 1) % THEME_STYLES.length] ?? 'aurora'
}

export function themePreview(style: ThemeStyle, mode: ResolvedTheme): ThemePreview {
  return themeCatalogEntry(style).preview[mode]
}

/** Native window/background colors; mirrors the palette's app background. */
export function resolveThemeBackground(style: ThemeStyle, mode: ResolvedTheme): string {
  const entry = themeCatalogEntry(style)
  const effectiveMode = entry.modes.includes(mode) ? mode : (entry.modes[0] ?? mode)
  return entry.preview[effectiveMode].background
}
