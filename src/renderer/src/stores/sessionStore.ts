import { create } from 'zustand'
import type {
  ConnectionProfile,
  OperationError,
  SessionAutoReconnect,
  SessionInfo,
  SshFailure,
  SshSessionSnapshot,
} from '@shared/types'
import {
  bindTerminalTab,
  clearTerminalTab,
  forgetTerminalTab,
  resetTerminalSessions,
  unbindTerminalTab,
} from '@renderer/services/terminalRuntime'
import { useAppStore } from './appStore'
import { useLocalPanelStore } from './localPanelStore'
import { useSettingsStore } from './settingsStore'
import { useSftpStore } from './sftpStore'
import { useSshPromptStore } from './sshPromptStore'
import { useWorkspaceStore } from './workspaceStore'

type SessionConnection = Pick<ConnectionProfile, 'id' | 'name'>

const LIVE_STATUSES: ReadonlySet<SessionInfo['status']> = new Set([
  'connecting',
  'authenticating',
  'awaiting-host-key',
  'connected',
  'reconnecting',
])

const PENDING_STATUSES: ReadonlySet<SessionInfo['status']> = new Set([
  'connecting',
  'authenticating',
  'awaiting-host-key',
])

const CREDENTIAL_PROMPT_CODES: ReadonlySet<SshFailure['code']> = new Set([
  'credential-required',
  'credential-invalid',
  'authentication-failed',
])

const CANCELLABLE_STATUSES: ReadonlySet<SessionInfo['status']> = new Set([
  'connecting',
  'authenticating',
  'awaiting-host-key',
  'reconnecting',
])

const CLOSE_WAIT_MS = 5_000
const MAX_DISMISSED_IDS = 200

const MAX_AUTO_RECONNECT_ATTEMPTS = 5
const AUTO_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const

/**
 * Automatic retry is restricted to transport-level failures. Authentication,
 * host-key, credential and internal failures must be resolved by the user and
 * are never retried, regardless of their message text.
 */
const RETRYABLE_FAILURE_CODES: ReadonlySet<SshFailure['code']> = new Set([
  'network-error',
  'connection-timeout',
  'dns-failed',
  'connection-refused',
  'remote-closed',
])

const pendingConnects = new Map<string, Promise<{ sessionId: string | null; reused: boolean }>>()
const closePromises = new Map<string, Promise<void>>()
const reconnectPromises = new Map<string, Promise<string | null>>()
const disconnectPromises = new Map<string, Promise<void>>()
const cancelPromises = new Map<string, Promise<void>>()
const closingTabs = new Set<string>()

/**
 * Tabs the user explicitly disconnected. Late transport failures must not
 * schedule automatic retries while the tab stays closed; any new reconnect
 * attempt clears the suppression.
 */
const autoReconnectSuppressedTabs = new Set<string>()

/**
 * Each user-initiated attempt owns an epoch. Cancelling advances the epoch so
 * every in-flight continuation for the old attempt can detect that its result
 * is stale and release a late main-process session instead of binding it.
 */
const attemptEpochs = new Map<string, number>()
const cancelledTabs = new Set<string>()

/** Pending automatic retry timers; never persisted and cleared with the tab. */
const autoReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

function beginAttempt(tabId: string): number {
  const epoch = (attemptEpochs.get(tabId) ?? 0) + 1
  attemptEpochs.set(tabId, epoch)
  cancelledTabs.delete(tabId)
  return epoch
}

function cancelAttempt(tabId: string): number {
  const epoch = (attemptEpochs.get(tabId) ?? 0) + 1
  attemptEpochs.set(tabId, epoch)
  cancelledTabs.add(tabId)
  return epoch
}

function isAttemptCurrent(tabId: string, epoch: number): boolean {
  return attemptEpochs.get(tabId) === epoch && !cancelledTabs.has(tabId)
}

function isCancelledAttempt(tabId: string, epoch: number): boolean {
  return attemptEpochs.get(tabId) === epoch && cancelledTabs.has(tabId)
}

function forgetAttempt(tabId: string): void {
  attemptEpochs.delete(tabId)
  cancelledTabs.delete(tabId)
}

function cancelledFailure(): SshFailure {
  return { code: 'cancelled', message: '连接已取消。' }
}

