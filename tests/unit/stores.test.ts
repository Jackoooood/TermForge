import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import type {
  AppInfo,
  ConnectionCatalog,
  ConnectionGroup,
  ConnectionProfile,
  OperationResult,
  SecurityStatus,
  SessionInfo,
  SshConnectResult,
  SshSessionSnapshot,
  TermForgeBridge,
} from '@shared/types'
import { useAppStore } from '@renderer/stores/appStore'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { promptForCredentialIfNeeded, useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useSshPromptStore } from '@renderer/stores/sshPromptStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge, fakeSshSnapshot, fakeTransferTask } from './helpers/fakeBridge'

const APP_INFO: AppInfo = {
  appName: 'TermForge',
  appVersion: '0.1.0',
  platform: 'win32',
  electronVersion: '45.0.0',
  chromeVersion: '142.0.0.0',
  isPackaged: false,
}

const SECURITY_STATUS: SecurityStatus = {
  credentialStorage: {
    available: true,
    protection: 'windows-dpapi',
    message: '凭据将由 Windows DPAPI 保护。',
  },
  hostKeyPolicy: 'explicit-trust-only',
}

const GROUPS: ConnectionGroup[] = [
  { id: 'production', name: '生产环境', tone: 'production', sortOrder: 1 },
]

function profile(id: string, name = id, favorite = false): ConnectionProfile {
  return {
    id,
    name,
    host: '10.20.4.11',
    port: 22,
    username: 'deploy',
    authMethod: 'privateKey',
    groupId: 'production',
    tagIds: [],
    credentialRef: '~/.ssh/id_ed25519',
    jumpConnectionIds: [],
    favorite,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
  }
}

function createBridge(
  connections: Partial<TermForgeBridge['connections']> = {},
  ssh: Partial<TermForgeBridge['ssh']> = {},
): TermForgeBridge {
  return createFakeBridge(connections, ssh)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn
    reject = rejectFn
  })
  return { promise, resolve, reject }
}

function connectedResult(
  connectionId: string,
  clientId: string,
  sessionId: string,
): OperationResult<SshConnectResult> {
  return {
    ok: true,
    value: {
      session: fakeSshSnapshot({
        clientId,
        sessionId,
        connectionId,
        connectionName: 'prod',
        status: 'connected',
        connectedAt: '2026-10-22T08:00:01.000Z',
      }),
      reused: false,
    },
  }
}

async function openSession(connectionId = 'conn-1', name = 'prod'): Promise<string> {
  const tabId = await useSessionStore.getState().openSession({ id: connectionId, name })
  if (!tabId) throw new Error('openSession did not create a tab')
  return tabId
}

function fakeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sshtab-1',
    sessionId: 'ssh-1',
    connectionId: 'conn-1',
    connectionName: 'prod',
    host: '10.20.4.11',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    title: 'prod',
    status: 'error',
    generation: 1,
    hasTerminal: false,
    createdAt: '2026-10-22T08:00:00.000Z',
    connectedAt: null,
    hostKey: null,
    failure: null,
    jumps: [],
    activeHop: null,
    autoReconnect: null,
    ...overrides,
  }
}

function seedSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const session = fakeSessionInfo(overrides)
  useSessionStore.setState((state) => ({
    sessions: { ...state.sessions, [session.id]: session },
  }))
  useWorkspaceStore.getState().addTab(session.id)
  return session
}

function resetStores(): void {
  useSessionStore.getState().reset()
  useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
  useWorkspaceStore.setState({ tabOrder: [], activeTabId: null })
  useTerminalStore.getState().reset()
  useSshPromptStore.getState().reset()
  useTransferStore.getState().reset()
  useAppStore.setState({
    appInfo: null,
    bridgeStatus: 'idle',
    bridgeError: null,
    securityStatus: null,
    securityStatusError: null,
    toasts: [],
  })
  useSettingsStore.setState({
    autoReconnectEnabled: DEFAULT_APP_PREFERENCES.autoReconnectEnabled,
  })
  useConnectionStore.setState({
    connections: [],
    groups: [],
    tags: [],
    loadStatus: 'idle',
    loadError: null,
    persistenceError: null,
    searchQuery: '',
    collapsedGroupIds: [],
    editor: { open: false, mode: 'create', connectionId: null },
    deleteTargetId: null,
    deleteStatus: 'idle',
    deleteError: null,
    deleteImpact: null,
    deleteImpactStatus: 'idle',
    deleteImpactError: null,
    cascadePortForwards: false,
  })
}

