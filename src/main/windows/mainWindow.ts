import { app, BrowserWindow, nativeTheme, screen } from 'electron'
import type { TitleBarOverlayOptions } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '../../shared/constants/app'
import {
  resolveThemeBackground,
  resolveThemeSelection,
  type DbxThemeMode,
  type ResolvedTheme,
  type ThemePreference,
} from '../../shared/theme/catalog'

const TITLE_BAR_HEIGHT = 48

const TITLE_BAR_SYMBOL_COLORS: Record<ResolvedTheme, string> = {
  dark: '#e8edf5',
  light: '#1b2330',
}

function resolveAppearance(
  theme: ThemePreference,
  dbxThemeMode: DbxThemeMode,
): { mode: ResolvedTheme; background: string } {
  const selection = resolveThemeSelection(theme, dbxThemeMode, nativeTheme.shouldUseDarkColors)
  return {
    mode: selection.resolvedTheme,
    background: resolveThemeBackground(selection.resolvedStyle, selection.resolvedTheme),
  }
}

function titleBarOverlay(theme: ThemePreference, dbxThemeMode: DbxThemeMode): TitleBarOverlayOptions {
  const { mode } = resolveAppearance(theme, dbxThemeMode)
  return {
    // The web app bar draws its own background and bottom divider beneath this area.
    color: 'rgba(0,0,0,0)',
    symbolColor: TITLE_BAR_SYMBOL_COLORS[mode],
    height: TITLE_BAR_HEIGHT,
  }
}

export function applyTitleBarTheme(
  window: BrowserWindow,
  theme: ThemePreference,
  dbxThemeMode: DbxThemeMode,
): void {
  if (window.isDestroyed()) return
  const { background } = resolveAppearance(theme, dbxThemeMode)
  window.setBackgroundColor(background)
  if (process.platform === 'darwin') return
  window.setTitleBarOverlay(titleBarOverlay(theme, dbxThemeMode))
}

export function createMainWindow(
  theme: ThemePreference,
  dbxThemeMode: DbxThemeMode,
): BrowserWindow {
  const { background } = resolveAppearance(theme, dbxThemeMode)
  const isDev = !app.isPackaged
  const devServerUrl = isDev ? process.env.ELECTRON_RENDERER_URL : undefined
  const workArea = screen.getPrimaryDisplay().workAreaSize

  const mainWindow = new BrowserWindow({
    width: Math.min(1440, workArea.width),
    height: Math.min(900, workArea.height),
    minWidth: 1024,
    minHeight: 660,
    show: false,
    title: APP_NAME,
    backgroundColor: background,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? {}
      : { titleBarOverlay: titleBarOverlay(theme, dbxThemeMode) }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: isDev,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isDev || !devServerUrl) {
      event.preventDefault()
      return
    }

    try {
      if (new URL(targetUrl).origin !== new URL(devServerUrl).origin) {
        event.preventDefault()
      }
    } catch {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('will-redirect', (event) => {
    event.preventDefault()
  })

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  const session = mainWindow.webContents.session
  // SFTP path copy uses the sanitized web clipboard write; terminal paste reads
  // the clipboard in the main process through a dedicated IPC channel. Every
  // other web permission stays denied.
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
  session.setPermissionCheckHandler(
    (_webContents, permission) => permission === 'clipboard-sanitized-write',
  )

  const loadRenderer = devServerUrl
    ? mainWindow.loadURL(devServerUrl)
    : mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  void loadRenderer.catch((error: unknown) => {
    console.error('[TermForge] Failed to load the renderer', error)
  })

  return mainWindow
}
