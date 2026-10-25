import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '../shared/constants/ipc'
import type {
  AppInfo,
  CommandHistoryClearAck,
  CommandHistorySnapshot,
  ConnectionCatalog,
  ConnectionInput,
  ConnectionMutationAck,
  ConnectionProfile,
  ConnectionRemovalImpact,
  ConnectionRemovalOptions,
  LocalDirectoryListing,
  LocalRootsResult,
  OperationResult,
  PortForwardCreateInput,
  PortForwardItem,
  PortForwardRemoveAck,
  PortForwardSnapshot,
  PortForwardUpdateEvent,
  PortForwardUpdateInput,
  QuickCommand,
  QuickCommandDraft,
  QuickCommandExecuteAck,
  QuickCommandExecuteInput,
  QuickCommandSnapshot,
  RemoteDirectoryListing,
  RemoteFileEntry,
  RemoteTextFile,
  SecurityStatus,
  SftpCloseAck,
  SftpMutationAck,
  SftpOpenResult,
  SftpTextWriteAck,
  SftpTextWriteInput,
  SshConnectCancelAck,
  SshConnectResult,
  SshCredentialAck,
  SshCredentialInput,
  SshHostKeyRequestEvent,
  SshHostKeyResponseAck,
  SshSessionSnapshot,
  SshStatusEvent,
  StartPortForwardInput,
  TerminalAck,
  TerminalExitEvent,
  TerminalOpenResult,
  TerminalOutputEvent,
  TerminalShellSnapshot,
  TerminalSize,
  TerminalStatusEvent,
  TermForgeBridge,
  TransferClearAck,
  TransferConflictPolicy,
  TransferTask,
  TransferUpdateEvent,
  TransferUploadEnqueueAck,
  AppPreferences,
  HostKeyRecord,
  HostKeyRemovalAck,
  LogExportAck,
  LogFolderAck,
  LogInfo,
  SettingsSnapshot,
  WallpaperChooseResult,
  WallpaperState,
} from '../shared/types'

const connections = Object.freeze({
  list: async (): Promise<OperationResult<ConnectionCatalog>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.connectionsList)) as OperationResult<ConnectionCatalog>,

  create: async (input: ConnectionInput): Promise<OperationResult<ConnectionProfile>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.connectionsCreate,
      input,
    )) as OperationResult<ConnectionProfile>,

  update: async (id: string, input: ConnectionInput): Promise<OperationResult<ConnectionProfile>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.connectionsUpdate,
      id,
      input,
    )) as OperationResult<ConnectionProfile>,

  remove: async (
    id: string,
    options?: ConnectionRemovalOptions,
  ): Promise<OperationResult<ConnectionMutationAck>> =>
    (await (options === undefined
      ? ipcRenderer.invoke(IPC_CHANNELS.connectionsRemove, id)
      : ipcRenderer.invoke(
          IPC_CHANNELS.connectionsRemove,
          id,
          options,
        ))) as OperationResult<ConnectionMutationAck>,

  setFavorite: async (id: string, favorite: boolean): Promise<OperationResult<ConnectionProfile>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.connectionsSetFavorite,
      id,
      favorite,
    )) as OperationResult<ConnectionProfile>,
})

