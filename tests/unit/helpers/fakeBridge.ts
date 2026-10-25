import type {
  AppInfo,
  ConnectionCatalog,
  QuickCommand,
  QuickCommandDraft,
  SecurityStatus,
  SessionInfo,
  SshJumpHop,
  SshSessionSnapshot,
  TerminalShellSnapshot,
  TermForgeBridge,
  TransferTask,
} from '@shared/types'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import { DEFAULT_TERMINAL_SIZE } from '@shared/types'
import { SEED_CONNECTION_CATALOG } from '@shared/fixtures/connectionSeed'

export const APP_INFO: AppInfo = {
  appName: 'TermForge',
  appVersion: '0.1.0',
  platform: 'win32',
  electronVersion: '45.0.0',
  chromeVersion: '142.0.0.0',
  isPackaged: false,
}

export const SECURITY_STATUS: SecurityStatus = {
  credentialStorage: {
    available: true,
    protection: 'windows-dpapi',
    message: '凭据将由 Windows DPAPI 保护。',
  },
  hostKeyPolicy: 'explicit-trust-only',
}

export function fakeCatalog(): ConnectionCatalog {
  return structuredClone(SEED_CONNECTION_CATALOG)
}

export function fakeSshSnapshot(overrides: Partial<SshSessionSnapshot> = {}): SshSessionSnapshot {
  return {
    clientId: 'sshtab-test',
    sessionId: 'ssh-test-session',
    connectionId: 'conn-prod-web-01',
    connectionName: 'prod-web-01',
    host: '10.20.4.11',
    port: 22,
    username: 'deploy',
    authMethod: 'privateKey',
    status: 'connected',
    createdAt: '2026-10-22T08:00:00.000Z',
    connectedAt: '2026-10-22T08:00:01.000Z',
    hostKey: null,
    error: null,
    jumps: [],
    activeHop: null,
    ...overrides,
  }
}

export function fakeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sshtab-test',
    sessionId: 'ssh-test-session',
    connectionId: 'conn-prod-web-01',
    connectionName: 'prod-web-01',
    host: '10.20.4.11',
    port: 22,
    username: 'deploy',
    authMethod: 'privateKey',
    title: 'prod-web-01',
    status: 'connected',
    generation: 1,
    hasTerminal: true,
    createdAt: '2026-10-22T08:00:00.000Z',
    connectedAt: '2026-10-22T08:00:01.000Z',
    hostKey: null,
    failure: null,
    jumps: [],
    activeHop: null,
    autoReconnect: null,
    ...overrides,
  }
}

function snapshotForConnection(connectionId: string, clientId: string): SshSessionSnapshot {
  const catalog = fakeCatalog()
  const connection = catalog.connections.find((item) => item.id === connectionId)
  const jumps: SshJumpHop[] = (connection?.jumpConnectionIds ?? []).flatMap((jumpId, index) => {
    const hop = catalog.connections.find((item) => item.id === jumpId)
    if (!hop) return []
    return [
      {
        index: index + 1,
        connectionId: hop.id,
        name: hop.name,
        host: hop.host,
        port: hop.port,
        username: hop.username,
        authMethod: hop.authMethod,
      },
    ]
  })
  return fakeSshSnapshot({
    clientId,
    sessionId: `ssh-${clientId}`,
    connectionId,
    connectionName: connection?.name ?? connectionId,
    host: connection?.host ?? '127.0.0.1',
    port: connection?.port ?? 22,
    username: connection?.username ?? 'operator',
    authMethod: connection?.authMethod ?? 'password',
    status: 'connecting',
    connectedAt: null,
    jumps,
  })
}

export function fakeTransferTask(overrides: Partial<TransferTask> = {}): TransferTask {
  return {
    id: 'transfer-test',
    sessionId: 'ssh-test-session',
    direction: 'upload',
    fileName: 'notes.txt',
    sourcePath: 'C:\\tmp\\notes.txt',
    destinationPath: '/home/deploy/notes.txt',
    status: 'queued',
    totalBytes: 1024,
    transferredBytes: 0,
    progress: 0,
    speedBytesPerSecond: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-10-22T08:00:00.000Z',
    startedAt: null,
    completedAt: null,
    attempt: 1,
    conflictPolicy: null,
    conflict: null,
    revision: 1,
    ...overrides,
  }
}

