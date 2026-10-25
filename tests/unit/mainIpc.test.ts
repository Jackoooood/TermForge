import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import { IPC_CHANNEL_NAMES, IPC_CHANNELS } from '@shared/constants/ipc'
import type {
  ConnectionCatalog,
  ConnectionInput,
  ConnectionProfile,
  CredentialStorageStatus,
  PortForwardItem,
  SshSessionSnapshot,
  TerminalShellSnapshot,
} from '@shared/types'
import { fakeTransferTask } from './helpers/fakeBridge'

interface FakeWebContents {
  mainFrame: object
}

interface FakeWindow {
  isDestroyed: () => boolean
  webContents: FakeWebContents
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  readClipboardText: vi.fn(() => 'echo from-clipboard'),
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', isPackaged: false },
  clipboard: { readText: electronMock.readClipboardText },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      electronMock.handlers.set(channel, handler)
    },
  },
}))

import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { AppOperationError } from '../../src/main/errors'
import type { LogServicePort } from '../../src/main/logging/logService'
import type { ConnectionStore } from '../../src/main/storage/connectionRepository'
import type { HostKeyStore } from '../../src/main/storage/hostKeyRepository'
import type { SettingsStore } from '../../src/main/storage/settingsRepository'
import type { CredentialStore } from '../../src/main/security/credentialStore'
import type { LocalFsServicePort } from '../../src/main/services/localFs/LocalFsService'
import type { PortForwardServicePort } from '../../src/main/services/portForward/PortForwardService'
import type { QuickCommandServicePort } from '../../src/main/services/quickCommands/QuickCommandService'
import type { SftpServicePort } from '../../src/main/services/sftp/SftpService'
import type { SshServicePort } from '../../src/main/services/ssh/SshService'
import type { TransferServicePort } from '../../src/main/services/transfers/TransferService'
import type { WallpaperServicePort } from '../../src/main/services/wallpaper/WallpaperService'

const AVAILABLE_STATUS: CredentialStorageStatus = {
  available: true,
  protection: 'windows-dpapi',
  message: '凭据将由 Windows DPAPI 保护。',
}

const INPUT: ConnectionInput = {
  name: 'ops-node',
  host: '10.20.4.99',
  port: 22,
  username: 'deploy',
  authMethod: 'sshAgent',
  groupId: 'production',
  tagIds: [],
  jumpConnectionIds: [],
}

const PROFILE: ConnectionProfile = {
  ...INPUT,
  id: 'conn-ops-node',
  favorite: false,
  createdAt: '2026-10-22T08:00:00.000Z',
  updatedAt: '2026-10-22T08:00:00.000Z',
}

const SNAPSHOT: SshSessionSnapshot = {
  clientId: 'sshtab-abc',
  sessionId: 'ssh-abc',
  connectionId: PROFILE.id,
  connectionName: PROFILE.name,
  host: PROFILE.host,
  port: PROFILE.port,
  username: PROFILE.username,
  authMethod: PROFILE.authMethod,
  status: 'connecting',
  createdAt: '2026-10-22T08:00:00.000Z',
  connectedAt: null,
  hostKey: null,
  error: null,
  jumps: [],
  activeHop: null,
}

const SHELL: TerminalShellSnapshot = {
  sessionId: SNAPSHOT.sessionId,
  status: 'open',
  size: { cols: 80, rows: 24 },
  failure: null,
  exit: null,
}

const TRANSFER_TASK = fakeTransferTask({ sessionId: SNAPSHOT.sessionId })

const PORT_FORWARD_ITEM: PortForwardItem = {
  rule: {
    id: 'pf-web',
    type: 'local',
    name: 'web',
    connectionId: PROFILE.id,
    bindAddress: '127.0.0.1',
    bindPort: 8080,
    targetHost: '127.0.0.1',
    targetPort: 80,
    createdAt: '2026-10-22T08:00:00.000Z',
    updatedAt: '2026-10-22T08:00:00.000Z',
  },
  runtime: {
    ruleId: 'pf-web',
    status: 'stopped',
    sessionId: null,
    boundAddress: null,
    boundPort: null,
    activeConnections: 0,
    startedAt: null,
    lastStopReason: null,
    failure: null,
    cleanupPending: false,
  },
}

function createWindow(): FakeWindow {
  const mainFrame = { routingId: 1 }
  return { isDestroyed: () => false, webContents: { mainFrame } }
}

function trustedEvent(window: FakeWindow): unknown {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame }
}