const portForwards = Object.freeze({
  list: async (): Promise<OperationResult<PortForwardSnapshot>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.portForwardsList,
    )) as OperationResult<PortForwardSnapshot>,

  create: async (input: PortForwardCreateInput): Promise<OperationResult<PortForwardItem>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.portForwardsCreate,
      input,
    )) as OperationResult<PortForwardItem>,

  update: async (
    id: string,
    input: PortForwardUpdateInput,
  ): Promise<OperationResult<PortForwardItem>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.portForwardsUpdate,
      id,
      input,
    )) as OperationResult<PortForwardItem>,

  remove: async (id: string): Promise<OperationResult<PortForwardRemoveAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.portForwardsRemove,
      id,
    )) as OperationResult<PortForwardRemoveAck>,

  start: async (input: StartPortForwardInput): Promise<OperationResult<PortForwardItem>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.portForwardsStart,
      input,
    )) as OperationResult<PortForwardItem>,

  stop: async (id: string): Promise<OperationResult<PortForwardItem>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.portForwardsStop,
      id,
    )) as OperationResult<PortForwardItem>,

  getConnectionRemovalImpact: async (
    connectionId: string,
  ): Promise<OperationResult<ConnectionRemovalImpact>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.portForwardsConnectionImpact,
      connectionId,
    )) as OperationResult<ConnectionRemovalImpact>,

  onSnapshot: (listener: (event: PortForwardUpdateEvent) => void): (() => void) =>
    subscribe(IPC_EVENT_CHANNELS.portForwardSnapshot, listener),
})

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  if (typeof listener !== 'function') {
    throw new TypeError('Event listener must be a function')
  }
  const wrapped = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  let active = true
  return () => {
    if (!active) return
    active = false
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const ssh = Object.freeze({
  connect: async (
    connectionId: string,
    clientId: string,
  ): Promise<OperationResult<SshConnectResult>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sshConnect,
      connectionId,
      clientId,
    )) as OperationResult<SshConnectResult>,

  cancelConnect: async (clientId: string): Promise<OperationResult<SshConnectCancelAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sshCancelConnect,
      clientId,
    )) as OperationResult<SshConnectCancelAck>,

  disconnect: async (sessionId: string): Promise<OperationResult<SshSessionSnapshot>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sshDisconnect,
      sessionId,
    )) as OperationResult<SshSessionSnapshot>,

  getStatus: async (sessionId: string): Promise<OperationResult<SshSessionSnapshot>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sshGetStatus,
      sessionId,
    )) as OperationResult<SshSessionSnapshot>,

  respondToHostKey: async (
    requestId: string,
    accepted: boolean,
  ): Promise<OperationResult<SshHostKeyResponseAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sshRespondHostKey,
      requestId,
      accepted,
    )) as OperationResult<SshHostKeyResponseAck>,

  saveCredential: async (input: SshCredentialInput): Promise<OperationResult<SshCredentialAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sshSetCredential,
      input,
    )) as OperationResult<SshCredentialAck>,

  onSessionStatus: (listener: (event: SshStatusEvent) => void): (() => void) =>
    subscribe(IPC_EVENT_CHANNELS.sshSessionStatus, listener),

  onHostKeyRequest: (listener: (event: SshHostKeyRequestEvent) => void): (() => void) =>
    subscribe(IPC_EVENT_CHANNELS.sshHostKeyRequest, listener),
})

const terminal = Object.freeze({
  open: async (
    sessionId: string,
    size: TerminalSize,
  ): Promise<OperationResult<TerminalOpenResult>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.terminalOpen,
      sessionId,
      size,
    )) as OperationResult<TerminalOpenResult>,

  write: async (sessionId: string, data: string): Promise<OperationResult<TerminalAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.terminalWrite,
      sessionId,
      data,
    )) as OperationResult<TerminalAck>,

  resize: async (sessionId: string, size: TerminalSize): Promise<OperationResult<TerminalAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.terminalResize,
      sessionId,
      size,
    )) as OperationResult<TerminalAck>,

  close: async (sessionId: string): Promise<OperationResult<TerminalAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.terminalClose,
      sessionId,
    )) as OperationResult<TerminalAck>,

  getStatus: async (sessionId: string): Promise<OperationResult<TerminalShellSnapshot>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.terminalGetStatus,
      sessionId,
    )) as OperationResult<TerminalShellSnapshot>,

  readClipboard: async (): Promise<OperationResult<string>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.terminalReadClipboard)) as OperationResult<string>,

  onOutput: (listener: (event: TerminalOutputEvent) => void): (() => void) =>
    subscribe(IPC_EVENT_CHANNELS.terminalOutput, listener),

  onStatus: (listener: (event: TerminalStatusEvent) => void): (() => void) =>
    subscribe(IPC_EVENT_CHANNELS.terminalStatus, listener),

  onExit: (listener: (event: TerminalExitEvent) => void): (() => void) =>
    subscribe(IPC_EVENT_CHANNELS.terminalExit, listener),
})