function isRetryableFailure(failure: SshFailure | null): boolean {
  return failure !== null && RETRYABLE_FAILURE_CODES.has(failure.code)
}

function clearAutoReconnectTimer(tabId: string): void {
  const timer = autoReconnectTimers.get(tabId)
  if (timer === undefined) return
  clearTimeout(timer)
  autoReconnectTimers.delete(tabId)
}

function updateAutoReconnect(tabId: string, autoReconnect: SessionAutoReconnect | null): void {
  useSessionStore.setState((state) => {
    const tab = state.sessions[tabId]
    if (!tab || closingTabs.has(tabId)) return state
    if (tab.autoReconnect === null && autoReconnect === null) return state
    return {
      sessions: { ...state.sessions, [tabId]: { ...tab, autoReconnect } },
    }
  })
}

function stopAutoReconnect(tabId: string): void {
  clearAutoReconnectTimer(tabId)
  updateAutoReconnect(tabId, null)
}

function stopAllAutoReconnect(): void {
  for (const tabId of [...autoReconnectTimers.keys()]) clearAutoReconnectTimer(tabId)
  useSessionStore.setState((state) => {
    let changed = false
    const sessions: Record<string, SessionInfo> = { ...state.sessions }
    for (const [tabId, tab] of Object.entries(state.sessions)) {
      if (tab.autoReconnect) {
        sessions[tabId] = { ...tab, autoReconnect: null }
        changed = true
      }
    }
    return changed ? { sessions } : state
  })
}

/**
 * Bounds the retry sequence at five attempts with 1/2/4/8/15s backoff. A
 * duplicate failure snapshot while a retry is already scheduled is ignored so
 * the same failure cannot consume two attempts.
 */
function scheduleAutoReconnect(tabId: string, failure: SshFailure): void {
  const tab = useSessionStore.getState().sessions[tabId]
  if (
    !tab ||
    closingTabs.has(tabId) ||
    cancelledTabs.has(tabId) ||
    autoReconnectSuppressedTabs.has(tabId)
  ) {
    stopAutoReconnect(tabId)
    return
  }
  if (!useSettingsStore.getState().autoReconnectEnabled || !isRetryableFailure(failure)) {
    stopAutoReconnect(tabId)
    return
  }

  const previous = tab.autoReconnect
  if (previous?.exhausted || autoReconnectTimers.has(tabId)) return

  const attempt = (previous?.attempt ?? 0) + 1
  if (attempt > MAX_AUTO_RECONNECT_ATTEMPTS) {
    updateAutoReconnect(tabId, {
      attempt: MAX_AUTO_RECONNECT_ATTEMPTS,
      maxAttempts: MAX_AUTO_RECONNECT_ATTEMPTS,
      nextRetryAt: null,
      exhausted: true,
    })
    return
  }

  const delay = AUTO_RECONNECT_DELAYS_MS[attempt - 1] ?? AUTO_RECONNECT_DELAYS_MS[4]
  const nextRetryAt = new Date(Date.now() + delay).toISOString()
  updateAutoReconnect(tabId, {
    attempt,
    maxAttempts: MAX_AUTO_RECONNECT_ATTEMPTS,
    nextRetryAt,
    exhausted: false,
  })

  const timer = setTimeout(() => {
    if (autoReconnectTimers.get(tabId) === timer) autoReconnectTimers.delete(tabId)
    void runAutoReconnect(tabId, attempt)
  }, delay)
  autoReconnectTimers.set(tabId, timer)
}

async function runAutoReconnect(tabId: string, attempt: number): Promise<void> {
  const tab = useSessionStore.getState().sessions[tabId]
  if (!tab || closingTabs.has(tabId) || cancelledTabs.has(tabId)) {
    stopAutoReconnect(tabId)
    return
  }
  const progress = tab.autoReconnect
  if (
    !useSettingsStore.getState().autoReconnectEnabled ||
    !progress ||
    progress.attempt !== attempt ||
    progress.exhausted
  ) {
    stopAutoReconnect(tabId)
    return
  }
  if (
    (tab.status !== 'error' && tab.status !== 'disconnected') ||
    !isRetryableFailure(tab.failure)
  ) {
    stopAutoReconnect(tabId)
    return
  }

  updateAutoReconnect(tabId, { ...progress, nextRetryAt: null })
  await startReconnectAttempt(tabId, true)
}

