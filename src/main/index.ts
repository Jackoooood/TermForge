import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { Client } from 'ssh2'
import { join } from 'node:path'
import { APP_NAME } from '../shared/constants/app'
import { IPC_EVENT_CHANNELS } from '../shared/constants/ipc'
import { isDbxTheme, type DbxThemeMode } from '../shared/theme/catalog'
import type { AppPreferences, ThemePreference } from '../shared/types/preferences'
import { registerIpcHandlers } from './ipc'
import { installApplicationMenu } from './menu'
import { Logger } from './logging/logger'
import { LogService } from './logging/logService'
import { runBoundedCleanup } from './lifecycle/shutdown'
import { ElectronCredentialEncryption } from './security/electronCredentialEncryption'
import { EncryptedCredentialStore } from './security/credentialStore'
import { VaultCredentialResolver } from './services/ssh/credentialResolver'
import { SshService, type SshClientLike } from './services/ssh/SshService'
import { SftpService } from './services/sftp/SftpService'
import { LocalFsService } from './services/localFs/LocalFsService'
import { PortForwardService } from './services/portForward/PortForwardService'
import { TransferService } from './services/transfers/TransferService'
import { WallpaperService } from './services/wallpaper/WallpaperService'
import { QuickCommandService } from './services/quickCommands/QuickCommandService'
import { CommandHistoryRepository } from './storage/commandHistoryRepository'
import { ConnectionRepository } from './storage/connectionRepository'
import { FileHostKeyStore } from './storage/hostKeyRepository'
import { PortForwardRepository } from './storage/portForwardRepository'
import { QuickCommandRepository } from './storage/quickCommandRepository'
import { SettingsRepository } from './storage/settingsRepository'
import { applyTitleBarTheme, createMainWindow } from './windows/mainWindow'

app.setName(APP_NAME)

let mainWindow: BrowserWindow | null = null
let logger: Logger | null = null
let sshService: SshService | null = null
let sftpService: SftpService | null = null
let transferService: TransferService | null = null
let portForwardService: PortForwardService | null = null
let currentTheme: ThemePreference = 'aurora'
let currentDbxThemeMode: DbxThemeMode = 'system'
let shutdownStarted = false
let quitAllowed = false

function sendToMainWindow(channel: string, payload: unknown): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  const webContents = window.webContents
  if (webContents.isDestroyed()) return
  webContents.send(channel, payload)
}

function openMainWindow(): void {
  const window = createMainWindow(currentTheme, currentDbxThemeMode)
  mainWindow = window
  window.on('closed', () => {
    transferService?.cancelAll()
    sshService?.cancelAll()
    mainWindow = null
  })
}

async function pickUploadFiles(): Promise<string[]> {
  const window = mainWindow
  if (!window || window.isDestroyed()) return []
  const result = await dialog.showOpenDialog(window, {
    title: '选择要上传的文件',
    buttonLabel: '上传',
    properties: ['openFile', 'multiSelections'],
  })
  return result.canceled ? [] : result.filePaths
}