export function fakeQuickCommand(overrides: Partial<QuickCommand> = {}): QuickCommand {
  return {
    id: 'builtin-uptime',
    source: 'built-in',
    name: '系统运行时间',
    category: '基础信息',
    description: '查看系统已运行时间与平均负载',
    body: 'uptime',
    parameters: [],
    favorite: false,
    editable: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

function customQuickCommand(draft: QuickCommandDraft, id = 'qc-test'): QuickCommand {
  return {
    ...structuredClone(draft),
    id,
    source: 'custom',
    favorite: false,
    editable: true,
    createdAt: '2026-10-23T08:00:00.000Z',
    updatedAt: '2026-10-23T08:00:00.000Z',
  }
}

export function createFakeBridge(
  connections: Partial<TermForgeBridge['connections']> = {},
  ssh: Partial<TermForgeBridge['ssh']> = {},
  terminal: Partial<TermForgeBridge['terminal']> = {},
  sftp: Partial<TermForgeBridge['sftp']> = {},
  transfer: Partial<TermForgeBridge['transfer']> = {},
  settings: Partial<TermForgeBridge['settings']> = {},
  hostKeys: Partial<TermForgeBridge['hostKeys']> = {},
  logs: Partial<TermForgeBridge['logs']> = {},
  wallpaper: Partial<TermForgeBridge['wallpaper']> = {},
  localFs: Partial<TermForgeBridge['localFs']> = {},
  portForwards: Partial<TermForgeBridge['portForwards']> = {},
  quickCommands: Partial<TermForgeBridge['quickCommands']> = {},
  commandHistory: Partial<TermForgeBridge['commandHistory']> = {},
): TermForgeBridge {
  return {
    getAppInfo: async () => APP_INFO,
    getSecurityStatus: async () => SECURITY_STATUS,
    getPathForFile: () => '',
    connections: {
      list: async () => ({ ok: true, value: fakeCatalog() }),
      create: async () => {
        throw new Error('create is not implemented by this test bridge')
      },
      update: async () => {
        throw new Error('update is not implemented by this test bridge')
      },
      remove: async () => {
        throw new Error('remove is not implemented by this test bridge')
      },
      setFavorite: async () => {
        throw new Error('setFavorite is not implemented by this test bridge')
      },
      ...connections,
    },
    portForwards: {
      list: async () => ({ ok: true, value: { revision: 0, items: [] } }),
      create: async () => {
        throw new Error('create is not implemented by this test bridge')
      },
      update: async () => {
        throw new Error('update is not implemented by this test bridge')
      },
      remove: async () => {
        throw new Error('remove is not implemented by this test bridge')
      },
      start: async () => {
        throw new Error('start is not implemented by this test bridge')
      },
      stop: async () => {
        throw new Error('stop is not implemented by this test bridge')
      },
      getConnectionRemovalImpact: async (connectionId) => ({
        ok: true,
        value: { connectionId, portForwardRuleCount: 0, runningPortForwardCount: 0 },
      }),
      onSnapshot: () => () => {},
      ...portForwards,
    },
    ssh: {
      connect: async (connectionId, clientId) => ({
        ok: true,
        value: { session: snapshotForConnection(connectionId, clientId), reused: false },
      }),
      cancelConnect: async () => ({
        ok: true,
        value: { cancelled: false, session: null },
      }),
      disconnect: async () => ({
        ok: false,
        error: { code: 'not-found', message: '找不到该 SSH 会话。' },
      }),
      getStatus: async () => ({
        ok: false,
        error: { code: 'not-found', message: '找不到该 SSH 会话。' },
      }),
      respondToHostKey: async (requestId, accepted) => ({
        ok: true,
        value: { requestId, accepted },
      }),
      saveCredential: async ({ connectionId, kind }) => ({
        ok: true,
        value: { connectionId, kind },
      }),
      onSessionStatus: () => () => {},
      onHostKeyRequest: () => () => {},
      ...ssh,
    },
    terminal: {
      open: async (sessionId, size) => ({
        ok: true,
        value: { sessionId, status: 'open', size, reused: false },
      }),
      write: async (sessionId) => ({ ok: true, value: { sessionId } }),
      resize: async (sessionId) => ({ ok: true, value: { sessionId } }),
      close: async (sessionId) => ({ ok: true, value: { sessionId } }),
      getStatus: async (sessionId): Promise<{ ok: true; value: TerminalShellSnapshot }> => ({
        ok: true,
        value: {
          sessionId,
          status: 'idle',
          size: { ...DEFAULT_TERMINAL_SIZE },
          failure: null,
          exit: null,
        },
      }),
      readClipboard: async () => ({ ok: true, value: '' }),
      onOutput: () => () => {},
      onStatus: () => () => {},
      onExit: () => () => {},
      ...terminal,
    },
    sftp: {
      open: async (sessionId) => ({
        ok: true,
        value: { sessionId, homePath: '/home/deploy' },
      }),
      list: async (sessionId, path) => ({
        ok: true,
        value: {
          sessionId,
          path,
          entries: [],
          loadedAt: '2026-10-22T08:00:00.000Z',
        },
      }),
      stat: async (sessionId, path) => ({
        ok: true,
        value: {
          id: path,
          name: path.slice(path.lastIndexOf('/') + 1),
          path,
          kind: 'file',
          sizeBytes: 0,
          modifiedAt: '2026-10-22T08:00:00.000Z',
          permissions: '-rw-r--r--',
        },
      }),
      mkdir: async (sessionId, parentPath, name) => ({
        ok: true,
        value: {
          sessionId,
          path: `${parentPath === '/' ? '' : parentPath}/${name}`,
          operation: 'mkdir',
        },
      }),
      rename: async (sessionId, _sourcePath, targetPath) => ({
        ok: true,
        value: { sessionId, path: targetPath, operation: 'rename' },
      }),
      deleteFile: async (sessionId, path) => ({
        ok: true,
        value: { sessionId, path, operation: 'delete-file' },
      }),
      removeDirectory: async (sessionId, path) => ({
        ok: true,
        value: { sessionId, path, operation: 'remove-directory' },
      }),
      readTextFile: async (sessionId, path) => ({
        ok: true,
        value: {
          sessionId,
          path,
          content: '',
          encoding: 'utf-8' as const,
          eol: 'lf' as const,
          revision: '0:0',
          sizeBytes: 0,
          modifiedAt: '2026-10-22T08:00:00.000Z',
          permissions: '-rw-r--r--',
        },
      }),
      writeTextFile: async (input) => ({
        ok: true,
        value: {
          sessionId: input.sessionId,
          path: input.path,
          revision: '0:0',
          sizeBytes: new TextEncoder().encode(input.content).length,
          modifiedAt: '2026-10-22T08:00:00.000Z',
          backupCleanupFailed: false,
        },
      }),
      close: async (sessionId) => ({
        ok: true,
        value: { sessionId, closed: true },
      }),
      ...sftp,
    },
    transfer: {
      enqueueUpload: async () => ({ ok: true, value: [] }),
      enqueueUploadPaths: async (_sessionId, remoteDirectory) => ({
        ok: true,
        value: {
          tasks: [],
          skippedSymlinks: 0,
          skippedUnsupported: 0,
          truncated: false,
          remoteDirectory,
        },
      }),
      enqueueDownload: async () => ({ ok: true, value: [] }),
      enqueueDownloadPaths: async () => ({ ok: true, value: [] }),
      cancel: async () => ({
        ok: false,
        error: { code: 'not-found', message: '找不到该传输任务。' },
      }),
      retry: async () => ({
        ok: false,
        error: { code: 'not-found', message: '找不到该传输任务。' },
      }),
      resolveConflict: async () => ({
        ok: false,
        error: { code: 'not-found', message: '找不到该传输任务。' },
      }),
      list: async () => ({ ok: true, value: [] }),
      clearHistory: async () => ({ ok: true, value: { cleared: 0 } }),
      onUpdate: () => () => {},
      ...transfer,
    },
    localFs: {
      roots: async () => ({
        ok: true,
        value: {
          home: 'C:\\Users\\test',
          roots: [{ name: '主目录', path: 'C:\\Users\\test', kind: 'home' }],
        },
      }),
      list: async (path) => ({
        ok: true,
        value: {
          path,
          parentPath: null,
          entries: [],
          truncated: false,
          loadedAt: '2026-10-22T08:00:00.000Z',
        },
      }),
      ...localFs,
    },
    settings: {
      get: async () => ({
        ok: true,
        value: { preferences: { ...DEFAULT_APP_PREFERENCES }, warnings: [] },
      }),
      update: async (preferences) => ({
        ok: true,
        value: { preferences: { ...preferences }, warnings: [] },
      }),
      ...settings,
    },
    hostKeys: {
      list: async () => ({ ok: true, value: [] }),
      remove: async () => ({ ok: true, value: { removed: true } }),
      ...hostKeys,
    },
    logs: {
      getInfo: async () => ({
        ok: true,
        value: {
          directory: 'C:\\Users\\test\\AppData\\Roaming\\TermForge\\logs',
          level: 'info',
          files: [],
          writeFailures: 0,
        },
      }),
      exportLogs: async () => ({ ok: true, value: { exported: true } }),
      openFolder: async () => ({ ok: true, value: { opened: true } }),
      ...logs,
    },
    wallpaper: {
      get: async () => ({
        ok: true,
        value: { dataUrl: null, fileName: null, updatedAt: null },
      }),
      choose: async () => ({
        ok: true,
        value: { state: { dataUrl: null, fileName: null, updatedAt: null }, canceled: true },
      }),
      remove: async () => ({
        ok: true,
        value: { dataUrl: null, fileName: null, updatedAt: null },
      }),
      ...wallpaper,
    },
    quickCommands: {
      list: async () => ({ ok: true, value: { commands: [fakeQuickCommand()] } }),
      create: async (input) => ({ ok: true, value: customQuickCommand(input) }),
      update: async (id, input) => ({ ok: true, value: customQuickCommand(input, id) }),
      remove: async (id) => ({ ok: true, value: { id } }),
      setFavorite: async (id, favorite) => ({
        ok: true,
        value: fakeQuickCommand({ id, favorite }),
      }),
      execute: async (input) => ({
        ok: true,
        value: {
          requestId: input.requestId,
          body: 'uptime',
          writtenAt: '2026-10-23T08:00:00.000Z',
          historyRecorded: false,
          historyWarning: null,
        },
      }),
      ...quickCommands,
    },
    commandHistory: {
      list: async () => ({ ok: true, value: { entries: [] } }),
      remove: async (id) => ({ ok: true, value: { id } }),
      clear: async () => ({ ok: true, value: { cleared: 0 } }),
      ...commandHistory,
    },
  }
}