describe('sessionStore', () => {
  beforeEach(resetStores)
  afterEach(() => {
    vi.useRealTimers()
    delete window.termforge
  })

  it('creates a stable tab, uses it as the IPC client ID and applies main snapshots', async () => {
    const connect = vi.fn(async (connectionId: string, clientId: string) => ({
      ok: true as const,
      value: {
        session: fakeSshSnapshot({
          clientId,
          sessionId: 'ssh-1',
          connectionId,
          connectionName: 'prod',
          status: 'connecting' as const,
          connectedAt: null,
        }),
        reused: false,
      },
    }))
    window.termforge = createBridge({}, { connect })

    const tabId = await openSession()
    expect(tabId).toMatch(/^sshtab-/)
    expect(connect).toHaveBeenCalledWith('conn-1', tabId)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      id: tabId,
      sessionId: 'ssh-1',
      status: 'connecting',
      generation: 1,
      hasTerminal: false,
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([tabId])
    expect(useWorkspaceStore.getState().activeTabId).toBe(tabId)

    const applied = useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-1',
        connectionId: 'conn-1',
        status: 'connected',
      }),
    )
    expect(applied?.status).toBe('connected')
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'connected',
      hasTerminal: true,
    })
  })

  it('dedupes rapid clicks while pending and allows a later independent session', async () => {
    const gate = deferred<OperationResult<SshConnectResult>>()
    let calls = 0
    const connect = vi.fn((connectionId: string, clientId: string) => {
      calls += 1
      if (calls === 1) return gate.promise
      return Promise.resolve(connectedResult(connectionId, clientId, 'ssh-second'))
    })
    window.termforge = createBridge({}, { connect })

    const first = useSessionStore.getState().openSession({ id: 'conn-1', name: 'prod' })
    const deduped = await useSessionStore.getState().openSession({ id: 'conn-1', name: 'prod' })
    expect(connect).toHaveBeenCalledTimes(1)

    const firstClientId = connect.mock.calls[0]?.[1] as string
    gate.resolve({
      ok: true,
      value: {
        session: fakeSshSnapshot({
          clientId: firstClientId,
          sessionId: 'ssh-first',
          connectionId: 'conn-1',
          connectionName: 'prod',
          status: 'connected',
        }),
        reused: false,
      },
    })
    const firstTabId = await first
    expect(deduped).toBe(firstTabId)
    expect(firstTabId).not.toBeNull()
    expect(useSessionStore.getState().sessions[firstTabId as string]?.sessionId).toBe('ssh-first')

    const secondTabId = await useSessionStore
      .getState()
      .openSession({ id: 'conn-1', name: 'prod' })
    expect(secondTabId).not.toBe(firstTabId)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls[1]?.[1]).not.toBe(firstClientId)
    expect(useSessionStore.getState().sessions[secondTabId as string]?.sessionId).toBe(
      'ssh-second',
    )
    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(2)
  })

  it('keeps a retryable tab when the main process rejects the connection', async () => {
    window.termforge = createBridge({}, {
      connect: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'not-found', message: '找不到该连接配置。' },
      }),
    })
    const tabId = await openSession()
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'error',
      sessionId: null,
      failure: { code: 'configuration-invalid' },
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([tabId])
    expect(useAppStore.getState().toasts.at(-1)?.description).toBe('找不到该连接配置。')

    window.termforge = createBridge({}, { connect: vi.fn().mockRejectedValue(new Error('boom')) })
    const secondId = await openSession()
    expect(useSessionStore.getState().sessions[secondId]?.status).toBe('error')
    expect(useAppStore.getState().toasts.at(-1)?.description).toMatch(/请稍后重试/)
  })

  it('warns without creating a tab when the preload bridge is unavailable', async () => {
    await expect(
      useSessionStore.getState().openSession({ id: 'conn-1', name: 'prod' }),
    ).resolves.toBeNull()
    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(0)
    expect(useWorkspaceStore.getState().tabOrder).toHaveLength(0)
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('SSH 连接不可用')
  })

  it('preserves the tab on passive disconnect and keeps retry state when reconnect fails', async () => {
    window.termforge = createBridge({}, {
      connect: vi.fn(async (_connectionId: string, clientId: string) =>
        connectedResult('conn-1', clientId, 'ssh-old'),
      ),
    })
    const tabId = await openSession()

    const applied = useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
        error: { code: 'remote-closed', message: '服务器关闭了连接。' },
      }),
    )
    expect(applied?.status).toBe('disconnected')
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      hasTerminal: true,
      sessionId: 'ssh-old',
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([tabId])

    window.termforge = createBridge({}, {
      disconnect: vi.fn().mockResolvedValue({
        ok: true,
        value: fakeSshSnapshot({
          clientId: tabId,
          sessionId: 'ssh-old',
          status: 'disconnected',
          connectedAt: null,
        }),
      }),
      connect: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'not-found', message: '连接已删除。' },
      }),
    })
    await useSessionStore.getState().reconnectSession(tabId)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'error',
      hasTerminal: false,
      sessionId: null,
      generation: 2,
    })
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('重新连接失败')
  })

  it('rebinds a new session to the same tab and ignores late events from the old session', async () => {
    let call = 0
    const connect = vi.fn(async (connectionId: string, clientId: string) => {
      call += 1
      return connectedResult(connectionId, clientId, call === 1 ? 'ssh-old' : 'ssh-new')
    })
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-other',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    window.termforge = createBridge({}, { connect, disconnect })
    const tabId = await openSession()
    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
      }),
    )

    const operation = useSessionStore.getState().reconnectSession(tabId)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'reconnecting',
      sessionId: null,
      generation: 2,
      hasTerminal: false,
    })
    await expect(operation).resolves.toBe(tabId)

    expect(disconnect).toHaveBeenCalledWith('ssh-old')
    expect(connect).toHaveBeenLastCalledWith('conn-1', tabId)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      id: tabId,
      sessionId: 'ssh-new',
      status: 'connected',
      generation: 2,
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([tabId])

    const late = useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'connected',
      }),
    )
    expect(late).toBeNull()
    expect(useSessionStore.getState().sessions[tabId]?.sessionId).toBe('ssh-new')
  })

  it('cancels an initial connect, keeps the tab and releases a late success', async () => {
    const gate = deferred<OperationResult<SshConnectResult>>()
    let tabId = ''
    const connect = vi.fn((_connectionId: string, clientId: string) => {
      tabId = clientId
      return gate.promise
    })
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-other',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    const cancelConnect = vi.fn(async (clientId: string) => ({
      ok: true as const,
      value: {
        cancelled: true,
        session: fakeSshSnapshot({
          clientId,
          sessionId: 'ssh-late',
          connectionId: 'conn-1',
          status: 'disconnected' as const,
          connectedAt: null,
          error: { code: 'cancelled' as const, message: '连接已取消。' },
        }),
      },
    }))
    window.termforge = createBridge({}, { connect, disconnect, cancelConnect })

    const opening = useSessionStore.getState().openSession({ id: 'conn-1', name: 'prod' })
    await vi.waitFor(() => expect(tabId).toMatch(/^sshtab-/))
    await useSessionStore.getState().cancelConnect(tabId)

    expect(cancelConnect).toHaveBeenCalledWith(tabId)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      hasTerminal: false,
      failure: { code: 'cancelled' },
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([tabId])

    gate.resolve(connectedResult('conn-1', tabId, 'ssh-late'))
    await expect(opening).resolves.toBe(tabId)
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith('ssh-late'))
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      hasTerminal: false,
      failure: { code: 'cancelled' },
    })
  })

  it('cancels a reconnect in flight and disconnects a late successful session', async () => {
    let call = 0
    const gate = deferred<OperationResult<SshConnectResult>>()
    const connect = vi.fn((connectionId: string, clientId: string) => {
      call += 1
      if (call === 1) return Promise.resolve(connectedResult(connectionId, clientId, 'ssh-old'))
      return gate.promise
    })
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-other',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    const cancelConnect = vi.fn(async (clientId: string) => ({
      ok: true as const,
      value: {
        cancelled: true,
        session: fakeSshSnapshot({
          clientId,
          sessionId: 'ssh-new',
          connectionId: 'conn-1',
          status: 'disconnected' as const,
          connectedAt: null,
          error: { code: 'cancelled' as const, message: '连接已取消。' },
        }),
      },
    }))
    window.termforge = createBridge({}, { connect, disconnect, cancelConnect })
    const tabId = await openSession()
    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
      }),
    )

    const reconnecting = useSessionStore.getState().reconnectSession(tabId)
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    await useSessionStore.getState().cancelConnect(tabId)

    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      hasTerminal: false,
      generation: 2,
      failure: { code: 'cancelled' },
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([tabId])

    gate.resolve(connectedResult('conn-1', tabId, 'ssh-new'))
    await expect(reconnecting).resolves.toBeNull()
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith('ssh-new'))
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      hasTerminal: false,
      failure: { code: 'cancelled' },
    })
  })

  it('does not start a replacement connect when the old session teardown is cancelled', async () => {
    const disconnectGate = deferred<OperationResult<SshSessionSnapshot>>()
    const connect = vi.fn((connectionId: string, clientId: string) =>
      Promise.resolve(connectedResult(connectionId, clientId, 'ssh-old')),
    )
    const disconnect = vi.fn((_sessionId: string) => disconnectGate.promise)
    const cancelConnect = vi.fn(async () => ({
      ok: true as const,
      value: { cancelled: false, session: null },
    }))
    window.termforge = createBridge({}, { connect, disconnect, cancelConnect })
    const tabId = await openSession()
    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
      }),
    )

    const reconnecting = useSessionStore.getState().reconnectSession(tabId)
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith('ssh-old'))
    await useSessionStore.getState().cancelConnect(tabId)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      failure: { code: 'cancelled' },
    })

    disconnectGate.resolve({
      ok: true,
      value: fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        status: 'disconnected',
        connectedAt: null,
      }),
    })
    await expect(reconnecting).resolves.toBeNull()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      failure: { code: 'cancelled' },
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([tabId])
  })

  it('ignores events from a cancelled attempt and disconnects a late connected snapshot', async () => {
    seedSession({ id: 'sshtab-cancel', sessionId: null, status: 'connecting' })
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-cancel',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    const cancelConnect = vi.fn(async (clientId: string) => ({
      ok: true as const,
      value: {
        cancelled: true,
        session: fakeSshSnapshot({
          clientId,
          sessionId: 'ssh-cancel',
          status: 'disconnected' as const,
          connectedAt: null,
          error: { code: 'cancelled' as const, message: '连接已取消。' },
        }),
      },
    }))
    window.termforge = createBridge({}, { disconnect, cancelConnect })

    await useSessionStore.getState().cancelConnect('sshtab-cancel')
    const applied = useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: 'sshtab-cancel',
        sessionId: 'ssh-cancel',
        connectionId: 'conn-1',
        status: 'connected',
      }),
    )
    expect(applied).toBeNull()
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith('ssh-cancel'))
    expect(useSessionStore.getState().sessions['sshtab-cancel']).toMatchObject({
      status: 'disconnected',
      hasTerminal: false,
      failure: { code: 'cancelled' },
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual(['sshtab-cancel'])
  })

  it('closes a tab while its reconnect is still connecting without leaking the new session', async () => {
    let call = 0
    const gate = deferred<OperationResult<SshConnectResult>>()
    const connect = vi.fn((connectionId: string, clientId: string) => {
      call += 1
      if (call === 1) return Promise.resolve(connectedResult(connectionId, clientId, 'ssh-old'))
      return gate.promise
    })
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-other',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    window.termforge = createBridge({}, { connect, disconnect })
    const tabId = await openSession()
    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
      }),
    )

    const reconnecting = useSessionStore.getState().reconnectSession(tabId)
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    const closing = useSessionStore.getState().closeSession(tabId)
    gate.resolve({
      ok: true,
      value: {
        session: fakeSshSnapshot({
          clientId: tabId,
          sessionId: 'ssh-new',
          connectionId: 'conn-1',
          status: 'connected',
        }),
        reused: false,
      },
    })
    await Promise.all([reconnecting, closing])

    expect(useSessionStore.getState().sessions[tabId]).toBeUndefined()
    expect(useWorkspaceStore.getState().tabOrder).toEqual([])
    expect(disconnect).toHaveBeenCalledWith('ssh-old')
    expect(disconnect).toHaveBeenCalledWith('ssh-new')
  })

  it('closes only the requested tab, keeps a neighbour active and is idempotent', async () => {
    window.termforge = createBridge({}, {
      connect: vi.fn(async (connectionId: string, clientId: string) =>
        connectedResult(connectionId, clientId, `ssh-${clientId}`),
      ),
    })
    const first = await openSession('conn-1', 'prod')
    const second = await openSession('conn-2', 'stage')
    useWorkspaceStore.getState().activateTab(first)

    const gate = deferred<OperationResult<SshSessionSnapshot>>()
    const disconnect = vi.fn(() => gate.promise)
    window.termforge = createBridge({}, { disconnect })

    const closeOne = useSessionStore.getState().closeSession(first)
    const closeTwo = useSessionStore.getState().closeSession(first)
    expect(useSessionStore.getState().sessions[first]?.status).toBe('closing')
    expect(useSessionStore.getState().sessions[first]?.hasTerminal).toBe(false)

    gate.resolve({
      ok: true,
      value: fakeSshSnapshot({
        clientId: first,
        sessionId: `ssh-${first}`,
        status: 'disconnected',
        connectedAt: null,
      }),
    })
    await Promise.all([closeOne, closeTwo])

    expect(useSessionStore.getState().sessions[first]).toBeUndefined()
    expect(useSessionStore.getState().sessions[second]?.status).toBe('connected')
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith(`ssh-${first}`)
    expect(useWorkspaceStore.getState().tabOrder).toEqual([second])
    expect(useWorkspaceStore.getState().activeTabId).toBe(second)
  })

  it('closes a connecting tab after the pending main connect resolves', async () => {
    const gate = deferred<OperationResult<SshConnectResult>>()
    const connect = vi.fn((_connectionId: string, _clientId: string) => gate.promise)
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-other',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    window.termforge = createBridge({}, { connect, disconnect })

    const opening = useSessionStore.getState().openSession({ id: 'conn-1', name: 'prod' })
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    const tabId = connect.mock.calls[0]?.[1] as string

    const closing = useSessionStore.getState().closeSession(tabId)
    gate.resolve({
      ok: true,
      value: {
        session: fakeSshSnapshot({
          clientId: tabId,
          sessionId: 'ssh-late',
          status: 'connected',
        }),
        reused: false,
      },
    })
    await Promise.all([opening, closing])

    expect(useSessionStore.getState().sessions[tabId]).toBeUndefined()
    expect(useWorkspaceStore.getState().tabOrder).toEqual([])
    expect(disconnect).toHaveBeenCalledWith('ssh-late')
  })

  it('keeps a tab with a retryable error when the main process fails to close it', async () => {
    window.termforge = createBridge({}, {
      connect: vi.fn(async (connectionId: string, clientId: string) =>
        connectedResult(connectionId, clientId, 'ssh-1'),
      ),
      disconnect: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'internal', message: '主进程关闭失败。' },
      }),
    })
    const tabId = await openSession()

    await useSessionStore.getState().closeSession(tabId)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'error',
      sessionId: 'ssh-1',
      hasTerminal: false,
      failure: { code: 'internal' },
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([tabId])
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('关闭会话失败')
  })

  it('ignores snapshots for unknown tabs and for other sessions of the same tab', async () => {
    window.termforge = createBridge({}, {
      connect: vi.fn(async (connectionId: string, clientId: string) =>
        connectedResult(connectionId, clientId, 'ssh-1'),
      ),
    })
    const tabId = await openSession()

    expect(
      useSessionStore.getState().applySshSnapshot(
        fakeSshSnapshot({ clientId: 'sshtab-unknown', sessionId: 'ssh-unknown' }),
      ),
    ).toBeNull()

    expect(
      useSessionStore.getState().applySshSnapshot(
        fakeSshSnapshot({ clientId: tabId, sessionId: 'ssh-other', connectionId: 'conn-1' }),
      ),
    ).toBeNull()
    expect(useSessionStore.getState().sessions[tabId]?.sessionId).toBe('ssh-1')
    expect(useSessionStore.getState().dismissedSessionIds).toContain('ssh-other')
  })

  it('applies the disconnect snapshot and reports failures', async () => {
    window.termforge = createBridge({}, {
      connect: vi.fn(async (connectionId: string, clientId: string) =>
        connectedResult(connectionId, clientId, 'ssh-1'),
      ),
    })
    const tabId = await openSession()

    window.termforge = createBridge({}, {
      disconnect: vi.fn(async (sessionId: string) => ({
        ok: true as const,
        value: fakeSshSnapshot({
          clientId: tabId,
          sessionId,
          status: 'disconnected' as const,
          connectedAt: null,
        }),
      })),
    })
    await useSessionStore.getState().requestDisconnect(tabId)
    expect(useSessionStore.getState().sessions[tabId]?.status).toBe('disconnected')
    expect(useSessionStore.getState().sessions[tabId]?.hasTerminal).toBe(true)

    window.termforge = createBridge({}, {
      disconnect: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'not-found', message: '找不到该 SSH 会话。' },
      }),
    })
    await useSessionStore.getState().requestDisconnect(tabId)
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('断开连接失败')
    expect(useAppStore.getState().toasts.at(-1)?.description).toBe('找不到该 SSH 会话。')
  })

  it('prunes sessions for connections removed on disk and closes deleted connections', async () => {
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-other',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    window.termforge = createBridge({}, {
      disconnect,
      connect: vi.fn(async (connectionId: string, clientId: string) =>
        connectedResult(connectionId, clientId, `ssh-${connectionId}`),
      ),
    })
    const prod = await openSession('conn-prod', 'prod')
    const stage = await openSession('conn-stage', 'stage')
    useWorkspaceStore.getState().activateTab(stage)

    useSessionStore.getState().retainConnections(['conn-stage'])
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[prod]).toBeUndefined())
    expect(disconnect).toHaveBeenCalledWith('ssh-conn-prod')
    expect(useWorkspaceStore.getState().tabOrder).toEqual([stage])

    await useSessionStore.getState().closeSessionsForConnection('conn-stage')
    expect(useSessionStore.getState().sessions).toEqual({})
    expect(useWorkspaceStore.getState().activeTabId).toBeNull()
    expect(disconnect).toHaveBeenCalledWith('ssh-conn-stage')
  })

  it('resets every tab, asks main to disconnect each session and clears prompts', async () => {
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-other',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    window.termforge = createBridge({}, {
      disconnect,
      connect: vi.fn(async (connectionId: string, clientId: string) =>
        connectedResult(connectionId, clientId, `ssh-${clientId}`),
      ),
    })
    const first = await openSession('conn-1', 'prod')
    const second = await openSession('conn-2', 'stage')
    useSshPromptStore.getState().openCredentialPrompt({
      tabId: first,
      sessionId: `ssh-${first}`,
      connectionId: 'conn-1',
      connectionName: 'prod',
      host: '10.20.4.11',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      kind: 'password',
      message: '需要密码',
    })

    useSessionStore.getState().reset()
    expect(useSessionStore.getState().sessions).toEqual({})
    expect(useWorkspaceStore.getState().tabOrder).toEqual([])
    expect(useWorkspaceStore.getState().activeTabId).toBeNull()
    expect(disconnect).toHaveBeenCalledWith(`ssh-${first}`)
    expect(disconnect).toHaveBeenCalledWith(`ssh-${second}`)
    expect(useSshPromptStore.getState().credentialPrompt).toBeNull()
  })

  it('syncs renamed connection profiles into existing tabs', async () => {
    window.termforge = createBridge({}, {
      connect: vi.fn(async (connectionId: string, clientId: string) =>
        connectedResult(connectionId, clientId, 'ssh-1'),
      ),
    })
    const tabId = await openSession()

    useSessionStore.getState().syncConnectionProfiles([{ id: 'conn-1', name: 'prod-renamed' }])
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      connectionName: 'prod-renamed',
      title: 'prod-renamed',
    })
  })

  it('opens a credential prompt only for actionable failures and carries the tab ID', () => {
    promptForCredentialIfNeeded(
      fakeSessionInfo({
        failure: { code: 'authentication-failed', message: '认证失败', credentialKind: 'password' },
      }),
    )
    expect(useSshPromptStore.getState().credentialPrompt).toMatchObject({
      tabId: 'sshtab-1',
      sessionId: 'ssh-1',
      kind: 'password',
    })

    useSshPromptStore.getState().closeCredentialPrompt()
    promptForCredentialIfNeeded(
      fakeSessionInfo({
        id: 'sshtab-2',
        sessionId: 'ssh-2',
        failure: { code: 'host-key-changed', message: '主机密钥已变化' },
      }),
    )
    expect(useSshPromptStore.getState().credentialPrompt).toBeNull()
  })

  it('schedules an automatic reconnect after a retryable disconnect and clears it on success', async () => {
    vi.useFakeTimers()
    useSettingsStore.setState({ autoReconnectEnabled: true })
    let call = 0
    const connect = vi.fn(async (connectionId: string, clientId: string) => {
      call += 1
      return connectedResult(connectionId, clientId, call === 1 ? 'ssh-old' : 'ssh-new')
    })
    window.termforge = createBridge({}, { connect })
    const tabId = await openSession()

    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
        error: { code: 'remote-closed', message: '服务器关闭了连接。' },
      }),
    )

    expect(useSessionStore.getState().sessions[tabId]?.autoReconnect).toMatchObject({
      attempt: 1,
      maxAttempts: 5,
      nextRetryAt: expect.any(String),
      exhausted: false,
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)

    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenLastCalledWith('conn-1', tabId)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'connected',
      sessionId: 'ssh-new',
      autoReconnect: null,
    })
  })

  it('stops after five automatic attempts and reports an exhausted state', async () => {
    vi.useFakeTimers()
    useSettingsStore.setState({ autoReconnectEnabled: true })
    let call = 0
    const connect = vi.fn(async (connectionId: string, clientId: string) => {
      call += 1
      if (call === 1) return connectedResult(connectionId, clientId, 'ssh-old')
      return {
        ok: true as const,
        value: {
          session: fakeSshSnapshot({
            clientId,
            sessionId: `ssh-fail-${call}`,
            connectionId: 'conn-1',
            connectionName: 'prod',
            status: 'error' as const,
            connectedAt: null,
            error: { code: 'network-error' as const, message: '网络中断。' },
          }),
          reused: false,
        },
      }
    })
    window.termforge = createBridge({}, { connect })
    const tabId = await openSession()

    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
        error: { code: 'remote-closed', message: '服务器关闭了连接。' },
      }),
    )

    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await vi.advanceTimersByTimeAsync(delay)
      await vi.advanceTimersByTimeAsync(0)
    }

    expect(connect).toHaveBeenCalledTimes(6)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'error',
      autoReconnect: {
        attempt: 5,
        maxAttempts: 5,
        nextRetryAt: null,
        exhausted: true,
      },
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenCalledTimes(6)
  })

  it('never retries failures outside the transport allowlist', async () => {
    vi.useFakeTimers()
    useSettingsStore.setState({ autoReconnectEnabled: true })
    const connect = vi.fn(async (connectionId: string, clientId: string) =>
      connectedResult(connectionId, clientId, 'ssh-old'),
    )
    window.termforge = createBridge({}, { connect })
    const tabId = await openSession()

    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'error',
        connectedAt: null,
        error: {
          code: 'authentication-failed',
          message: '认证失败。',
          credentialKind: 'password',
        },
      }),
    )

    expect(useSessionStore.getState().sessions[tabId]?.autoReconnect).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('stops pending automatic retries when the preference is disabled or the user disconnects', async () => {
    vi.useFakeTimers()
    useSettingsStore.setState({ autoReconnectEnabled: true })
    const connect = vi.fn(async (connectionId: string, clientId: string) =>
      connectedResult(connectionId, clientId, 'ssh-old'),
    )
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-other',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    window.termforge = createBridge({}, { connect, disconnect })
    const tabId = await openSession()

    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
        error: { code: 'network-error', message: '网络中断。' },
      }),
    )
    expect(useSessionStore.getState().sessions[tabId]?.autoReconnect?.attempt).toBe(1)

    useSettingsStore.setState({ autoReconnectEnabled: false })
    expect(useSessionStore.getState().sessions[tabId]?.autoReconnect).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenCalledTimes(1)

    useSettingsStore.setState({ autoReconnectEnabled: true })
    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
        error: { code: 'network-error', message: '网络中断。' },
      }),
    )
    expect(useSessionStore.getState().sessions[tabId]?.autoReconnect?.attempt).toBe(1)

    await useSessionStore.getState().requestDisconnect(tabId)
    expect(useSessionStore.getState().sessions[tabId]?.autoReconnect).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('cancels a waiting automatic retry without closing the tab', async () => {
    vi.useFakeTimers()
    useSettingsStore.setState({ autoReconnectEnabled: true })
    const connect = vi.fn(async (connectionId: string, clientId: string) =>
      connectedResult(connectionId, clientId, 'ssh-old'),
    )
    window.termforge = createBridge({}, { connect })
    const tabId = await openSession()

    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
        error: { code: 'network-error', message: '网络中断。' },
      }),
    )
    expect(useSessionStore.getState().sessions[tabId]?.autoReconnect?.attempt).toBe(1)

    await useSessionStore.getState().cancelAutoReconnect(tabId)

    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      autoReconnect: null,
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([tabId])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('cancels an in-flight automatic retry and releases a late success', async () => {
    vi.useFakeTimers()
    useSettingsStore.setState({ autoReconnectEnabled: true })
    const gate = deferred<OperationResult<SshConnectResult>>()
    let call = 0
    const connect = vi.fn((connectionId: string, clientId: string) => {
      call += 1
      if (call === 1) return Promise.resolve(connectedResult(connectionId, clientId, 'ssh-old'))
      return gate.promise
    })
    const disconnect = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: fakeSshSnapshot({
        clientId: 'sshtab-other',
        sessionId,
        status: 'disconnected' as const,
        connectedAt: null,
      }),
    }))
    const cancelConnect = vi.fn(async (clientId: string) => ({
      ok: true as const,
      value: {
        cancelled: true,
        session: fakeSshSnapshot({
          clientId,
          sessionId: 'ssh-new',
          connectionId: 'conn-1',
          status: 'disconnected' as const,
          connectedAt: null,
          error: { code: 'cancelled' as const, message: '连接已取消。' },
        }),
      },
    }))
    window.termforge = createBridge({}, { connect, disconnect, cancelConnect })
    const tabId = await openSession()

    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: tabId,
        sessionId: 'ssh-old',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
        error: { code: 'network-error', message: '网络中断。' },
      }),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'reconnecting',
      autoReconnect: { attempt: 1, nextRetryAt: null, exhausted: false },
    })

    await useSessionStore.getState().cancelAutoReconnect(tabId)

    expect(cancelConnect).toHaveBeenCalledWith(tabId)
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      autoReconnect: null,
      failure: { code: 'cancelled' },
    })

    gate.resolve(connectedResult('conn-1', tabId, 'ssh-new'))
    await vi.advanceTimersByTimeAsync(0)
    expect(disconnect).toHaveBeenCalledWith('ssh-new')
    expect(useSessionStore.getState().sessions[tabId]).toMatchObject({
      status: 'disconnected',
      failure: { code: 'cancelled' },
    })
  })

  it('retries only the failed pane and leaves the neighbour session untouched', async () => {
    vi.useFakeTimers()
    useSettingsStore.setState({ autoReconnectEnabled: true })
    let call = 0
    const connect = vi.fn(async (connectionId: string, clientId: string) => {
      call += 1
      return connectedResult(connectionId, clientId, call === 3 ? 'ssh-a-new' : `ssh-${call}`)
    })
    window.termforge = createBridge({}, { connect })
    const first = await openSession('conn-1', 'prod')
    const second = await openSession('conn-2', 'stage')

    useSessionStore.getState().applySshSnapshot(
      fakeSshSnapshot({
        clientId: first,
        sessionId: 'ssh-1',
        connectionId: 'conn-1',
        status: 'disconnected',
        connectedAt: null,
        error: { code: 'network-error', message: '网络中断。' },
      }),
    )

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(connect).toHaveBeenCalledTimes(3)
    expect(connect).toHaveBeenLastCalledWith('conn-1', first)
    expect(useSessionStore.getState().sessions[first]).toMatchObject({
      status: 'connected',
      sessionId: 'ssh-a-new',
    })
    expect(useSessionStore.getState().sessions[second]).toMatchObject({
      status: 'connected',
      sessionId: 'ssh-2',
    })
  })
})