function createDependencies(overrides: Partial<ConnectionStore> = {}) {
  const catalog: ConnectionCatalog = { tags: [], connections: [PROFILE], groups: [] }
  const connections: ConnectionStore = {
    list: vi.fn().mockResolvedValue(catalog),
    create: vi.fn().mockResolvedValue(PROFILE),
    update: vi.fn().mockResolvedValue(PROFILE),
    remove: vi.fn().mockResolvedValue({ id: PROFILE.id }),
    setFavorite: vi.fn().mockResolvedValue({ ...PROFILE, favorite: true }),
    ...overrides,
  }
  const credentials: CredentialStore = {
    getStatus: vi.fn().mockResolvedValue(AVAILABLE_STATUS),
    save: vi.fn(),
    read: vi.fn(),
    remove: vi.fn(),
  }
  const portForwards: PortForwardServicePort = {
    list: vi.fn().mockResolvedValue({ revision: 1, items: [PORT_FORWARD_ITEM] }),
    create: vi.fn().mockResolvedValue(PORT_FORWARD_ITEM),
    update: vi.fn().mockResolvedValue(PORT_FORWARD_ITEM),
    remove: vi.fn().mockResolvedValue({ id: PORT_FORWARD_ITEM.rule.id }),
    start: vi.fn().mockResolvedValue(PORT_FORWARD_ITEM),
    stop: vi.fn().mockResolvedValue(PORT_FORWARD_ITEM),
    getConnectionRemovalImpact: vi.fn().mockResolvedValue({
      connectionId: PROFILE.id,
      portForwardRuleCount: 0,
      runningPortForwardCount: 0,
    }),
    removeForConnection: vi.fn().mockResolvedValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
  const ssh: SshServicePort = {
    connect: vi.fn().mockResolvedValue({ session: SNAPSHOT, reused: false }),
    cancelConnect: vi.fn().mockResolvedValue({
      cancelled: true,
      session: {
        ...SNAPSHOT,
        status: 'disconnected',
        error: { code: 'cancelled', message: '连接已取消。' },
      },
    }),
    disconnect: vi.fn().mockResolvedValue({ ...SNAPSHOT, status: 'disconnected' }),
    getStatus: vi.fn().mockResolvedValue(SNAPSHOT),
    respondToHostKey: vi.fn().mockResolvedValue({ requestId: 'hk-1', accepted: true }),
    saveCredential: vi.fn().mockResolvedValue({ connectionId: PROFILE.id, kind: 'password' }),
    openShell: vi
      .fn()
      .mockImplementation(async (sessionId: string, size: { cols: number; rows: number }) => ({
        sessionId,
        status: 'open',
        size,
        reused: false,
      })),
    writeShell: vi.fn().mockResolvedValue({ sessionId: SNAPSHOT.sessionId }),
    resizeShell: vi.fn().mockResolvedValue({ sessionId: SNAPSHOT.sessionId }),
    closeShell: vi.fn().mockResolvedValue({ sessionId: SNAPSHOT.sessionId }),
    getShellStatus: vi.fn().mockResolvedValue(SHELL),
    acquireForwardingSession: vi.fn(),
  }
  const sftp: SftpServicePort = {
    open: vi.fn().mockResolvedValue({
      sessionId: SNAPSHOT.sessionId,
      homePath: '/home/deploy',
    }),
    list: vi.fn().mockResolvedValue({
      sessionId: SNAPSHOT.sessionId,
      path: '/home/deploy',
      entries: [],
      loadedAt: '2026-10-22T08:00:00.000Z',
    }),
    stat: vi.fn().mockResolvedValue({
      id: '/home/deploy/notes.txt',
      name: 'notes.txt',
      path: '/home/deploy/notes.txt',
      kind: 'file',
      sizeBytes: 12,
      modifiedAt: '2026-10-22T08:00:00.000Z',
      permissions: '-rw-r--r--',
    }),
    mkdir: vi.fn().mockResolvedValue({
      sessionId: SNAPSHOT.sessionId,
      path: '/home/deploy/releases',
      operation: 'mkdir',
    }),
    rename: vi.fn().mockResolvedValue({
      sessionId: SNAPSHOT.sessionId,
      path: '/home/deploy/renamed.txt',
      operation: 'rename',
    }),
    deleteFile: vi.fn().mockResolvedValue({
      sessionId: SNAPSHOT.sessionId,
      path: '/home/deploy/notes.txt',
      operation: 'delete-file',
    }),
    removeDirectory: vi.fn().mockResolvedValue({
      sessionId: SNAPSHOT.sessionId,
      path: '/home/deploy/empty',
      operation: 'remove-directory',
    }),
    readTextFile: vi.fn().mockResolvedValue({
      sessionId: SNAPSHOT.sessionId,
      path: '/home/deploy/notes.txt',
      content: 'hello',
      encoding: 'utf-8',
      eol: 'lf',
      revision: '1:5',
      sizeBytes: 5,
      modifiedAt: '2026-10-22T08:00:00.000Z',
      permissions: '-rw-r--r--',
    }),
    writeTextFile: vi.fn().mockResolvedValue({
      sessionId: SNAPSHOT.sessionId,
      path: '/home/deploy/notes.txt',
      revision: '2:5',
      sizeBytes: 5,
      modifiedAt: '2026-10-22T08:01:00.000Z',
      backupCleanupFailed: false,
    }),
    close: vi.fn().mockResolvedValue({ sessionId: SNAPSHOT.sessionId, closed: true }),
  }
  const transfer: TransferServicePort = {
    enqueueUpload: vi.fn().mockResolvedValue([TRANSFER_TASK]),
    enqueueUploadPaths: vi.fn().mockResolvedValue({
      tasks: [TRANSFER_TASK],
      skippedSymlinks: 0,
      skippedUnsupported: 0,
      truncated: false,
      remoteDirectory: '/home/deploy/inbox',
    }),
    enqueueDownload: vi.fn().mockResolvedValue([TRANSFER_TASK]),
    enqueueDownloadPaths: vi.fn().mockResolvedValue([TRANSFER_TASK]),
    cancel: vi.fn().mockResolvedValue({ ...TRANSFER_TASK, status: 'cancelled', revision: 2 }),
    retry: vi
      .fn()
      .mockResolvedValue({ ...TRANSFER_TASK, attempt: 2, revision: 2, status: 'queued' }),
    resolveConflict: vi.fn().mockResolvedValue({ ...TRANSFER_TASK, revision: 2 }),
    list: vi.fn().mockResolvedValue([TRANSFER_TASK]),
    clearHistory: vi.fn().mockResolvedValue({ cleared: 1 }),
    handleSessionTerminated: vi.fn(),
    cancelAll: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    setConcurrencyLimits: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
  const settings: SettingsStore = {
    get: vi.fn().mockResolvedValue({
      preferences: { ...DEFAULT_APP_PREFERENCES },
      warnings: [],
    }),
    update: vi.fn().mockImplementation(async (preferences) => ({
      preferences: { ...preferences },
      warnings: [],
    })),
  }
  const hostKeys: HostKeyStore = {
    list: vi.fn().mockResolvedValue([]),
    verify: vi.fn().mockResolvedValue('unknown'),
    trust: vi.fn(),
    remove: vi.fn().mockResolvedValue(true),
  }
  const logs: LogServicePort = {
    getInfo: vi.fn().mockResolvedValue({
      directory: 'C:\\logs',
      level: 'info',
      files: [],
      writeFailures: 0,
    }),
    exportLogs: vi.fn().mockResolvedValue({ exported: true }),
    openFolder: vi.fn().mockResolvedValue({ opened: true }),
  }
  const emptyWallpaper = { dataUrl: null, fileName: null, updatedAt: null }
  const wallpaper: WallpaperServicePort = {
    get: vi.fn().mockResolvedValue(emptyWallpaper),
    choose: vi.fn().mockResolvedValue({ state: emptyWallpaper, canceled: true }),
    remove: vi.fn().mockResolvedValue(emptyWallpaper),
  }
  const applyRuntimePreferences = vi.fn()
  const localFs: LocalFsServicePort = {
    roots: vi.fn().mockResolvedValue({
      home: 'C:\\Users\\deploy',
      roots: [{ name: '主目录', path: 'C:\\Users\\deploy', kind: 'home' }],
    }),
    list: vi.fn().mockResolvedValue({
      path: 'C:\\Users\\deploy',
      parentPath: 'C:\\Users',
      entries: [],
      truncated: false,
      loadedAt: '2026-10-22T08:00:00.000Z',
    }),
  }
  const quickCommands: QuickCommandServicePort = {
    listCommands: vi.fn().mockResolvedValue({ commands: [] }),
    createCommand: vi.fn(),
    updateCommand: vi.fn(),
    removeCommand: vi.fn().mockResolvedValue({ id: 'qc-test' }),
    setFavorite: vi.fn(),
    execute: vi.fn().mockResolvedValue({
      requestId: 'req-12345678',
      body: 'uptime',
      writtenAt: '2026-10-23T08:00:00.000Z',
      historyRecorded: false,
      historyWarning: null,
    }),
    listHistory: vi.fn().mockResolvedValue({ entries: [] }),
    removeHistory: vi.fn().mockResolvedValue({ id: 'ch-test' }),
    clearHistory: vi.fn().mockResolvedValue({ cleared: 0 }),
  }
  return {
    connections,
    credentials,
    portForwards,
    ssh,
    sftp,
    transfer,
    localFs,
    settings,
    hostKeys,
    logs,
    wallpaper,
    quickCommands,
    applyRuntimePreferences,
  }
}

function register(window: FakeWindow | null = createWindow()) {
  const dependencies = createDependencies()
  registerIpcHandlers(() => window as unknown as BrowserWindow, dependencies)
  return dependencies
}

function handlerFor(channel: string): Handler {
  const handler = electronMock.handlers.get(channel)
  if (!handler) throw new Error(`Missing handler for ${channel}`)
  return handler
}

describe('main-process IPC', () => {
  beforeEach(() => {
    electronMock.handlers.clear()
  })

  it('registers only fixed domain channels', () => {
    register()
    expect([...electronMock.handlers.keys()].sort()).toEqual([...IPC_CHANNEL_NAMES].sort())
    expect(IPC_CHANNEL_NAMES).toEqual([
      'app:get-info',
      'connections:list',
      'connections:create',
      'connections:update',
      'connections:remove',
      'connections:set-favorite',
      'port-forwards:list',
      'port-forwards:create',
      'port-forwards:update',
      'port-forwards:remove',
      'port-forwards:start',
      'port-forwards:stop',
      'port-forwards:connection-impact',
      'security:get-status',
      'ssh:connect',
      'ssh:cancel-connect',
      'ssh:disconnect',
      'ssh:get-status',
      'ssh:respond-host-key',
      'ssh:set-credential',
      'terminal:open',
      'terminal:write',
      'terminal:resize',
      'terminal:close',
      'terminal:get-status',
      'terminal:read-clipboard',
      'sftp:open',
      'sftp:list',
      'sftp:stat',
      'sftp:mkdir',
      'sftp:rename',
      'sftp:delete-file',
      'sftp:remove-directory',
      'sftp:read-text-file',
      'sftp:write-text-file',
      'sftp:close',
      'local-fs:list',
      'local-fs:roots',
      'transfer:enqueue-upload',
      'transfer:enqueue-download',
      'transfer:enqueue-upload-paths',
      'transfer:enqueue-download-paths',
      'transfer:cancel',
      'transfer:retry',
      'transfer:resolve-conflict',
      'transfer:list',
      'transfer:clear-history',
      'settings:get',
      'settings:update',
      'host-keys:list',
      'host-keys:remove',
      'logs:get-info',
      'logs:export',
      'logs:open-folder',
      'wallpaper:get',
      'wallpaper:choose',
      'wallpaper:remove',
      'quick-commands:list',
      'quick-commands:create',
      'quick-commands:update',
      'quick-commands:remove',
      'quick-commands:set-favorite',
      'quick-commands:execute',
      'command-history:list',
      'command-history:remove',
      'command-history:clear',
    ])
  })

  it('serves app info and rejects untrusted senders on every channel', async () => {
    const window = createWindow()
    register(window)

    await expect(handlerFor(IPC_CHANNELS.appGetInfo)(trustedEvent(window))).toMatchObject({
      appName: 'TermForge',
      appVersion: '0.1.0',
      isPackaged: false,
    })

    const untrustedEvent = { sender: {}, senderFrame: window.webContents.mainFrame }
    const nonMainFrameEvent = { sender: window.webContents, senderFrame: {} }
    for (const channel of IPC_CHANNEL_NAMES) {
      await expect((async () => handlerFor(channel)(untrustedEvent))(), channel).rejects.toThrow(
        /untrusted sender/,
      )
      await expect((async () => handlerFor(channel)(nonMainFrameEvent))(), channel).rejects.toThrow(
        /non-main frame/,
      )
    }
  })

  it('rejects every request when the tracked window is gone', async () => {
    register(null)
    const window = createWindow()
    await expect(
      (async () => handlerFor(IPC_CHANNELS.connectionsList)(trustedEvent(window)))(),
    ).rejects.toThrow(/untrusted sender/)
  })

  it('returns typed results and validates connection input at the boundary', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const create = handlerFor(IPC_CHANNELS.connectionsCreate)

    const result = await create(trustedEvent(window), INPUT)
    expect(result).toEqual({ ok: true, value: PROFILE })
    expect(dependencies.connections.create).toHaveBeenCalledWith(INPUT)

    const withPassword = await create(trustedEvent(window), {
      ...INPUT,
      password: 'super-secret',
    })
    expect(withPassword).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '连接配置未通过校验，请检查字段后重试。' },
    })
    expect(dependencies.connections.create).toHaveBeenCalledTimes(1)

    const invalidHost = await create(trustedEvent(window), { ...INPUT, host: 'http://example' })
    expect(invalidHost).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('validates ids and sanitizes repository failures', async () => {
    const window = createWindow()
    const connections: ConnectionStore = {
      list: vi.fn().mockRejectedValue(new AppOperationError('storage-corrupt', '本地配置已损坏。')),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn().mockRejectedValue(new AppOperationError('not-found', '找不到该连接。')),
      setFavorite: vi
        .fn()
        .mockRejectedValue(new Error('ENOENT C:\\Users\\secret\\connections.json')),
    }
    const base = createDependencies()
    registerIpcHandlers(() => window as unknown as BrowserWindow, {
      ...base,
      connections,
    })

    const update = handlerFor(IPC_CHANNELS.connectionsUpdate)
    expect(await update(trustedEvent(window), '../bad id', INPUT)).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '连接 ID 格式无效。' },
    })
    expect(connections.update).not.toHaveBeenCalled()

    expect(await handlerFor(IPC_CHANNELS.connectionsList)(trustedEvent(window))).toEqual({
      ok: false,
      error: { code: 'storage-corrupt', message: '本地配置已损坏。' },
    })

    expect(
      await handlerFor(IPC_CHANNELS.connectionsRemove)(trustedEvent(window), PROFILE.id),
    ).toEqual({
      ok: false,
      error: { code: 'not-found', message: '找不到该连接。' },
    })

    const favoriteResult = await handlerFor(IPC_CHANNELS.connectionsSetFavorite)(
      trustedEvent(window),
      PROFILE.id,
      true,
    )
    expect(favoriteResult).toEqual({
      ok: false,
      error: { code: 'internal', message: '操作未能完成，请稍后重试。' },
    })
    expect(JSON.stringify(favoriteResult)).not.toContain('secret')
  })

  it('rejects non-boolean favorite input before touching storage', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const result = await handlerFor(IPC_CHANNELS.connectionsSetFavorite)(
      trustedEvent(window),
      PROFILE.id,
      'true',
    )
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '收藏操作参数无效。' },
    })
    expect(dependencies.connections.setFavorite).not.toHaveBeenCalled()
  })

  it('routes validated SSH requests to the main-process SSH service', async () => {
    const window = createWindow()
    const dependencies = register(window)

    expect(
      await handlerFor(IPC_CHANNELS.sshConnect)(trustedEvent(window), '../bad', 'sshtab-abc'),
    ).toEqual({ ok: false, error: { code: 'invalid-input', message: '连接 ID 格式无效。' } })
    expect(
      await handlerFor(IPC_CHANNELS.sshConnect)(trustedEvent(window), PROFILE.id, 'bad tab'),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: 'SSH 客户端标识格式无效。' },
    })
    expect(dependencies.ssh.connect).not.toHaveBeenCalled()

    await expect(
      handlerFor(IPC_CHANNELS.sshConnect)(trustedEvent(window), PROFILE.id, 'sshtab-abc'),
    ).resolves.toEqual({ ok: true, value: { session: SNAPSHOT, reused: false } })
    expect(dependencies.ssh.connect).toHaveBeenCalledWith(PROFILE.id, 'sshtab-abc')

    expect(
      await handlerFor(IPC_CHANNELS.sshCancelConnect)(trustedEvent(window), 'bad tab'),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: 'SSH 客户端标识格式无效。' },
    })
    expect(dependencies.ssh.cancelConnect).not.toHaveBeenCalled()

    await expect(
      handlerFor(IPC_CHANNELS.sshCancelConnect)(trustedEvent(window), 'sshtab-abc'),
    ).resolves.toEqual({
      ok: true,
      value: {
        cancelled: true,
        session: {
          ...SNAPSHOT,
          status: 'disconnected',
          error: { code: 'cancelled', message: '连接已取消。' },
        },
      },
    })
    expect(dependencies.ssh.cancelConnect).toHaveBeenCalledWith('sshtab-abc')

    expect(
      await handlerFor(IPC_CHANNELS.sshGetStatus)(trustedEvent(window), 'not-a-session'),
    ).toEqual({ ok: false, error: { code: 'invalid-input', message: 'SSH 会话 ID 格式无效。' } })
    expect(dependencies.ssh.getStatus).not.toHaveBeenCalled()

    await expect(
      handlerFor(IPC_CHANNELS.sshGetStatus)(trustedEvent(window), SNAPSHOT.sessionId),
    ).resolves.toEqual({ ok: true, value: SNAPSHOT })
    await expect(
      handlerFor(IPC_CHANNELS.sshDisconnect)(trustedEvent(window), SNAPSHOT.sessionId),
    ).resolves.toEqual({ ok: true, value: { ...SNAPSHOT, status: 'disconnected' } })
    expect(dependencies.ssh.disconnect).toHaveBeenCalledWith(SNAPSHOT.sessionId)
  })

  it('validates host-key decisions and SSH credential payloads at the IPC boundary', async () => {
    const window = createWindow()
    const dependencies = register(window)

    expect(
      await handlerFor(IPC_CHANNELS.sshRespondHostKey)(trustedEvent(window), 'hk-1', 'yes'),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '主机密钥确认参数无效。' },
    })
    expect(dependencies.ssh.respondToHostKey).not.toHaveBeenCalled()

    await expect(
      handlerFor(IPC_CHANNELS.sshRespondHostKey)(trustedEvent(window), 'hk-1', true),
    ).resolves.toEqual({ ok: true, value: { requestId: 'hk-1', accepted: true } })
    expect(dependencies.ssh.respondToHostKey).toHaveBeenCalledWith('hk-1', true)

    expect(
      await handlerFor(IPC_CHANNELS.sshSetCredential)(trustedEvent(window), {
        connectionId: PROFILE.id,
        kind: 'password',
      }),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '凭据参数未通过校验。' },
    })
    expect(dependencies.ssh.saveCredential).not.toHaveBeenCalled()

    const saved = await handlerFor(IPC_CHANNELS.sshSetCredential)(trustedEvent(window), {
      connectionId: PROFILE.id,
      kind: 'password',
      secret: 'correct horse battery staple',
    })
    expect(saved).toEqual({ ok: true, value: { connectionId: PROFILE.id, kind: 'password' } })
    expect(JSON.stringify(saved)).not.toContain('horse')
    expect(dependencies.ssh.saveCredential).toHaveBeenCalledWith({
      connectionId: PROFILE.id,
      kind: 'password',
      secret: 'correct horse battery staple',
    })
  })

  it('validates terminal sizes, input and session ids before routing to the shell service', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const open = handlerFor(IPC_CHANNELS.terminalOpen)
    const write = handlerFor(IPC_CHANNELS.terminalWrite)
    const resize = handlerFor(IPC_CHANNELS.terminalResize)
    const close = handlerFor(IPC_CHANNELS.terminalClose)
    const getStatus = handlerFor(IPC_CHANNELS.terminalGetStatus)
    const event = trustedEvent(window)

    expect(await open(event, SNAPSHOT.sessionId, { cols: 0, rows: 24 })).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '终端打开参数未通过校验。' },
    })
    expect(await open(event, SNAPSHOT.sessionId, { cols: 80, rows: 24, extra: 1 })).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '终端打开参数未通过校验。' },
    })
    expect(await open(event, 'not-a-session', { cols: 80, rows: 24 })).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '终端打开参数未通过校验。' },
    })
    expect(dependencies.ssh.openShell).not.toHaveBeenCalled()

    await expect(open(event, SNAPSHOT.sessionId, { cols: 100, rows: 40 })).resolves.toEqual({
      ok: true,
      value: {
        sessionId: SNAPSHOT.sessionId,
        status: 'open',
        size: { cols: 100, rows: 40 },
        reused: false,
      },
    })
    expect(dependencies.ssh.openShell).toHaveBeenCalledWith(SNAPSHOT.sessionId, {
      cols: 100,
      rows: 40,
    })

    expect(await write(event, SNAPSHOT.sessionId, 42)).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '终端输入参数未通过校验。' },
    })
    expect(await write(event, SNAPSHOT.sessionId, 'x'.repeat(65_537))).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '终端输入参数未通过校验。' },
    })
    expect(dependencies.ssh.writeShell).not.toHaveBeenCalled()
    await expect(write(event, SNAPSHOT.sessionId, 'pwd\r')).resolves.toEqual({
      ok: true,
      value: { sessionId: SNAPSHOT.sessionId },
    })
    expect(dependencies.ssh.writeShell).toHaveBeenCalledWith(SNAPSHOT.sessionId, 'pwd\r')

    expect(await resize(event, SNAPSHOT.sessionId, { cols: -1, rows: 24 })).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '终端尺寸参数未通过校验。' },
    })
    expect(dependencies.ssh.resizeShell).not.toHaveBeenCalled()
    await expect(resize(event, SNAPSHOT.sessionId, { cols: 120, rows: 50 })).resolves.toEqual({
      ok: true,
      value: { sessionId: SNAPSHOT.sessionId },
    })
    expect(dependencies.ssh.resizeShell).toHaveBeenCalledWith(SNAPSHOT.sessionId, {
      cols: 120,
      rows: 50,
    })

    expect(await close(event, 'bad session')).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: 'SSH 会话 ID 格式无效。' },
    })
    await expect(close(event, SNAPSHOT.sessionId)).resolves.toEqual({
      ok: true,
      value: { sessionId: SNAPSHOT.sessionId },
    })
    expect(dependencies.ssh.closeShell).toHaveBeenCalledWith(SNAPSHOT.sessionId)

    expect(await getStatus(event, 'bad session')).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: 'SSH 会话 ID 格式无效。' },
    })
    await expect(getStatus(event, SNAPSHOT.sessionId)).resolves.toEqual({
      ok: true,
      value: SHELL,
    })
    expect(dependencies.ssh.getShellStatus).toHaveBeenCalledWith(SNAPSHOT.sessionId)
  })

  it('reads the clipboard only for a trusted main frame', async () => {
    const window = createWindow()
    register(window)
    electronMock.readClipboardText.mockClear()

    await expect(
      handlerFor(IPC_CHANNELS.terminalReadClipboard)(trustedEvent(window)),
    ).resolves.toEqual({ ok: true, value: 'echo from-clipboard' })
    expect(electronMock.readClipboardText).toHaveBeenCalledTimes(1)
  })

  it('validates SFTP session ids, absolute paths and names before routing', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const event = trustedEvent(window)

    expect(await handlerFor(IPC_CHANNELS.sftpOpen)(event, '../bad')).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: 'SFTP 打开参数未通过校验。' },
    })
    expect(await handlerFor(IPC_CHANNELS.sftpList)(event, SNAPSHOT.sessionId, 'relative')).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: 'SFTP 目录参数未通过校验。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.sftpStat)(event, SNAPSHOT.sessionId, '/bad\0path'),
    ).toEqual({ ok: false, error: { code: 'invalid-input', message: 'SFTP 路径参数未通过校验。' } })
    expect(
      await handlerFor(IPC_CHANNELS.sftpMkdir)(event, SNAPSHOT.sessionId, '/home/deploy', '../x'),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '新建目录参数未通过校验。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.sftpRename)(
        event,
        SNAPSHOT.sessionId,
        '/home/deploy/a',
        'relative',
      ),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '重命名参数未通过校验。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.sftpReadTextFile)(event, SNAPSHOT.sessionId, 'relative'),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '读取文本文件参数未通过校验。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.sftpWriteTextFile)(event, {
        sessionId: SNAPSHOT.sessionId,
        path: '/home/deploy/notes.txt',
        content: 'x',
        encoding: 'utf-16',
        eol: 'lf',
        expectedRevision: null,
        force: false,
      }),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '保存文本文件参数未通过校验。' },
    })
    expect(dependencies.sftp.open).not.toHaveBeenCalled()
    expect(dependencies.sftp.list).not.toHaveBeenCalled()
    expect(dependencies.sftp.stat).not.toHaveBeenCalled()
    expect(dependencies.sftp.mkdir).not.toHaveBeenCalled()
    expect(dependencies.sftp.rename).not.toHaveBeenCalled()

    await expect(handlerFor(IPC_CHANNELS.sftpOpen)(event, SNAPSHOT.sessionId)).resolves.toEqual({
      ok: true,
      value: { sessionId: SNAPSHOT.sessionId, homePath: '/home/deploy' },
    })
    await expect(
      handlerFor(IPC_CHANNELS.sftpList)(event, SNAPSHOT.sessionId, '/home/deploy/'),
    ).resolves.toMatchObject({ ok: true, value: { sessionId: SNAPSHOT.sessionId } })
    await expect(
      handlerFor(IPC_CHANNELS.sftpStat)(event, SNAPSHOT.sessionId, '/home/deploy/notes.txt'),
    ).resolves.toMatchObject({ ok: true, value: { kind: 'file' } })
    await expect(
      handlerFor(IPC_CHANNELS.sftpMkdir)(event, SNAPSHOT.sessionId, '/home/deploy', 'releases'),
    ).resolves.toMatchObject({ ok: true, value: { operation: 'mkdir' } })
    await expect(
      handlerFor(IPC_CHANNELS.sftpRename)(
        event,
        SNAPSHOT.sessionId,
        '/home/deploy/notes.txt',
        '/home/deploy/renamed.txt',
      ),
    ).resolves.toMatchObject({ ok: true, value: { operation: 'rename' } })
    await expect(
      handlerFor(IPC_CHANNELS.sftpDeleteFile)(event, SNAPSHOT.sessionId, '/home/deploy/notes.txt'),
    ).resolves.toMatchObject({ ok: true, value: { operation: 'delete-file' } })
    await expect(
      handlerFor(IPC_CHANNELS.sftpRemoveDirectory)(event, SNAPSHOT.sessionId, '/home/deploy/empty'),
    ).resolves.toMatchObject({ ok: true, value: { operation: 'remove-directory' } })
    await expect(
      handlerFor(IPC_CHANNELS.sftpReadTextFile)(
        event,
        SNAPSHOT.sessionId,
        '/home/deploy/notes.txt',
      ),
    ).resolves.toMatchObject({ ok: true, value: { content: 'hello' } })
    await expect(
      handlerFor(IPC_CHANNELS.sftpWriteTextFile)(event, {
        sessionId: SNAPSHOT.sessionId,
        path: '/home/deploy/notes.txt',
        content: 'hello',
        encoding: 'utf-8',
        eol: 'lf',
        expectedRevision: '1:5',
        force: false,
      }),
    ).resolves.toMatchObject({ ok: true, value: { revision: '2:5' } })
    await expect(handlerFor(IPC_CHANNELS.sftpClose)(event, SNAPSHOT.sessionId)).resolves.toEqual({
      ok: true,
      value: { sessionId: SNAPSHOT.sessionId, closed: true },
    })

    expect(dependencies.sftp.list).toHaveBeenCalledWith(SNAPSHOT.sessionId, '/home/deploy/')
    expect(dependencies.sftp.mkdir).toHaveBeenCalledWith(
      SNAPSHOT.sessionId,
      '/home/deploy',
      'releases',
    )
    expect(dependencies.sftp.removeDirectory).toHaveBeenCalledWith(
      SNAPSHOT.sessionId,
      '/home/deploy/empty',
    )
    expect(dependencies.sftp.readTextFile).toHaveBeenCalledWith(
      SNAPSHOT.sessionId,
      '/home/deploy/notes.txt',
    )
    expect(dependencies.sftp.writeTextFile).toHaveBeenCalledWith({
      sessionId: SNAPSHOT.sessionId,
      path: '/home/deploy/notes.txt',
      content: 'hello',
      encoding: 'utf-8',
      eol: 'lf',
      expectedRevision: '1:5',
      force: false,
    })
  })

  it('validates local-fs paths and routes metadata-only browsing requests', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const event = trustedEvent(window)

    await expect(handlerFor(IPC_CHANNELS.localFsRoots)(event)).resolves.toEqual({
      ok: true,
      value: {
        home: 'C:\\Users\\deploy',
        roots: [{ name: '主目录', path: 'C:\\Users\\deploy', kind: 'home' }],
      },
    })

    await expect(
      handlerFor(IPC_CHANNELS.localFsList)(event, 'C:\\Users\\deploy'),
    ).resolves.toMatchObject({ ok: true, value: { path: 'C:\\Users\\deploy' } })
    expect(dependencies.localFs.list).toHaveBeenCalledWith('C:\\Users\\deploy')

    expect(await handlerFor(IPC_CHANNELS.localFsList)(event, 'relative\\path')).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '本地目录参数未通过校验。' },
    })
    expect(await handlerFor(IPC_CHANNELS.localFsList)(event, '\\\\?\\C:\\device')).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '本地目录参数未通过校验。' },
    })
    expect(dependencies.localFs.list).toHaveBeenCalledTimes(1)
  })

  it('validates explicit-path transfer requests before routing', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const event = trustedEvent(window)

    await expect(
      handlerFor(IPC_CHANNELS.transferEnqueueUploadPaths)(event, SNAPSHOT.sessionId, 'relative', [
        'C:\\src\\app.js',
      ]),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '上传路径参数未通过校验。' },
    })
    await expect(
      handlerFor(IPC_CHANNELS.transferEnqueueUploadPaths)(
        event,
        SNAPSHOT.sessionId,
        '/home/deploy',
        ['relative/path'],
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '上传路径参数未通过校验。' },
    })
    await expect(
      handlerFor(IPC_CHANNELS.transferEnqueueUploadPaths)(
        event,
        SNAPSHOT.sessionId,
        '/home/deploy',
        [],
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '上传路径参数未通过校验。' },
    })
    await expect(
      handlerFor(IPC_CHANNELS.transferEnqueueDownloadPaths)(
        event,
        SNAPSHOT.sessionId,
        ['/home/deploy/a.txt'],
        'relative',
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '下载路径参数未通过校验。' },
    })
    expect(dependencies.transfer.enqueueUploadPaths).not.toHaveBeenCalled()
    expect(dependencies.transfer.enqueueDownloadPaths).not.toHaveBeenCalled()

    await expect(
      handlerFor(IPC_CHANNELS.transferEnqueueUploadPaths)(
        event,
        SNAPSHOT.sessionId,
        '/home/deploy',
        ['C:\\src\\app.js', 'C:\\src\\assets'],
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        tasks: [TRANSFER_TASK],
        skippedSymlinks: 0,
        skippedUnsupported: 0,
        truncated: false,
        remoteDirectory: '/home/deploy/inbox',
      },
    })
    expect(dependencies.transfer.enqueueUploadPaths).toHaveBeenCalledWith(
      SNAPSHOT.sessionId,
      '/home/deploy',
      ['C:\\src\\app.js', 'C:\\src\\assets'],
    )

    await expect(
      handlerFor(IPC_CHANNELS.transferEnqueueDownloadPaths)(
        event,
        SNAPSHOT.sessionId,
        ['/home/deploy/a.txt'],
        'C:\\Users\\deploy\\Downloads',
      ),
    ).resolves.toEqual({ ok: true, value: [TRANSFER_TASK] })
    expect(dependencies.transfer.enqueueDownloadPaths).toHaveBeenCalledWith(
      SNAPSHOT.sessionId,
      ['/home/deploy/a.txt'],
      'C:\\Users\\deploy\\Downloads',
    )
  })

  it('validates transfer requests and routes them to the main-process transfer service', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const event = trustedEvent(window)

    expect(
      await handlerFor(IPC_CHANNELS.transferEnqueueUpload)(event, '../bad', '/home/deploy'),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '上传请求参数未通过校验。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.transferEnqueueUpload)(event, SNAPSHOT.sessionId, 'relative'),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '上传请求参数未通过校验。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.transferEnqueueDownload)(event, SNAPSHOT.sessionId, []),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '下载请求参数未通过校验。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.transferEnqueueDownload)(event, SNAPSHOT.sessionId, [
        '/home/deploy/a.txt',
        'relative',
      ]),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '下载请求参数未通过校验。' },
    })
    expect(await handlerFor(IPC_CHANNELS.transferCancel)(event, '../bad')).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '传输任务 ID 格式无效。' },
    })
    expect(await handlerFor(IPC_CHANNELS.transferRetry)(event, 42)).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '传输任务 ID 格式无效。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.transferResolveConflict)(event, TRANSFER_TASK.id, 'rename'),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '冲突处理参数未通过校验。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.transferResolveConflict)(
        event,
        TRANSFER_TASK.id,
        'overwrite',
        'copy.txt',
      ),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '冲突处理参数未通过校验。' },
    })
    expect(dependencies.transfer.enqueueUpload).not.toHaveBeenCalled()
    expect(dependencies.transfer.enqueueDownload).not.toHaveBeenCalled()
    expect(dependencies.transfer.cancel).not.toHaveBeenCalled()
    expect(dependencies.transfer.retry).not.toHaveBeenCalled()
    expect(dependencies.transfer.resolveConflict).not.toHaveBeenCalled()

    await expect(
      handlerFor(IPC_CHANNELS.transferEnqueueUpload)(event, SNAPSHOT.sessionId, '/home/deploy'),
    ).resolves.toEqual({ ok: true, value: [TRANSFER_TASK] })
    expect(dependencies.transfer.enqueueUpload).toHaveBeenCalledWith(
      SNAPSHOT.sessionId,
      '/home/deploy',
    )

    await expect(
      handlerFor(IPC_CHANNELS.transferEnqueueDownload)(event, SNAPSHOT.sessionId, [
        '/home/deploy/a.txt',
      ]),
    ).resolves.toEqual({ ok: true, value: [TRANSFER_TASK] })
    expect(dependencies.transfer.enqueueDownload).toHaveBeenCalledWith(SNAPSHOT.sessionId, [
      '/home/deploy/a.txt',
    ])

    await expect(
      handlerFor(IPC_CHANNELS.transferCancel)(event, TRANSFER_TASK.id),
    ).resolves.toMatchObject({ ok: true, value: { status: 'cancelled' } })
    expect(dependencies.transfer.cancel).toHaveBeenCalledWith(TRANSFER_TASK.id)

    await expect(
      handlerFor(IPC_CHANNELS.transferRetry)(event, TRANSFER_TASK.id),
    ).resolves.toMatchObject({ ok: true, value: { attempt: 2 } })
    expect(dependencies.transfer.retry).toHaveBeenCalledWith(TRANSFER_TASK.id)

    await expect(
      handlerFor(IPC_CHANNELS.transferResolveConflict)(
        event,
        TRANSFER_TASK.id,
        'rename',
        'a-copy.txt',
      ),
    ).resolves.toEqual({ ok: true, value: { ...TRANSFER_TASK, revision: 2 } })
    expect(dependencies.transfer.resolveConflict).toHaveBeenCalledWith(
      TRANSFER_TASK.id,
      'rename',
      'a-copy.txt',
    )

    await expect(handlerFor(IPC_CHANNELS.transferList)(event)).resolves.toEqual({
      ok: true,
      value: [TRANSFER_TASK],
    })
    await expect(handlerFor(IPC_CHANNELS.transferClearHistory)(event)).resolves.toEqual({
      ok: true,
      value: { cleared: 1 },
    })
  })

  it('validates and dispatches settings, host-key and log requests', async () => {
    const window = createWindow()
    const dependencies = register(window)

    await expect(handlerFor(IPC_CHANNELS.settingsGet)(trustedEvent(window))).resolves.toEqual({
      ok: true,
      value: { preferences: DEFAULT_APP_PREFERENCES, warnings: [] },
    })

    expect(
      await handlerFor(IPC_CHANNELS.settingsUpdate)(trustedEvent(window), {
        ...DEFAULT_APP_PREFERENCES,
        terminalFontSize: 7,
      }),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '设置参数未通过校验，未写入任何数据。' },
    })
    expect(dependencies.settings.update).not.toHaveBeenCalled()

    expect(
      await handlerFor(IPC_CHANNELS.settingsUpdate)(trustedEvent(window), {
        ...DEFAULT_APP_PREFERENCES,
        theme: 'mist',
        extra: 'ignored?',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })

    await expect(
      handlerFor(IPC_CHANNELS.settingsUpdate)(trustedEvent(window), {
        ...DEFAULT_APP_PREFERENCES,
        theme: 'mist',
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        preferences: { ...DEFAULT_APP_PREFERENCES, theme: 'mist' },
        warnings: [],
      },
    })
    expect(dependencies.applyRuntimePreferences).toHaveBeenCalledWith({
      ...DEFAULT_APP_PREFERENCES,
      theme: 'mist',
    })

    await expect(handlerFor(IPC_CHANNELS.hostKeysList)(trustedEvent(window))).resolves.toEqual({
      ok: true,
      value: [],
    })

    expect(
      await handlerFor(IPC_CHANNELS.hostKeysRemove)(trustedEvent(window), '10.20.4.11', 0),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '主机端点参数无效。' },
    })
    expect(dependencies.hostKeys.remove).not.toHaveBeenCalled()

    await expect(
      handlerFor(IPC_CHANNELS.hostKeysRemove)(trustedEvent(window), '10.20.4.11', 22),
    ).resolves.toEqual({ ok: true, value: { removed: true } })
    expect(dependencies.hostKeys.remove).toHaveBeenCalledWith('10.20.4.11', 22)

    await expect(handlerFor(IPC_CHANNELS.logsGetInfo)(trustedEvent(window))).resolves.toEqual({
      ok: true,
      value: {
        directory: 'C:\\logs',
        level: 'info',
        files: [],
        writeFailures: 0,
      },
    })
    await expect(handlerFor(IPC_CHANNELS.logsExport)(trustedEvent(window))).resolves.toEqual({
      ok: true,
      value: { exported: true },
    })
    await expect(handlerFor(IPC_CHANNELS.logsOpenFolder)(trustedEvent(window))).resolves.toEqual({
      ok: true,
      value: { opened: true },
    })
  })

  it('routes wallpaper requests and sanitizes service failures', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const event = trustedEvent(window)
    const state = {
      dataUrl: 'data:image/jpeg;base64,AAAA',
      fileName: 'desk.jpg',
      updatedAt: '2026-10-22T08:00:00.000Z',
    }

    await expect(handlerFor(IPC_CHANNELS.wallpaperGet)(event)).resolves.toEqual({
      ok: true,
      value: { dataUrl: null, fileName: null, updatedAt: null },
    })

    await expect(handlerFor(IPC_CHANNELS.wallpaperChoose)(event)).resolves.toEqual({
      ok: true,
      value: { state: { dataUrl: null, fileName: null, updatedAt: null }, canceled: true },
    })
    expect(dependencies.wallpaper.choose).toHaveBeenCalledTimes(1)

    await expect(handlerFor(IPC_CHANNELS.wallpaperRemove)(event)).resolves.toEqual({
      ok: true,
      value: { dataUrl: null, fileName: null, updatedAt: null },
    })
    expect(dependencies.wallpaper.remove).toHaveBeenCalledTimes(1)

    const get = dependencies.wallpaper.get as ReturnType<typeof vi.fn>
    get.mockRejectedValueOnce(
      new AppOperationError('storage-read-failed', '无法读取已保存的壁纸。'),
    )
    expect(await handlerFor(IPC_CHANNELS.wallpaperGet)(event)).toEqual({
      ok: false,
      error: { code: 'storage-read-failed', message: '无法读取已保存的壁纸。' },
    })

    const choose = dependencies.wallpaper.choose as ReturnType<typeof vi.fn>
    choose.mockRejectedValueOnce(new Error(`EACCES C:\\Users\\secret\\${state.fileName}`))
    const failed = await handlerFor(IPC_CHANNELS.wallpaperChoose)(event)
    expect(failed).toEqual({
      ok: false,
      error: { code: 'internal', message: '操作未能完成，请稍后重试。' },
    })
    expect(JSON.stringify(failed)).not.toContain('secret')
  })

  it('validates and routes port-forward requests through the main-process service', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const event = trustedEvent(window)

    await expect(handlerFor(IPC_CHANNELS.portForwardsList)(event)).resolves.toEqual({
      ok: true,
      value: { revision: 1, items: [PORT_FORWARD_ITEM] },
    })

    await expect(
      handlerFor(IPC_CHANNELS.portForwardsCreate)(event, {
        type: 'local',
        name: 'web',
        connectionId: PROFILE.id,
        bindPort: 8080,
        targetHost: '127.0.0.1',
        targetPort: 80,
      }),
    ).resolves.toEqual({ ok: true, value: PORT_FORWARD_ITEM })
    expect(dependencies.portForwards.create).toHaveBeenCalledWith({
      type: 'local',
      name: 'web',
      connectionId: PROFILE.id,
      bindAddress: '127.0.0.1',
      bindPort: 8080,
      targetHost: '127.0.0.1',
      targetPort: 80,
    })

    expect(
      await handlerFor(IPC_CHANNELS.portForwardsCreate)(event, {
        type: 'dynamic',
        name: 'socks',
        connectionId: PROFILE.id,
        bindPort: 1080,
        bindAddress: '0.0.0.0',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(dependencies.portForwards.create).toHaveBeenCalledTimes(1)

    expect(
      await handlerFor(IPC_CHANNELS.portForwardsUpdate)(event, '../bad', {
        type: 'local',
        name: 'web',
        bindPort: 8080,
        targetHost: '127.0.0.1',
        targetPort: 80,
      }),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '端口转发规则未通过校验，请检查字段后重试。' },
    })
    expect(dependencies.portForwards.update).not.toHaveBeenCalled()

    await handlerFor(IPC_CHANNELS.portForwardsUpdate)(event, PORT_FORWARD_ITEM.rule.id, {
      type: 'local',
      name: 'web-2',
      bindPort: 8081,
      targetHost: '10.0.0.5',
      targetPort: 80,
    })
    expect(dependencies.portForwards.update).toHaveBeenCalledWith(PORT_FORWARD_ITEM.rule.id, {
      type: 'local',
      name: 'web-2',
      bindAddress: '127.0.0.1',
      bindPort: 8081,
      targetHost: '10.0.0.5',
      targetPort: 80,
    })

    await handlerFor(IPC_CHANNELS.portForwardsRemove)(event, PORT_FORWARD_ITEM.rule.id)
    expect(dependencies.portForwards.remove).toHaveBeenCalledWith(PORT_FORWARD_ITEM.rule.id)

    await handlerFor(IPC_CHANNELS.portForwardsStart)(event, {
      ruleId: PORT_FORWARD_ITEM.rule.id,
      sessionId: SNAPSHOT.sessionId,
    })
    expect(dependencies.portForwards.start).toHaveBeenCalledWith({
      ruleId: PORT_FORWARD_ITEM.rule.id,
      sessionId: SNAPSHOT.sessionId,
      confirmExposure: false,
    })

    await handlerFor(IPC_CHANNELS.portForwardsStop)(event, PORT_FORWARD_ITEM.rule.id)
    expect(dependencies.portForwards.stop).toHaveBeenCalledWith(PORT_FORWARD_ITEM.rule.id)

    await handlerFor(IPC_CHANNELS.portForwardsConnectionImpact)(event, PROFILE.id)
    expect(dependencies.portForwards.getConnectionRemovalImpact).toHaveBeenCalledWith(PROFILE.id)
  })

  it('requires explicit cascade confirmation before deleting a connection with rules', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const event = trustedEvent(window)
    const impact = dependencies.portForwards.getConnectionRemovalImpact as ReturnType<typeof vi.fn>
    impact.mockResolvedValue({
      connectionId: PROFILE.id,
      portForwardRuleCount: 2,
      runningPortForwardCount: 1,
    })

    expect(await handlerFor(IPC_CHANNELS.connectionsRemove)(event, PROFILE.id)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    })
    expect(dependencies.portForwards.removeForConnection).not.toHaveBeenCalled()
    expect(dependencies.connections.remove).not.toHaveBeenCalled()

    expect(
      await handlerFor(IPC_CHANNELS.connectionsRemove)(event, PROFILE.id, {
        cascadePortForwards: 'yes',
      }),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '删除连接的附加参数无效。' },
    })
    expect(dependencies.portForwards.removeForConnection).not.toHaveBeenCalled()

    const removeForConnection = dependencies.portForwards.removeForConnection as ReturnType<
      typeof vi.fn
    >
    removeForConnection.mockRejectedValueOnce(
      new AppOperationError('unavailable', '端口转发资源未能清理，已中止删除连接。'),
    )
    expect(
      await handlerFor(IPC_CHANNELS.connectionsRemove)(event, PROFILE.id, {
        cascadePortForwards: true,
      }),
    ).toEqual({
      ok: false,
      error: { code: 'unavailable', message: '端口转发资源未能清理，已中止删除连接。' },
    })
    expect(dependencies.connections.remove).not.toHaveBeenCalled()

    removeForConnection.mockResolvedValueOnce(['pf-web', 'pf-db'])
    await expect(
      handlerFor(IPC_CHANNELS.connectionsRemove)(event, PROFILE.id, {
        cascadePortForwards: true,
      }),
    ).resolves.toEqual({ ok: true, value: { id: PROFILE.id } })
    expect(removeForConnection).toHaveBeenCalledWith(PROFILE.id)
    expect(dependencies.connections.remove).toHaveBeenCalledWith(PROFILE.id)
  })

  it('removes saved credentials after a connection profile is deleted', async () => {
    const window = createWindow()
    const dependencies = register(window)

    await expect(
      handlerFor(IPC_CHANNELS.connectionsRemove)(trustedEvent(window), PROFILE.id),
    ).resolves.toEqual({ ok: true, value: { id: PROFILE.id } })
    expect(dependencies.credentials.remove).toHaveBeenCalledTimes(3)
    expect(dependencies.credentials.remove).toHaveBeenCalledWith(
      `termforge://connection/${PROFILE.id}/password`,
    )
    expect(dependencies.credentials.remove).toHaveBeenCalledWith(
      `termforge://connection/${PROFILE.id}/private-key`,
    )
    expect(dependencies.credentials.remove).toHaveBeenCalledWith(
      `termforge://connection/${PROFILE.id}/passphrase`,
    )
  })

  it('reports credential protection status without exposing secrets', async () => {
    const window = createWindow()
    const dependencies = register(window)

    await expect(handlerFor(IPC_CHANNELS.securityGetStatus)(trustedEvent(window))).resolves.toEqual(
      {
        credentialStorage: AVAILABLE_STATUS,
        hostKeyPolicy: 'explicit-trust-only',
      },
    )

    const status = dependencies.credentials.getStatus as ReturnType<typeof vi.fn>
    status.mockRejectedValueOnce(new Error('DPAPI secret dump'))
    await expect(handlerFor(IPC_CHANNELS.securityGetStatus)(trustedEvent(window))).resolves.toEqual(
      {
        credentialStorage: {
          available: false,
          protection: 'unavailable',
          message: '无法读取操作系统安全存储状态；凭据操作已禁用，不会使用明文替代。',
        },
        hostKeyPolicy: 'explicit-trust-only',
      },
    )
  })

  it('validates quick command payloads before routing and never accepts extra fields', async () => {
    const window = createWindow()
    const dependencies = register(window)
    const event = trustedEvent(window)
    const draft = {
      name: '查看服务状态',
      category: '服务诊断',
      description: '',
      body: 'systemctl status {{service}} --no-pager',
      parameters: [{ name: 'service', defaultValue: 'sshd' }],
    }
    const createdView = {
      ...draft,
      id: 'qc-1',
      source: 'custom' as const,
      favorite: false,
      editable: true,
      createdAt: '2026-10-23T08:00:00.000Z',
      updatedAt: '2026-10-23T08:00:00.000Z',
    }
    vi.mocked(dependencies.quickCommands.createCommand).mockResolvedValueOnce(createdView)

    await expect(handlerFor(IPC_CHANNELS.quickCommandsCreate)(event, draft)).resolves.toEqual({
      ok: true,
      value: createdView,
    })
    expect(dependencies.quickCommands.createCommand).toHaveBeenCalledWith(draft)

    expect(
      await handlerFor(IPC_CHANNELS.quickCommandsCreate)(event, {
        ...draft,
        body: 'echo {{service',
      }),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '快速命令未通过校验，请检查字段后重试。' },
    })
    expect(
      await handlerFor(IPC_CHANNELS.quickCommandsCreate)(event, { ...draft, secret: 'x' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(dependencies.quickCommands.createCommand).toHaveBeenCalledTimes(1)

    const executeInput = {
      kind: 'command' as const,
      requestId: 'req-12345678',
      commandId: 'builtin-uptime',
      parameterValues: {},
      tabId: SNAPSHOT.clientId,
      sessionId: SNAPSHOT.sessionId,
      recordHistory: false,
    }
    await expect(
      handlerFor(IPC_CHANNELS.quickCommandsExecute)(event, executeInput),
    ).resolves.toMatchObject({ ok: true, value: { requestId: executeInput.requestId } })
    expect(dependencies.quickCommands.execute).toHaveBeenCalledWith(executeInput)

    expect(
      await handlerFor(IPC_CHANNELS.quickCommandsExecute)(event, {
        ...executeInput,
        tabId: 'bad tab',
      }),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '快速命令发送参数未通过校验，未发送任何内容。' },
    })
    expect(await handlerFor(IPC_CHANNELS.commandHistoryRemove)(event, '../bad')).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    })

    await expect(handlerFor(IPC_CHANNELS.commandHistoryClear)(event)).resolves.toEqual({
      ok: true,
      value: { cleared: 0 },
    })
  })
})
