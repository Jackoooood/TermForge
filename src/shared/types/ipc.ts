import type { ConnectionCatalog, ConnectionInput, ConnectionProfile } from './connection'
import type { HostKeyRecord } from './hostKey'
import type { LocalDirectoryListing, LocalRootsResult } from './localFs'
import type { LogExportAck, LogFolderAck, LogInfo } from './logging'
import type {
  ConnectionRemovalImpact,
  ConnectionRemovalOptions,
  PortForwardCreateInput,
  PortForwardItem,
  PortForwardRemoveAck,
  PortForwardSnapshot,
  PortForwardUpdateEvent,
  PortForwardUpdateInput,
  StartPortForwardInput,
} from './portForward'
import type { AppPreferences } from './preferences'
import type {
  CommandHistoryClearAck,
  CommandHistorySnapshot,
  QuickCommand,
  QuickCommandDraft,
  QuickCommandExecuteAck,
  QuickCommandExecuteInput,
  QuickCommandSnapshot,
} from './quickCommands'
import type { SecurityStatus } from './security'
import type {
  RemoteDirectoryListing,
  RemoteFileEntry,
  RemoteTextFile,
  SftpCloseAck,
  SftpMutationAck,
  SftpOpenResult,
  SftpTextWriteAck,
  SftpTextWriteInput,
} from './sftp'
import type {
  SshConnectCancelAck,
  SshConnectResult,
  SshCredentialAck,
  SshCredentialInput,
  SshHostKeyRequestEvent,
  SshHostKeyResponseAck,
  SshSessionSnapshot,
  SshStatusEvent,
} from './ssh'
import type {
  TerminalAck,
  TerminalExitEvent,
  TerminalOpenResult,
  TerminalOutputEvent,
  TerminalShellSnapshot,
  TerminalSize,
  TerminalStatusEvent,
} from './terminal'
import type {
  TransferClearAck,
  TransferConflictPolicy,
  TransferTask,
  TransferUpdateEvent,
  TransferUploadEnqueueAck,
} from './transfer'
import type { WallpaperBridge } from './wallpaper'

export type DesktopPlatform = 'win32' | 'darwin' | 'linux' | 'other'

export interface AppInfo {
  appName: string
  appVersion: string
  platform: DesktopPlatform
  electronVersion: string
  chromeVersion: string
  isPackaged: boolean
}

export type OperationErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'unavailable'
  | 'permission-denied'
  | 'not-a-directory'
  | 'not-a-file'
  | 'already-exists'
  | 'not-empty'
  | 'timeout'
  | 'outcome-unknown'
  | 'unsupported'
  | 'storage-unavailable'
  | 'storage-corrupt'
  | 'storage-read-failed'
  | 'storage-write-failed'
  | 'limit-exceeded'
  | 'internal'

export interface OperationError {
  code: OperationErrorCode
  message: string
}

export type OperationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: OperationError
    }

export interface ConnectionMutationAck {
  id: string
}

export interface SettingsSnapshot {
  preferences: AppPreferences
  /** Non-fatal recovery notices produced while loading a settings file. */
  warnings: string[]
}

export interface SettingsBridge {
  get(): Promise<OperationResult<SettingsSnapshot>>
  update(preferences: AppPreferences): Promise<OperationResult<SettingsSnapshot>>
}

export interface HostKeyRemovalAck {
  removed: boolean
}

export interface HostKeysBridge {
  list(): Promise<OperationResult<HostKeyRecord[]>>
  remove(host: string, port: number): Promise<OperationResult<HostKeyRemovalAck>>
}

export interface LogsBridge {
  getInfo(): Promise<OperationResult<LogInfo>>
  exportLogs(): Promise<OperationResult<LogExportAck>>
  openFolder(): Promise<OperationResult<LogFolderAck>>
}