async function pickDownloadDirectory(): Promise<string | null> {
  const window = mainWindow
  if (!window || window.isDestroyed()) return null
  const result = await dialog.showOpenDialog(window, {
    title: '选择下载保存目录',
    buttonLabel: '下载到此目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

async function pickLogExportPath(): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const options = {
    title: '导出脱敏诊断日志',
    buttonLabel: '导出',
    defaultPath: join(app.getPath('downloads'), `termforge-diagnostics-${stamp}.log`),
    filters: [{ name: '日志文件', extensions: ['log'] }],
  }
  const window = mainWindow
  const result =
    window && !window.isDestroyed()
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

async function pickWallpaperFile(): Promise<string | null> {
  const window = mainWindow
  if (!window || window.isDestroyed()) return null
  const result = await dialog.showOpenDialog(window, {
    title: '选择壁纸图片',
    buttonLabel: '设为壁纸',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

function applyRuntimePreferences(preferences: AppPreferences): void {
  logger?.setLevel(preferences.logLevel)
  transferService?.setConcurrencyLimits({
    maxConcurrent: preferences.transferMaxConcurrent,
    maxPerSession: preferences.transferMaxPerSession,
  })
  currentTheme = preferences.theme
  currentDbxThemeMode = preferences.dbxThemeMode
  if (mainWindow) applyTitleBarTheme(mainWindow, currentTheme, currentDbxThemeMode)
}

function followsSystemAppearance(): boolean {
  if (currentTheme === 'system') return true
  return isDbxTheme(currentTheme) && currentDbxThemeMode === 'system'
}

async function shutdownServices(): Promise<void> {
  logger?.info('app', 'shutdown-start')
  await runBoundedCleanup(
    [
      { name: 'transfers', run: () => transferService?.dispose() },
      { name: 'port-forwards', run: () => portForwardService?.shutdown() },
      { name: 'sftp', run: () => sftpService?.dispose() },
      { name: 'ssh', run: () => sshService?.dispose() },
      { name: 'logger', run: () => logger?.flush() },
    ],
    {
      timeoutMs: 4_000,
      onError: (step, error, timedOut) => {
        logger?.error('app', 'shutdown-step-failed', { step, timedOut, error })
      },
    },
  )
  logger?.info('app', 'shutdown-complete')
  await logger?.flush().catch(() => undefined)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app
    .whenReady()
    .then(async () => {
      const userDataPath = app.getPath('userData')
      logger = new Logger({ directory: join(userDataPath, 'logs') })
      await logger.initialize()

      const settings = new SettingsRepository(join(userDataPath, 'settings.json'))
      const initialSettings = await settings.get()
      logger.setLevel(initialSettings.preferences.logLevel)
      currentTheme = initialSettings.preferences.theme
      currentDbxThemeMode = initialSettings.preferences.dbxThemeMode

      nativeTheme.on('updated', () => {
        if (followsSystemAppearance() && mainWindow) {
          applyTitleBarTheme(mainWindow, currentTheme, currentDbxThemeMode)
        }
      })

      const connections = new ConnectionRepository(join(userDataPath, 'connections.json'))
      const credentials = new EncryptedCredentialStore(
        new ElectronCredentialEncryption(),
        join(userDataPath, 'credentials.enc.json'),
      )
      const hostKeys = new FileHostKeyStore(join(userDataPath, 'known-hosts.json'))

      sshService = new SshService({
        connections,
        hostKeys,
        credentialResolver: new VaultCredentialResolver({ credentials }),
        createClient: () => new Client() as unknown as SshClientLike,
        emitStatus: (event) => sendToMainWindow(IPC_EVENT_CHANNELS.sshSessionStatus, event),
        emitHostKeyRequest: (event) =>
          sendToMainWindow(IPC_EVENT_CHANNELS.sshHostKeyRequest, event),
        emitTerminalOutput: (event) => sendToMainWindow(IPC_EVENT_CHANNELS.terminalOutput, event),
        emitTerminalStatus: (event) => sendToMainWindow(IPC_EVENT_CHANNELS.terminalStatus, event),
        emitTerminalExit: (event) => sendToMainWindow(IPC_EVENT_CHANNELS.terminalExit, event),
        onSessionTerminated: (sessionId) => {
          transferService?.handleSessionTerminated(sessionId)
          sftpService?.disposeSession(sessionId)
        },
      })

      const ssh = sshService

      portForwardService = new PortForwardService({
        store: new PortForwardRepository(join(userDataPath, 'port-forwards.json')),
        connections,
        ssh,
        emitUpdate: (event) => sendToMainWindow(IPC_EVENT_CHANNELS.portForwardSnapshot, event),
      })

      sftpService = new SftpService({
        acquireClient: (sessionId) => ssh.getSftpClient(sessionId),
      })
      const sftp = sftpService

      const localFs = new LocalFsService({
        // `app.getPath` is Electron-only, so the service takes it as a
        // dependency and tests can run without the Electron runtime.
        getHomeDirectory: () => app.getPath('home'),
      })

      transferService = new TransferService({
        sftp,
        emitUpdate: (event) => sendToMainWindow(IPC_EVENT_CHANNELS.transferUpdate, event),
        pickUploadFiles,
        pickDownloadDirectory,
        journalPath: join(userDataPath, 'transfer-journal.json'),
        maxConcurrent: initialSettings.preferences.transferMaxConcurrent,
        maxPerSession: initialSettings.preferences.transferMaxPerSession,
        onNotice: (event, details) => logger?.info('transfer', event, details),
      })
      await transferService.initialize()

      const logService = new LogService({
        logger,
        pickExportPath: pickLogExportPath,
        openDirectory: async (directory) => (await shell.openPath(directory)) === '',
      })

      const wallpaper = new WallpaperService(join(userDataPath, 'wallpapers'), pickWallpaperFile)

      const quickCommands = new QuickCommandService({
        commands: new QuickCommandRepository(join(userDataPath, 'quick-commands.json')),
        history: new CommandHistoryRepository(join(userDataPath, 'command-history.json')),
        ssh,
        isCommandHistoryEnabled: async () =>
          (await settings.get()).preferences.commandHistoryEnabled,
      })

      registerIpcHandlers(() => mainWindow, {
        connections,
        credentials,
        portForwards: portForwardService,
        ssh,
        sftp,
        transfer: transferService,
        localFs,
        settings,
        hostKeys,
        logs: logService,
        wallpaper,
        quickCommands,
        applyRuntimePreferences,
      })
      installApplicationMenu(!app.isPackaged)
      openMainWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
      })
      logger.info('app', 'ready', {
        packaged: app.isPackaged,
        settingsRecovered: initialSettings.warnings.length > 0,
      })
    })
    .catch((error: unknown) => {
      logger?.error('app', 'startup-failed', { error })
      if (!logger) console.error('[TermForge] Failed to start the main process', error)
      app.quit()
    })

  app.on('before-quit', (event) => {
    if (quitAllowed) return
    event.preventDefault()
    if (shutdownStarted) return
    shutdownStarted = true
    void shutdownServices().finally(() => {
      quitAllowed = true
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