describe('sshPromptStore', () => {
  beforeEach(resetStores)
  afterEach(() => {
    delete window.termforge
  })

  const challenge = {
    requestId: 'req-1',
    sessionId: 'ssh-1',
    connectionId: 'conn-1',
    connectionName: 'prod',
    host: '10.20.4.11',
    port: 22,
    algorithm: 'ssh-ed25519' as const,
    fingerprint: 'SHA256:abc',
    expiresAt: '2026-10-22T08:00:30.000Z',
  }

  it('queues host-key challenges once and submits an explicit decision', async () => {
    const respondToHostKey = vi.fn().mockResolvedValue({
      ok: true,
      value: { requestId: 'req-1', accepted: true },
    })
    window.termforge = createBridge({}, { respondToHostKey })

    useSshPromptStore.getState().enqueueHostKey(challenge)
    useSshPromptStore.getState().enqueueHostKey(challenge)
    expect(useSshPromptStore.getState().hostKeyQueue).toHaveLength(1)

    await useSshPromptStore.getState().resolveHostKey('req-1', true)
    expect(respondToHostKey).toHaveBeenCalledWith('req-1', true)
    expect(useSshPromptStore.getState().hostKeyQueue).toHaveLength(0)
  })

  it('drops expired or rejected challenges instead of keeping a stale prompt', async () => {
    window.termforge = createBridge({}, {
      respondToHostKey: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'not-found', message: '该主机密钥确认已过期。' },
      }),
    })
    useSshPromptStore.getState().enqueueHostKey(challenge)
    await useSshPromptStore.getState().resolveHostKey('req-1', true)
    expect(useSshPromptStore.getState().hostKeyQueue).toHaveLength(0)
    expect(useSshPromptStore.getState().hostKeyError).toBe('该主机密钥确认已过期。')
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('主机密钥未保存')
  })

  it('clears host-key and credential prompts for a session', () => {
    useSshPromptStore.getState().enqueueHostKey(challenge)
    useSshPromptStore.getState().openCredentialPrompt({
      tabId: 'sshtab-1',
      sessionId: 'ssh-1',
      connectionId: 'conn-1',
      connectionName: 'prod',
      host: '10.20.4.11',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      kind: 'password',
      message: '需要密码',
    })

    useSshPromptStore.getState().clearHostKeysForSession('ssh-1')
    expect(useSshPromptStore.getState().hostKeyQueue).toHaveLength(0)
    expect(useSshPromptStore.getState().credentialPrompt?.sessionId).toBe('ssh-1')

    useSshPromptStore.getState().clearCredentialForSession('ssh-1')
    expect(useSshPromptStore.getState().credentialPrompt).toBeNull()
  })
})