export interface ConnectionBridge {
  list(): Promise<OperationResult<ConnectionCatalog>>
  create(input: ConnectionInput): Promise<OperationResult<ConnectionProfile>>
  update(id: string, input: ConnectionInput): Promise<OperationResult<ConnectionProfile>>
  remove(
    id: string,
    options?: ConnectionRemovalOptions,
  ): Promise<OperationResult<ConnectionMutationAck>>
  setFavorite(id: string, favorite: boolean): Promise<OperationResult<ConnectionProfile>>
}

/**
 * Forwarding is owned by the main process. The renderer only names a persisted
 * rule and an existing session; it never receives a socket, channel or secret.
 */
export interface PortForwardsBridge {
  list(): Promise<OperationResult<PortForwardSnapshot>>
  create(input: PortForwardCreateInput): Promise<OperationResult<PortForwardItem>>
  update(id: string, input: PortForwardUpdateInput): Promise<OperationResult<PortForwardItem>>
  remove(id: string): Promise<OperationResult<PortForwardRemoveAck>>
  start(input: StartPortForwardInput): Promise<OperationResult<PortForwardItem>>
  stop(id: string): Promise<OperationResult<PortForwardItem>>
  getConnectionRemovalImpact(
    connectionId: string,
  ): Promise<OperationResult<ConnectionRemovalImpact>>
  onSnapshot(listener: (event: PortForwardUpdateEvent) => void): () => void
}

export interface SshBridge {
  connect(connectionId: string, clientId: string): Promise<OperationResult<SshConnectResult>>
  /** Cancels the in-flight attempt for a renderer tab without closing the tab. */
  cancelConnect(clientId: string): Promise<OperationResult<SshConnectCancelAck>>
  disconnect(sessionId: string): Promise<OperationResult<SshSessionSnapshot>>
  getStatus(sessionId: string): Promise<OperationResult<SshSessionSnapshot>>
  respondToHostKey(
    requestId: string,
    accepted: boolean,
  ): Promise<OperationResult<SshHostKeyResponseAck>>
  saveCredential(input: SshCredentialInput): Promise<OperationResult<SshCredentialAck>>
  onSessionStatus(listener: (event: SshStatusEvent) => void): () => void
  onHostKeyRequest(listener: (event: SshHostKeyRequestEvent) => void): () => void
}

export interface TerminalBridge {
  open(sessionId: string, size: TerminalSize): Promise<OperationResult<TerminalOpenResult>>
  write(sessionId: string, data: string): Promise<OperationResult<TerminalAck>>
  resize(sessionId: string, size: TerminalSize): Promise<OperationResult<TerminalAck>>
  close(sessionId: string): Promise<OperationResult<TerminalAck>>
  getStatus(sessionId: string): Promise<OperationResult<TerminalShellSnapshot>>
  readClipboard(): Promise<OperationResult<string>>
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void
  onStatus(listener: (event: TerminalStatusEvent) => void): () => void
  onExit(listener: (event: TerminalExitEvent) => void): () => void
}

/**
 * SFTP is scoped to an existing main-process SSH session. Every call names the
 * session explicitly; the renderer never receives a channel or client object.
 */