const sftp = Object.freeze({
  open: async (sessionId: string): Promise<OperationResult<SftpOpenResult>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.sftpOpen, sessionId)) as OperationResult<SftpOpenResult>,

  list: async (sessionId: string, path: string): Promise<OperationResult<RemoteDirectoryListing>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sftpList,
      sessionId,
      path,
    )) as OperationResult<RemoteDirectoryListing>,

  stat: async (sessionId: string, path: string): Promise<OperationResult<RemoteFileEntry>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sftpStat,
      sessionId,
      path,
    )) as OperationResult<RemoteFileEntry>,

  mkdir: async (
    sessionId: string,
    parentPath: string,
    name: string,
  ): Promise<OperationResult<SftpMutationAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sftpMkdir,
      sessionId,
      parentPath,
      name,
    )) as OperationResult<SftpMutationAck>,

  rename: async (
    sessionId: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<OperationResult<SftpMutationAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sftpRename,
      sessionId,
      sourcePath,
      targetPath,
    )) as OperationResult<SftpMutationAck>,

  deleteFile: async (sessionId: string, path: string): Promise<OperationResult<SftpMutationAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sftpDeleteFile,
      sessionId,
      path,
    )) as OperationResult<SftpMutationAck>,

  removeDirectory: async (
    sessionId: string,
    path: string,
  ): Promise<OperationResult<SftpMutationAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sftpRemoveDirectory,
      sessionId,
      path,
    )) as OperationResult<SftpMutationAck>,

  readTextFile: async (sessionId: string, path: string): Promise<OperationResult<RemoteTextFile>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sftpReadTextFile,
      sessionId,
      path,
    )) as OperationResult<RemoteTextFile>,

  writeTextFile: async (input: SftpTextWriteInput): Promise<OperationResult<SftpTextWriteAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.sftpWriteTextFile,
      input,
    )) as OperationResult<SftpTextWriteAck>,

  close: async (sessionId: string): Promise<OperationResult<SftpCloseAck>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.sftpClose, sessionId)) as OperationResult<SftpCloseAck>,
})

const localFs = Object.freeze({
  roots: async (): Promise<OperationResult<LocalRootsResult>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.localFsRoots)) as OperationResult<LocalRootsResult>,

  list: async (path: string): Promise<OperationResult<LocalDirectoryListing>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.localFsList,
      path,
    )) as OperationResult<LocalDirectoryListing>,
})

const transfer = Object.freeze({
  enqueueUpload: async (
    sessionId: string,
    remoteDirectory: string,
  ): Promise<OperationResult<TransferTask[]>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.transferEnqueueUpload,
      sessionId,
      remoteDirectory,
    )) as OperationResult<TransferTask[]>,

  enqueueUploadPaths: async (
    sessionId: string,
    remoteDirectory: string,
    localPaths: string[],
  ): Promise<OperationResult<TransferUploadEnqueueAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.transferEnqueueUploadPaths,
      sessionId,
      remoteDirectory,
      localPaths,
    )) as OperationResult<TransferUploadEnqueueAck>,

  enqueueDownload: async (
    sessionId: string,
    remotePaths: string[],
  ): Promise<OperationResult<TransferTask[]>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.transferEnqueueDownload,
      sessionId,
      remotePaths,
    )) as OperationResult<TransferTask[]>,

  enqueueDownloadPaths: async (
    sessionId: string,
    remotePaths: string[],
    localDirectory: string,
  ): Promise<OperationResult<TransferTask[]>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.transferEnqueueDownloadPaths,
      sessionId,
      remotePaths,
      localDirectory,
    )) as OperationResult<TransferTask[]>,

  cancel: async (transferId: string): Promise<OperationResult<TransferTask>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.transferCancel,
      transferId,
    )) as OperationResult<TransferTask>,

  retry: async (transferId: string): Promise<OperationResult<TransferTask>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.transferRetry,
      transferId,
    )) as OperationResult<TransferTask>,

  resolveConflict: async (
    transferId: string,
    choice: TransferConflictPolicy,
    newName?: string,
  ): Promise<OperationResult<TransferTask>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.transferResolveConflict,
      transferId,
      choice,
      newName,
    )) as OperationResult<TransferTask>,

  list: async (): Promise<OperationResult<TransferTask[]>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.transferList)) as OperationResult<TransferTask[]>,

  clearHistory: async (): Promise<OperationResult<TransferClearAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.transferClearHistory,
    )) as OperationResult<TransferClearAck>,

  onUpdate: (listener: (event: TransferUpdateEvent) => void): (() => void) =>
    subscribe(IPC_EVENT_CHANNELS.transferUpdate, listener),
})