describe('transferStore', () => {
  beforeEach(resetStores)
  afterEach(() => {
    delete window.termforge
  })

  it('syncs main-process snapshots and discards stale revisions', async () => {
    const initial = fakeTransferTask()
    window.termforge = createFakeBridge({}, {}, {}, {}, {
      list: async () => ({ ok: true, value: [initial] }),
    })

    await useTransferStore.getState().sync()
    expect(useTransferStore.getState().tasks).toEqual([initial])
    expect(useTransferStore.getState().syncing).toBe(false)
    expect(useTransferStore.getState().syncError).toBeNull()

    const newest = fakeTransferTask({
      status: 'transferring',
      transferredBytes: 512,
      progress: 50,
      revision: 3,
    })
    const stale = fakeTransferTask({ status: 'queued', revision: 2 })
    useTransferStore.getState().applyTask(newest)
    useTransferStore.getState().applyTask(stale)

    expect(useTransferStore.getState().tasks[0]).toMatchObject({
      status: 'transferring',
      transferredBytes: 512,
      revision: 3,
    })
  })

  it('surfaces a conflict task by opening the transfer panel', () => {
    const task = fakeTransferTask({
      status: 'waitingForConflictResolution',
      revision: 2,
      conflict: {
        targetPath: '/home/deploy/notes.txt',
        suggestedName: 'notes (1).txt',
        suggestedPath: '/home/deploy/notes (1).txt',
      },
    })
    useTransferStore.getState().applyTask(task)
    expect(useTransferStore.getState().panelOpen).toBe(true)
    expect(useTransferStore.getState().tasks[0]?.conflict?.suggestedName).toBe('notes (1).txt')
  })

  it('merges tasks returned by enqueue and reports bridge failures', async () => {
    const created = [
      fakeTransferTask({ id: 'transfer-a' }),
      fakeTransferTask({ id: 'transfer-b', fileName: 'b.txt', revision: 1 }),
    ]
    const enqueueUpload = vi.fn().mockResolvedValue({ ok: true, value: created })
    const enqueueDownload = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'unavailable', message: '会话已断开。' } })
    window.termforge = createFakeBridge({}, {}, {}, {}, { enqueueUpload, enqueueDownload })

    const upload = await useTransferStore.getState().enqueueUpload('ssh-test-session', '/srv/app')
    expect(upload).toEqual({ ok: true, value: created })
    expect(enqueueUpload).toHaveBeenCalledWith('ssh-test-session', '/srv/app')
    expect(useTransferStore.getState().tasks).toHaveLength(2)
    expect(useTransferStore.getState().panelOpen).toBe(true)

    const download = await useTransferStore
      .getState()
      .enqueueDownload('ssh-test-session', ['/srv/app/a.txt'])
    expect(download).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(useTransferStore.getState().tasks).toHaveLength(2)

    delete window.termforge
    const unavailable = await useTransferStore
      .getState()
      .enqueueUpload('ssh-test-session', '/srv/app')
    expect(unavailable).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('applies cancel, retry, conflict and clear-history responses', async () => {
    const active = fakeTransferTask({ id: 'transfer-active' })
    const finished = fakeTransferTask({
      id: 'transfer-done',
      status: 'completed',
      progress: 100,
      completedAt: '2026-10-22T08:01:00.000Z',
    })
    useTransferStore.setState({ tasks: [active, finished] })

    const cancel = vi.fn().mockResolvedValue({
      ok: true,
      value: fakeTransferTask({ id: 'transfer-active', status: 'cancelling', revision: 2 }),
    })
    const retry = vi.fn().mockResolvedValue({
      ok: true,
      value: fakeTransferTask({ id: 'transfer-active', attempt: 2, revision: 3 }),
    })
    const resolveConflict = vi.fn().mockResolvedValue({
      ok: true,
      value: fakeTransferTask({ id: 'transfer-active', revision: 4, conflictPolicy: 'rename' }),
    })
    const clearHistory = vi.fn().mockResolvedValue({ ok: true, value: { cleared: 1 } })
    window.termforge = createFakeBridge({}, {}, {}, {}, {
      cancel,
      retry,
      resolveConflict,
      clearHistory,
    })

    await useTransferStore.getState().cancelTask('transfer-active')
    expect(cancel).toHaveBeenCalledWith('transfer-active')
    expect(useTransferStore.getState().tasks[0]?.status).toBe('cancelling')

    const retried = await useTransferStore.getState().retryTask('transfer-active')
    expect(retried.ok).toBe(true)
    expect(useTransferStore.getState().tasks[0]).toMatchObject({ status: 'queued', attempt: 2 })

    await useTransferStore
      .getState()
      .resolveTaskConflict('transfer-active', 'rename', 'renamed.txt')
    expect(resolveConflict).toHaveBeenCalledWith('transfer-active', 'rename', 'renamed.txt')
    expect(useTransferStore.getState().tasks[0]?.conflictPolicy).toBe('rename')

    await useTransferStore.getState().clearHistory()
    expect(useTransferStore.getState().tasks.map((task) => task.id)).toEqual(['transfer-active'])
  })

  it('toggles the queue panel and clears only local projection state on reset', () => {
    const store = useTransferStore.getState()
    store.togglePanel()
    expect(useTransferStore.getState().panelOpen).toBe(true)
    useTransferStore.getState().setPanelOpen(false)
    expect(useTransferStore.getState().panelOpen).toBe(false)

    useTransferStore.setState({ tasks: [fakeTransferTask()], syncError: 'stale' })
    useTransferStore.getState().reset()
    expect(useTransferStore.getState().tasks).toHaveLength(0)
    expect(useTransferStore.getState().syncError).toBeNull()
  })
})