interface SessionStoreState {
  sessions: Record<string, SessionInfo>
  dismissedSessionIds: string[]
  openSession: (connection: SessionConnection) => Promise<string | null>
  reconnectSession: (tabId: string) => Promise<string | null>
  cancelConnect: (tabId: string) => Promise<void>
  cancelAutoReconnect: (tabId: string) => Promise<void>
  applySshSnapshot: (snapshot: SshSessionSnapshot) => SessionInfo | null
  requestDisconnect: (tabId: string) => Promise<void>
  closeSession: (tabId: string) => Promise<void>
  closeSessionsForConnection: (connectionId: string) => Promise<void>
  retainConnections: (connectionIds: Iterable<string>) => void
  syncConnectionProfiles: (connections: Array<Pick<ConnectionProfile, 'id' | 'name'>>) => void
  reset: () => void
}

function createTabId(): string {
  const cryptoApi = globalThis.crypto
  const uuid =
    cryptoApi && typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `sshtab-${uuid}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function newTab(connection: SessionConnection, tabId: string): SessionInfo {
  return {
    id: tabId,
    sessionId: null,
    connectionId: connection.id,
    connectionName: connection.name,
    host: '',
    port: 22,
    username: '',
    authMethod: 'password',
    title: connection.name,
    status: 'connecting',
    jumps: [],
    activeHop: null,
    generation: 1,
    hasTerminal: false,
    createdAt: nowIso(),
    connectedAt: null,
    hostKey: null,
    failure: null,
    autoReconnect: null,
  }
}

function applySnapshotToTab(tab: SessionInfo, snapshot: SshSessionSnapshot): SessionInfo {
  return {
    ...tab,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    connectionName: snapshot.connectionName,
    host: snapshot.host,
    port: snapshot.port,
    username: snapshot.username,
    authMethod: snapshot.authMethod,
    title: snapshot.connectionName || tab.title,
    status: snapshot.status,
    jumps: snapshot.jumps.map((hop) => ({ ...hop })),
    activeHop: snapshot.activeHop ? { ...snapshot.activeHop } : null,
    createdAt: snapshot.createdAt,
    connectedAt: snapshot.connectedAt,
    hostKey: snapshot.hostKey ? { ...snapshot.hostKey } : null,
    failure: snapshot.error ? { ...snapshot.error } : null,
    hasTerminal: tab.hasTerminal || snapshot.status === 'connected',
  }
}

function appendDismissed(current: string[], ids: Array<string | null>): string[] {
  const next = [...current]
  for (const id of ids) {
    if (id && !next.includes(id)) next.push(id)
  }
  return next.slice(-MAX_DISMISSED_IDS)
}

function failureFromOperation(error: OperationError): SshFailure {
  if (error.code === 'not-found') {
    return { code: 'configuration-invalid', message: error.message }
  }
  if (error.code === 'limit-exceeded') {
    return { code: 'internal', message: error.message }
  }
  return { code: 'internal', message: error.message }
}

function isTabReusable(tabId: string): boolean {
  return Boolean(useSessionStore.getState().sessions[tabId]) && !closingTabs.has(tabId)
}

function setTabFailure(tabId: string, failure: SshFailure): void {
  // Local/IPC failures are not transport failures and must never consume or
  // continue an automatic retry sequence.
  stopAutoReconnect(tabId)
  useSessionStore.setState((state) => {
    const tab = state.sessions[tabId]
    if (!tab || closingTabs.has(tabId)) return state
    return {
      sessions: {
        ...state.sessions,
        [tabId]: { ...tab, status: 'error', failure },
      },
    }
  })
}

function pushConnectionError(connectionName: string, message: string): void {
  useAppStore.getState().pushToast({
    tone: 'danger',
    title: `无法连接 ${connectionName}`,
    description: message,
  })
}

async function disconnectSession(sessionId: string): Promise<boolean> {
  const bridge = window.termforge
  if (!bridge) return true
  try {
    const result = await bridge.ssh.disconnect(sessionId)
    return result.ok || result.error.code === 'not-found'
  } catch {
    return false
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve('timeout')
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve('timeout')
      },
    )
  })
}

async function waitForSessionId(tabId: string): Promise<string | null> {
  const current = useSessionStore.getState().sessions[tabId]?.sessionId
  if (current) return current
  const pending = pendingConnects.get(tabId)
  if (!pending) return null
  const result = await withTimeout(pending, CLOSE_WAIT_MS)
  if (result === 'timeout') return null
  return result.sessionId
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: {},
  dismissedSessionIds: [],

  openSession: async (connection) => {
    const existing = Object.values(get().sessions).find(
      (session) => session.connectionId === connection.id && PENDING_STATUSES.has(session.status),
    )
    if (existing) {
      useWorkspaceStore.getState().activateTab(existing.id)
      return existing.id
    }

    const bridge = window.termforge
    if (!bridge) {
      useAppStore.getState().pushToast({
        tone: 'warning',
        title: 'SSH 连接不可用',
        description: '未加载 Electron preload bridge，无法建立真实 SSH 连接。',
      })
      return null
    }

    const tabId = createTabId()
    set((state) => ({
      sessions: { ...state.sessions, [tabId]: newTab(connection, tabId) },
    }))
    useWorkspaceStore.getState().addTab(tabId)
    const attemptEpoch = beginAttempt(tabId)

    const request = bridge.ssh.connect(connection.id, tabId)
    const pending = request.then(
      (result) =>
        result.ok
          ? { sessionId: result.value.session.sessionId, reused: result.value.reused }
          : { sessionId: null, reused: false },
      () => ({ sessionId: null, reused: false }),
    )
    pendingConnects.set(tabId, pending)

    try {
      const result = await request
      if (!isTabReusable(tabId)) {
        if (result.ok) void disconnectSession(result.value.session.sessionId)
        return null
      }
      if (!isAttemptCurrent(tabId, attemptEpoch)) {
        // The user cancelled while this request was in flight. The tab stays,
        // but a connection that completed too late must be released rather
        // than bound to the cancelled attempt.
        if (result.ok) void disconnectSession(result.value.session.sessionId)
        return tabId
      }
      if (!result.ok) {
        setTabFailure(tabId, failureFromOperation(result.error))
        pushConnectionError(connection.name, result.error.message)
        return tabId
      }

      const snapshot = result.value.session
      if (snapshot.clientId !== tabId) {
        setTabFailure(tabId, {
          code: 'internal',
          message: '主进程返回的会话与标签不匹配，已拒绝绑定。',
        })
        void disconnectSession(snapshot.sessionId)
        return tabId
      }
      get().applySshSnapshot(snapshot)
      return tabId
    } catch {
      if (isTabReusable(tabId) && isAttemptCurrent(tabId, attemptEpoch)) {
        setTabFailure(tabId, {
          code: 'internal',
          message: 'SSH 连接请求失败，请稍后重试。',
        })
        pushConnectionError(connection.name, 'SSH 连接请求失败，请稍后重试。')
      }
      return isTabReusable(tabId) ? tabId : null
    } finally {
      if (pendingConnects.get(tabId) === pending) pendingConnects.delete(tabId)
    }
  },
  reconnectSession: async (tabId) => {
    // A manual reconnect always supersedes a waiting automatic retry and
    // restarts the bounded sequence from a fresh counter if it fails again.
    stopAutoReconnect(tabId)
    return startReconnectAttempt(tabId, false)
  },

  cancelConnect: async (tabId) => {
    const inFlight = cancelPromises.get(tabId)
    if (inFlight) return inFlight

    const session = get().sessions[tabId]
    if (!session || closingTabs.has(tabId)) return
    if (!CANCELLABLE_STATUSES.has(session.status)) return

    const operation = performCancelConnect(tabId, session).finally(() => {
      if (cancelPromises.get(tabId) === operation) cancelPromises.delete(tabId)
    })
    cancelPromises.set(tabId, operation)
    await operation
  },

  cancelAutoReconnect: async (tabId) => {
    const session = get().sessions[tabId]
    if (!session) return
    const inFlight = session.status === 'reconnecting' && session.autoReconnect !== null
    stopAutoReconnect(tabId)
    if (inFlight) await get().cancelConnect(tabId)
  },

  applySshSnapshot: (snapshot) => {
    if (get().dismissedSessionIds.includes(snapshot.sessionId)) return null
    if (cancelledTabs.has(snapshot.clientId)) {
      // Once a tab's attempt is cancelled, no event from that attempt may
      // revive it. A connection that completed after the user cancelled is
      // released instead of being bound to the tab.
      if (snapshot.status === 'connected') {
        set((state) => ({
          dismissedSessionIds: appendDismissed(state.dismissedSessionIds, [snapshot.sessionId]),
        }))
        void disconnectSession(snapshot.sessionId)
      }
      return null
    }
    const tab = get().sessions[snapshot.clientId]
    // A tab rendered `closing` by the main process for an explicit disconnect
    // must still accept the following `disconnected` snapshot. Only a close
    // initiated by the renderer removes the tab from event processing.
    if (!tab || closingTabs.has(snapshot.clientId)) return null
    if (tab.sessionId !== null && tab.sessionId !== snapshot.sessionId) {
      // A late event from a superseded SSH session must never overwrite the tab.
      set((state) => ({
        dismissedSessionIds: appendDismissed(state.dismissedSessionIds, [snapshot.sessionId]),
      }))
      return null
    }

    const next = applySnapshotToTab(tab, snapshot)
    set((state) => ({
      sessions: { ...state.sessions, [snapshot.clientId]: next },
      dismissedSessionIds: state.dismissedSessionIds.filter((id) => id !== snapshot.sessionId),
    }))
    if (next.status === 'connected') {
      stopAutoReconnect(next.id)
      bindTerminalTab(next.id, snapshot.sessionId)
    } else if (next.status === 'error' || next.status === 'disconnected') {
      if (next.failure) scheduleAutoReconnect(next.id, next.failure)
      else stopAutoReconnect(next.id)
    } else if (next.status === 'closing') {
      stopAutoReconnect(next.id)
    }
    if (next.status === 'error' || next.status === 'disconnected' || next.status === 'closing') {
      useSshPromptStore.getState().clearHostKeysForSession(snapshot.sessionId)
    }
    return next
  },

  requestDisconnect: async (tabId) => {
    stopAutoReconnect(tabId)
    autoReconnectSuppressedTabs.add(tabId)
    const session = get().sessions[tabId]
    if (!session) return
    if (!session.sessionId) {
      await get().closeSession(tabId)
      return
    }
    if (disconnectPromises.has(tabId)) return

    const bridge = window.termforge
    if (!bridge) {
      useAppStore.getState().pushToast({
        tone: 'warning',
        title: '无法断开连接',
        description: '未加载 Electron preload bridge，没有可断开的主进程会话。',
      })
      return
    }

    const operation = (async () => {
      const sessionId = session.sessionId as string
      try {
        const result = await bridge.ssh.disconnect(sessionId)
        if (result.ok) {
          get().applySshSnapshot(result.value)
          return
        }
        useAppStore.getState().pushToast({
          tone: 'danger',
          title: '断开连接失败',
          description: result.error.message,
        })
      } catch {
        useAppStore.getState().pushToast({
          tone: 'danger',
          title: '断开连接失败',
          description: '主进程未能处理断开请求，请稍后重试。',
        })
      }
    })().finally(() => {
      disconnectPromises.delete(tabId)
    })
    disconnectPromises.set(tabId, operation)
    await operation
  },

  closeSession: async (tabId) => {
    const existing = closePromises.get(tabId)
    if (existing) return existing

    const session = get().sessions[tabId]
    if (!session) return

    const operation = performClose(tabId, session).finally(() => {
      if (closePromises.get(tabId) === operation) closePromises.delete(tabId)
    })
    closePromises.set(tabId, operation)
    await operation
  },

  closeSessionsForConnection: async (connectionId) => {
    const tabs = Object.values(get().sessions).filter(
      (session) => session.connectionId === connectionId,
    )
    await Promise.all(tabs.map((session) => get().closeSession(session.id)))
  },

  retainConnections: (connectionIds) => {
    const validIds = new Set(connectionIds)
    const removed = Object.values(get().sessions).filter(
      (session) => !validIds.has(session.connectionId),
    )
    for (const session of removed) void get().closeSession(session.id)
  },

  syncConnectionProfiles: (connections) => {
    const byId = new Map(connections.map((connection) => [connection.id, connection.name]))
    set((state) => {
      let changed = false
      const sessions: Record<string, SessionInfo> = {}
      for (const [tabId, session] of Object.entries(state.sessions)) {
        const name = byId.get(session.connectionId)
        if (name && (session.connectionName !== name || session.title !== name)) {
          changed = true
          sessions[tabId] = { ...session, connectionName: name, title: name }
        } else {
          sessions[tabId] = session
        }
      }
      return changed ? { sessions } : state
    })
  },

  reset: () => {
    stopAllAutoReconnect()
    const removed = Object.values(get().sessions)
    set({
      sessions: {},
      dismissedSessionIds: appendDismissed(
        get().dismissedSessionIds,
        removed.map((session) => session.sessionId),
      ),
    })
    for (const session of removed) {
      forgetTerminalTab(session.id)
      if (session.sessionId) void disconnectSession(session.sessionId)
    }
    for (const tabId of pendingConnects.keys()) {
      const pending = pendingConnects.get(tabId)
      void pending?.then((result) => {
        if (result.sessionId) void disconnectSession(result.sessionId)
      })
    }
    pendingConnects.clear()
    closePromises.clear()
    reconnectPromises.clear()
    disconnectPromises.clear()
    cancelPromises.clear()
    attemptEpochs.clear()
    cancelledTabs.clear()
    closingTabs.clear()
    autoReconnectSuppressedTabs.clear()
    useWorkspaceStore.getState().resetTabs()
    resetTerminalSessions()
    useSftpStore.getState().reset()
    useLocalPanelStore.getState().reset()
    useSshPromptStore.getState().reset()
  },
}))

// Disabling the preference is an immediate stop condition, including for a
// retry that is already waiting on its backoff timer.
useSettingsStore.subscribe((state, previous) => {
  if (previous.autoReconnectEnabled && !state.autoReconnectEnabled) {
    stopAllAutoReconnect()
  }
})

async function performCancelConnect(tabId: string, session: SessionInfo): Promise<void> {
  stopAutoReconnect(tabId)
  const attemptEpoch = cancelAttempt(tabId)
  const previousSessionId = session.sessionId
  if (previousSessionId) {
    useSshPromptStore.getState().clearHostKeysForSession(previousSessionId)
    useSshPromptStore.getState().clearCredentialForSession(previousSessionId)
  }

  // Reflect the cancellation immediately so the tab stops advertising a busy
  // state even while the main process is still unwinding the transport.
  useSessionStore.setState((state) => {
    const current = state.sessions[tabId]
    if (!current || closingTabs.has(tabId)) return state
    return {
      sessions: {
        ...state.sessions,
        [tabId]: {
          ...current,
          status: 'disconnected',
          hasTerminal: false,
          connectedAt: null,
          failure: cancelledFailure(),
        },
      },
    }
  })

  const bridge = window.termforge
  if (!bridge) return

  const outcome = await withTimeout(bridge.ssh.cancelConnect(tabId), CLOSE_WAIT_MS)
  if (!isCancelledAttempt(tabId, attemptEpoch)) return

  if (outcome === 'timeout') {
    useAppStore.getState().pushToast({
      tone: 'warning',
      title: '取消连接未确认',
      description: '主进程未能及时确认取消，迟到的连接结果会被自动释放。',
    })
    return
  }
  if (!outcome.ok) {
    useAppStore.getState().pushToast({
      tone: 'warning',
      title: '取消连接未确认',
      description: outcome.error.message,
    })
    return
  }

  const snapshot = outcome.value.session
  if (!outcome.value.cancelled && snapshot?.status === 'connected') {
    // The attempt completed just before the cancel reached the main process.
    // Release it without ever binding it to the cancelled tab.
    useSessionStore.setState((state) => ({
      dismissedSessionIds: appendDismissed(state.dismissedSessionIds, [snapshot.sessionId]),
    }))
    void disconnectSession(snapshot.sessionId)
    return
  }
  if (!outcome.value.cancelled || !snapshot) return

  useSshPromptStore.getState().clearHostKeysForSession(snapshot.sessionId)
  useSshPromptStore.getState().clearCredentialForSession(snapshot.sessionId)
  useSessionStore.setState((state) => {
    const current = state.sessions[tabId]
    if (!current || closingTabs.has(tabId)) return state
    return {
      sessions: {
        ...state.sessions,
        [tabId]: {
          ...current,
          sessionId: snapshot.sessionId,
          status: 'disconnected',
          hasTerminal: false,
          connectedAt: null,
          failure: snapshot.error ?? cancelledFailure(),
        },
      },
    }
  })
}

async function startReconnectAttempt(tabId: string, automatic: boolean): Promise<string | null> {
  const inFlight = reconnectPromises.get(tabId)
  if (inFlight) return inFlight

  // Never start a replacement attempt while the main process may still be
  // finishing the cancel request for the previous attempt.
  const cancelling = cancelPromises.get(tabId)
  if (cancelling) {
    await cancelling
    if (automatic) {
      stopAutoReconnect(tabId)
      return null
    }
    return startReconnectAttempt(tabId, false)
  }

  const session = useSessionStore.getState().sessions[tabId]
  if (!session) return null
  if (LIVE_STATUSES.has(session.status) && session.status !== 'reconnecting') {
    useWorkspaceStore.getState().activateTab(tabId)
    return tabId
  }
  if (session.status === 'closing') return null

  const operation = performReconnect(tabId, session, automatic).finally(() => {
    if (reconnectPromises.get(tabId) === operation) reconnectPromises.delete(tabId)
  })
  reconnectPromises.set(tabId, operation)
  return operation
}

async function performReconnect(
  tabId: string,
  session: SessionInfo,
  automatic: boolean,
): Promise<string | null> {
  autoReconnectSuppressedTabs.delete(tabId)
  const oldSessionId = session.sessionId
  const generation = session.generation + 1
  const bridge = window.termforge
  if (!bridge) {
    setTabFailure(tabId, {
      code: 'internal',
      message: '未加载 Electron preload bridge，无法重新连接。',
    })
    return null
  }
  const attemptEpoch = beginAttempt(tabId)

  unbindTerminalTab(tabId)
  clearTerminalTab(tabId)
  useSftpStore.getState().forgetTab(tabId)
  if (oldSessionId) {
    useSshPromptStore.getState().clearCredentialForSession(oldSessionId)
    useSshPromptStore.getState().clearHostKeysForSession(oldSessionId)
  }

  useSessionStore.setState((state) => {
    const current = state.sessions[tabId]
    if (!current) return state
    return {
      sessions: {
        ...state.sessions,
        [tabId]: {
          ...current,
          sessionId: null,
          status: 'reconnecting',
          generation,
          hasTerminal: false,
          connectedAt: null,
          hostKey: null,
          failure: null,
        },
      },
      dismissedSessionIds: appendDismissed(state.dismissedSessionIds, [oldSessionId]),
    }
  })

  if (oldSessionId) {
    const disconnected = await withTimeout(disconnectSession(oldSessionId), CLOSE_WAIT_MS)
    if (!isAttemptCurrent(tabId, attemptEpoch) || !isTabReusable(tabId)) {
      return null
    }
    if (disconnected === 'timeout' || disconnected === false) {
      if (isTabReusable(tabId)) {
        setTabFailure(tabId, {
          code: 'internal',
          message: '无法确认旧 SSH 会话已释放，已中止重连以避免复用旧传输。',
        })
      }
      return null
    }
  }

  if (
    !isAttemptCurrent(tabId, attemptEpoch) ||
    !isTabReusable(tabId) ||
    useSessionStore.getState().sessions[tabId]?.generation !== generation
  ) {
    return null
  }

  const request = bridge.ssh.connect(session.connectionId, tabId)
  const pending = request.then(
    (result) =>
      result.ok
        ? { sessionId: result.value.session.sessionId, reused: result.value.reused }
        : { sessionId: null, reused: false },
    () => ({ sessionId: null, reused: false }),
  )
  pendingConnects.set(tabId, pending)

  try {
    const result = await request
    if (
      !isAttemptCurrent(tabId, attemptEpoch) ||
      !isTabReusable(tabId) ||
      useSessionStore.getState().sessions[tabId]?.generation !== generation
    ) {
      if (result.ok) void disconnectSession(result.value.session.sessionId)
      return null
    }
    if (!result.ok) {
      setTabFailure(tabId, failureFromOperation(result.error))
      if (!automatic) {
        useAppStore.getState().pushToast({
          tone: 'danger',
          title: '重新连接失败',
          description: result.error.message,
        })
      }
      return tabId
    }
    if (result.value.session.clientId !== tabId) {
      setTabFailure(tabId, {
        code: 'internal',
        message: '主进程返回的会话与标签不匹配，已拒绝绑定。',
      })
      void disconnectSession(result.value.session.sessionId)
      return tabId
    }
    useSessionStore.getState().applySshSnapshot(result.value.session)
    return tabId
  } catch {
    if (isTabReusable(tabId) && isAttemptCurrent(tabId, attemptEpoch)) {
      setTabFailure(tabId, {
        code: 'internal',
        message: '重新连接请求失败，请稍后重试。',
      })
    }
    return null
  } finally {
    if (pendingConnects.get(tabId) === pending) pendingConnects.delete(tabId)
  }
}

async function performClose(tabId: string, session: SessionInfo): Promise<void> {
  stopAutoReconnect(tabId)
  const bridge = window.termforge
  closingTabs.add(tabId)

  useSessionStore.setState((state) => {
    const current = state.sessions[tabId]
    if (!current) return state
    return {
      sessions: {
        ...state.sessions,
        [tabId]: {
          ...current,
          status: 'closing',
          hasTerminal: false,
        },
      },
      dismissedSessionIds: appendDismissed(state.dismissedSessionIds, [current.sessionId]),
    }
  })

  if (session.sessionId) {
    useSshPromptStore.getState().clearHostKeysForSession(session.sessionId)
    useSshPromptStore.getState().clearCredentialForSession(session.sessionId)
  }
  unbindTerminalTab(tabId)
  clearTerminalTab(tabId)
  useSftpStore.getState().forgetTab(tabId)
  useLocalPanelStore.getState().forgetTab(tabId)

  let sessionId = session.sessionId
  if (!sessionId) sessionId = await waitForSessionId(tabId)

  if (sessionId && bridge) {
    const outcome = await withTimeout(bridge.ssh.disconnect(sessionId), CLOSE_WAIT_MS)
    if (outcome === 'timeout') {
      useAppStore.getState().pushToast({
        tone: 'warning',
        title: '会话仍在清理',
        description: '已从工作区移除该标签；主进程清理结果未能及时确认。',
      })
    } else if (!outcome.ok && outcome.error.code !== 'not-found') {
      // The main process explicitly failed; keep the tab so the user can retry
      // instead of silently leaking an unreachable SSH transport.
      closingTabs.delete(tabId)
      useSessionStore.setState((state) => {
        const current = state.sessions[tabId]
        if (!current) return state
        return {
          sessions: {
            ...state.sessions,
            [tabId]: {
              ...current,
              sessionId,
              status: 'error',
              hasTerminal: false,
              failure: {
                code: 'internal',
                message: '主进程未能关闭该 SSH 会话，请重试关闭或重新连接。',
              },
            },
          },
        }
      })
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: '关闭会话失败',
        description: '主进程未能确认 SSH 会话已关闭，标签已保留以便重试。',
      })
      return
    }
  }

  closingTabs.delete(tabId)
  useSessionStore.setState((state) => {
    const sessions = { ...state.sessions }
    delete sessions[tabId]
    return {
      sessions,
      dismissedSessionIds: appendDismissed(state.dismissedSessionIds, [sessionId]),
    }
  })
  useWorkspaceStore.getState().removeTab(tabId)
  forgetTerminalTab(tabId)
  forgetAttempt(tabId)
  autoReconnectSuppressedTabs.delete(tabId)
}

export function promptForCredentialIfNeeded(session: SessionInfo): void {
  const failure = session.failure
  if (!failure?.credentialKind || !CREDENTIAL_PROMPT_CODES.has(failure.code)) return
  if (!session.sessionId) return
  // A jump-host credential failure must be resolved against that hop's own
  // connection profile, never against the final target.
  const hop = failure.hop ?? null
  useSshPromptStore.getState().openCredentialPrompt({
    tabId: session.id,
    sessionId: session.sessionId,
    connectionId: hop ? hop.connectionId : session.connectionId,
    connectionName: hop ? hop.name : session.connectionName,
    host: hop ? hop.host : session.host,
    port: hop ? hop.port : session.port,
    username: hop ? hop.username : session.username,
    authMethod: hop ? hop.authMethod : session.authMethod,
    kind: failure.credentialKind,
    message: failure.message,
    ...(hop ? { hopIndex: hop.index } : {}),
  })
}