export interface SftpBridge {
  open(sessionId: string): Promise<OperationResult<SftpOpenResult>>
  list(sessionId: string, path: string): Promise<OperationResult<RemoteDirectoryListing>>
  stat(sessionId: string, path: string): Promise<OperationResult<RemoteFileEntry>>
  mkdir(
    sessionId: string,
    parentPath: string,
    name: string,
  ): Promise<OperationResult<SftpMutationAck>>
  rename(
    sessionId: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<OperationResult<SftpMutationAck>>
  deleteFile(sessionId: string, path: string): Promise<OperationResult<SftpMutationAck>>
  removeDirectory(sessionId: string, path: string): Promise<OperationResult<SftpMutationAck>>
  readTextFile(sessionId: string, path: string): Promise<OperationResult<RemoteTextFile>>
  writeTextFile(input: SftpTextWriteInput): Promise<OperationResult<SftpTextWriteAck>>
  close(sessionId: string): Promise<OperationResult<SftpCloseAck>>
}

/**
 * Local filesystem browsing is metadata-only. The renderer never receives file
 * contents or a raw `fs` API; transfer sources are re-validated in the main
 * process before any file is read.
 */
export interface LocalFsBridge {
  roots(): Promise<OperationResult<LocalRootsResult>>
  list(path: string): Promise<OperationResult<LocalDirectoryListing>>
}

/**
 * Transfers are owned by the main process. Explicit local paths come from
 * drag & drop (via `getPathForFile`) or the local file panel, and are
 * re-validated in the main process (existence, type, no symlink following)
 * before any file is read; the renderer only receives task snapshots.
 */
export interface TransferBridge {
  enqueueUpload(
    sessionId: string,
    remoteDirectory: string,
  ): Promise<OperationResult<TransferTask[]>>
  enqueueUploadPaths(
    sessionId: string,
    remoteDirectory: string,
    localPaths: string[],
  ): Promise<OperationResult<TransferUploadEnqueueAck>>
  enqueueDownload(
    sessionId: string,
    remotePaths: string[],
  ): Promise<OperationResult<TransferTask[]>>
  enqueueDownloadPaths(
    sessionId: string,
    remotePaths: string[],
    localDirectory: string,
  ): Promise<OperationResult<TransferTask[]>>
  cancel(transferId: string): Promise<OperationResult<TransferTask>>
  retry(transferId: string): Promise<OperationResult<TransferTask>>
  resolveConflict(
    transferId: string,
    choice: TransferConflictPolicy,
    newName?: string,
  ): Promise<OperationResult<TransferTask>>
  list(): Promise<OperationResult<TransferTask[]>>
  clearHistory(): Promise<OperationResult<TransferClearAck>>
  onUpdate(listener: (event: TransferUpdateEvent) => void): () => void
}

/**
 * Quick commands are persisted snippets. Execution names an existing session
 * and is written through the same terminal channel as typed input; the
 * renderer never gets a separate exec path.
 */
export interface QuickCommandsBridge {
  list(): Promise<OperationResult<QuickCommandSnapshot>>
  create(input: QuickCommandDraft): Promise<OperationResult<QuickCommand>>
  update(id: string, input: QuickCommandDraft): Promise<OperationResult<QuickCommand>>
  remove(id: string): Promise<OperationResult<{ id: string }>>
  setFavorite(id: string, favorite: boolean): Promise<OperationResult<QuickCommand>>
  execute(input: QuickCommandExecuteInput): Promise<OperationResult<QuickCommandExecuteAck>>
}

/**
 * Command history is separate from application logs and stores only rendered
 * command text plus target metadata. It is disabled by default.
 */
export interface CommandHistoryBridge {
  list(): Promise<OperationResult<CommandHistorySnapshot>>
  remove(id: string): Promise<OperationResult<{ id: string }>>
  clear(): Promise<OperationResult<CommandHistoryClearAck>>
}

/**
 * The complete preload surface. The renderer gets only fixed domain methods;
 * there is no generic IPC dispatch and no raw Node.js capability.
 */
export interface TermForgeBridge {
  getAppInfo(): Promise<AppInfo>
  getSecurityStatus(): Promise<SecurityStatus>
  /**
   * Resolves the absolute path of a dropped OS file. Electron 32 removed
   * `File.path`; this is the supported replacement (`webUtils`), and it
   * returns '' for files that have no path on disk.
   */
  getPathForFile(file: File): string
  connections: ConnectionBridge
  portForwards: PortForwardsBridge
  ssh: SshBridge
  terminal: TerminalBridge
  sftp: SftpBridge
  localFs: LocalFsBridge
  transfer: TransferBridge
  settings: SettingsBridge
  hostKeys: HostKeysBridge
  logs: LogsBridge
  wallpaper: WallpaperBridge
  quickCommands: QuickCommandsBridge
  commandHistory: CommandHistoryBridge
}