describe('appStore', () => {
  beforeEach(resetStores)
  afterEach(() => {
    delete window.termforge
  })

  it('loads read-only app info and security status through the bridge', async () => {
    window.termforge = createBridge()
    await useAppStore.getState().loadAppInfo()
    expect(useAppStore.getState().bridgeStatus).toBe('ready')
    expect(useAppStore.getState().appInfo).toEqual(APP_INFO)

    await useAppStore.getState().loadSecurityStatus()
    expect(useAppStore.getState().securityStatus).toEqual(SECURITY_STATUS)
    expect(useAppStore.getState().securityStatusError).toBeNull()

    delete window.termforge
    useAppStore.setState({ appInfo: null, bridgeStatus: 'idle', bridgeError: null })
    await useAppStore.getState().loadAppInfo()
    expect(useAppStore.getState().bridgeStatus).toBe('unavailable')
    expect(useAppStore.getState().bridgeError).toMatch(/preload bridge/)

    await useAppStore.getState().loadSecurityStatus()
    expect(useAppStore.getState().securityStatus).toBeNull()
    expect(useAppStore.getState().securityStatusError).toMatch(/preload bridge/)
  })

  it('adds and dismisses local toasts', () => {
    const store = useAppStore.getState()
    store.pushToast({ tone: 'info', title: 'one' })
    store.pushToast({ tone: 'success', title: 'two' })
    expect(useAppStore.getState().toasts).toHaveLength(2)

    const firstId = useAppStore.getState().toasts[0]?.id
    expect(firstId).toBeDefined()
    useAppStore.getState().dismissToast(firstId as number)
    expect(useAppStore.getState().toasts).toHaveLength(1)
    expect(useAppStore.getState().toasts[0]?.title).toBe('two')
  })
})