const settings = Object.freeze({
  get: async (): Promise<OperationResult<SettingsSnapshot>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.settingsGet)) as OperationResult<SettingsSnapshot>,

  update: async (preferences: AppPreferences): Promise<OperationResult<SettingsSnapshot>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.settingsUpdate,
      preferences,
    )) as OperationResult<SettingsSnapshot>,
})

const hostKeys = Object.freeze({
  list: async (): Promise<OperationResult<HostKeyRecord[]>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.hostKeysList)) as OperationResult<HostKeyRecord[]>,

  remove: async (host: string, port: number): Promise<OperationResult<HostKeyRemovalAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.hostKeysRemove,
      host,
      port,
    )) as OperationResult<HostKeyRemovalAck>,
})

const logs = Object.freeze({
  getInfo: async (): Promise<OperationResult<LogInfo>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.logsGetInfo)) as OperationResult<LogInfo>,

  exportLogs: async (): Promise<OperationResult<LogExportAck>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.logsExport)) as OperationResult<LogExportAck>,

  openFolder: async (): Promise<OperationResult<LogFolderAck>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.logsOpenFolder)) as OperationResult<LogFolderAck>,
})

const wallpaper = Object.freeze({
  get: async (): Promise<OperationResult<WallpaperState>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.wallpaperGet)) as OperationResult<WallpaperState>,

  choose: async (): Promise<OperationResult<WallpaperChooseResult>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.wallpaperChoose,
    )) as OperationResult<WallpaperChooseResult>,

  remove: async (): Promise<OperationResult<WallpaperState>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.wallpaperRemove)) as OperationResult<WallpaperState>,
})

const quickCommands = Object.freeze({
  list: async (): Promise<OperationResult<QuickCommandSnapshot>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.quickCommandsList,
    )) as OperationResult<QuickCommandSnapshot>,

  create: async (input: QuickCommandDraft): Promise<OperationResult<QuickCommand>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.quickCommandsCreate,
      input,
    )) as OperationResult<QuickCommand>,

  update: async (id: string, input: QuickCommandDraft): Promise<OperationResult<QuickCommand>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.quickCommandsUpdate,
      id,
      input,
    )) as OperationResult<QuickCommand>,

  remove: async (id: string): Promise<OperationResult<{ id: string }>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.quickCommandsRemove, id)) as OperationResult<{
      id: string
    }>,

  setFavorite: async (id: string, favorite: boolean): Promise<OperationResult<QuickCommand>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.quickCommandsSetFavorite,
      id,
      favorite,
    )) as OperationResult<QuickCommand>,

  execute: async (
    input: QuickCommandExecuteInput,
  ): Promise<OperationResult<QuickCommandExecuteAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.quickCommandsExecute,
      input,
    )) as OperationResult<QuickCommandExecuteAck>,
})

const commandHistory = Object.freeze({
  list: async (): Promise<OperationResult<CommandHistorySnapshot>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.commandHistoryList,
    )) as OperationResult<CommandHistorySnapshot>,

  remove: async (id: string): Promise<OperationResult<{ id: string }>> =>
    (await ipcRenderer.invoke(IPC_CHANNELS.commandHistoryRemove, id)) as OperationResult<{
      id: string
    }>,

  clear: async (): Promise<OperationResult<CommandHistoryClearAck>> =>
    (await ipcRenderer.invoke(
      IPC_CHANNELS.commandHistoryClear,
    )) as OperationResult<CommandHistoryClearAck>,
})

const bridge: TermForgeBridge = Object.freeze({
  getAppInfo: async (): Promise<AppInfo> => {
    return (await ipcRenderer.invoke(IPC_CHANNELS.appGetInfo)) as AppInfo
  },

  getSecurityStatus: async (): Promise<SecurityStatus> => {
    return (await ipcRenderer.invoke(IPC_CHANNELS.securityGetStatus)) as SecurityStatus
  },

  // Electron removed `File.path`; `webUtils` is the supported replacement. It
  // returns '' for files without an on-disk path (e.g. in-memory drags).
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  connections,
  portForwards,
  ssh,
  terminal,
  sftp,
  localFs,
  transfer,
  settings,
  hostKeys,
  logs,
  wallpaper,
  quickCommands,
  commandHistory,
})

contextBridge.exposeInMainWorld('termforge', bridge)