describe('connectionStore', () => {
  beforeEach(resetStores)
  afterEach(() => {
    delete window.termforge
  })

  it('loads the persisted catalog and prunes sessions of removed connections', async () => {
    const catalog: ConnectionCatalog = {
      tags: [],
      connections: [profile('conn-prod-web-01'), profile('conn-new-01')],
      groups: GROUPS,
    }
    window.termforge = createBridge({
      list: vi.fn().mockResolvedValue({ ok: true, value: catalog }),
    })
    seedSession({
      id: 'sshtab-prod-web',
      sessionId: 'ssh-prod-web',
      connectionId: 'conn-prod-web-01',
      connectionName: 'prod-web-01',
    })

    await useConnectionStore.getState().loadConnections()
    expect(useConnectionStore.getState().loadStatus).toBe('ready')
    expect(useConnectionStore.getState().connections).toHaveLength(2)
    expect(
      Object.values(useSessionStore.getState().sessions).map((session) => session.id),
    ).toEqual(['sshtab-prod-web'])
  })

  it('surfaces local storage failures instead of falling back to fixtures', async () => {
    window.termforge = createBridge({
      list: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'storage-corrupt', message: '本地连接配置损坏或版本不受支持。' },
      }),
    })

    await useConnectionStore.getState().loadConnections()
    expect(useConnectionStore.getState().loadStatus).toBe('error')
    expect(useConnectionStore.getState().connections).toHaveLength(0)
    expect(useConnectionStore.getState().persistenceError).toMatch(/损坏/)
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('连接列表加载失败')
  })

  it('rolls back optimistic favorites when persistence fails', async () => {
    window.termforge = createBridge({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: { tags: [], connections: [profile('conn-1')], groups: GROUPS },
      }),
      setFavorite: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'storage-write-failed', message: '无法写入本地配置。' },
      }),
    })

    await useConnectionStore.getState().loadConnections()
    await useConnectionStore.getState().toggleFavorite('conn-1')
    expect(useConnectionStore.getState().connections[0]?.favorite).toBe(false)
    expect(useConnectionStore.getState().persistenceError).toBe('无法写入本地配置。')
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('收藏状态未保存')

    useConnectionStore.getState().clearPersistenceError()
    expect(useConnectionStore.getState().persistenceError).toBeNull()
  })

  it('reports create failures and keeps the previous list', async () => {
    window.termforge = createBridge({
      create: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'storage-write-failed', message: '磁盘写入失败。' },
      }),
    })

    await expect(
      useConnectionStore.getState().createConnection({
        name: 'new-node',
        host: '10.0.0.8',
        port: 22,
        username: 'deploy',
        authMethod: 'sshAgent',
        groupId: 'production',
        tagIds: [],
        jumpConnectionIds: [],
      }),
    ).rejects.toThrow(/磁盘写入失败/)
    expect(useConnectionStore.getState().connections).toHaveLength(0)
    expect(useConnectionStore.getState().persistenceError).toBe('磁盘写入失败。')
  })

  it('deletes a persisted connection, closes its sessions and its editor', async () => {
    window.termforge = createBridge({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: { tags: [], connections: [profile('conn-1'), profile('conn-2')], groups: GROUPS },
      }),
      remove: vi.fn().mockResolvedValue({ ok: true, value: { id: 'conn-1' } }),
    })

    await useConnectionStore.getState().loadConnections()
    seedSession({ id: 'sshtab-conn-1', sessionId: 'ssh-conn-1', connectionId: 'conn-1' })
    seedSession({ id: 'sshtab-conn-2', sessionId: 'ssh-conn-2', connectionId: 'conn-2' })
    useConnectionStore.getState().openEditEditor('conn-1')

    useConnectionStore.getState().requestDelete('conn-1')
    expect(useConnectionStore.getState().deleteTargetId).toBe('conn-1')
    await useConnectionStore.getState().loadDeleteImpact()
    await expect(useConnectionStore.getState().confirmDelete()).resolves.toBe(true)

    const state = useConnectionStore.getState()
    expect(state.connections.map((connection) => connection.id)).toEqual(['conn-2'])
    expect(state.editor.open).toBe(false)
    expect(state.deleteTargetId).toBeNull()
    expect(useSessionStore.getState().sessions['sshtab-conn-1']).toBeUndefined()
    expect(Object.keys(useSessionStore.getState().sessions)).toEqual(['sshtab-conn-2'])
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('连接已删除')
  })

  it('keeps the delete dialog open with a safe error when deletion fails', async () => {
    window.termforge = createBridge({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: { tags: [], connections: [profile('conn-1')], groups: GROUPS },
      }),
      remove: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'storage-write-failed', message: '无法写入本地配置。' },
      }),
    })

    await useConnectionStore.getState().loadConnections()
    useConnectionStore.getState().requestDelete('conn-1')
    await useConnectionStore.getState().loadDeleteImpact()
    await expect(useConnectionStore.getState().confirmDelete()).resolves.toBe(false)

    const state = useConnectionStore.getState()
    expect(state.connections).toHaveLength(1)
    expect(state.deleteTargetId).toBe('conn-1')
    expect(state.deleteError).toBe('无法写入本地配置。')
  })
})
