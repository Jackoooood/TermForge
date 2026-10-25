import type {
  OperationError,
  TerminalFailure,
  TerminalShellSnapshot,
  TerminalSize,
  TermForgeBridge,
} from '@shared/types'
import { DEFAULT_TERMINAL_SIZE } from '@shared/types'
import { MAX_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS } from '@shared/schemas/terminal'
import { useTerminalStore } from '@renderer/stores/terminalStore'

const MAX_TRANSCRIPT_CHARS = 256 * 1024
const MAX_WRITE_CHUNK_CHARS = 32 * 1024
const MAX_IGNORED_SESSIONS = 200

type OutputListener = (data: string) => void

interface Transcript {
  chunks: string[]
  length: number
}

interface TabBinding {
  tabId: string
  sessionId: string
}

// Terminal history is keyed by the stable workspace tab, never by the
// main-process SSH session: a reconnect replaces the session while the tab
// (and its xterm instance) stays in place.
const transcripts = new Map<string, Transcript>()
const outputListeners = new Map<string, Set<OutputListener>>()
const revisions = new Map<string, number>()
const lastResizeKeys = new Map<string, string>()
const writeQueues = new Map<string, Promise<void>>()
const pendingOpens = new Map<string, Promise<TerminalShellSnapshot | null>>()
const bindings = new Map<string, TabBinding>()
const sessionTabs = new Map<string, string>()
const ignoredSessions = new Set<string>()
const ignoredOrder: string[] = []

let attachedCount = 0
let detachBridge: (() => void) | null = null

function terminalBridge(): TermForgeBridge['terminal'] | null {
  return typeof window === 'undefined' ? null : window.termforge?.terminal ?? null
}

function bumpRevision(tabId: string): void {
  revisions.set(tabId, (revisions.get(tabId) ?? 0) + 1)
}

function ignoreSession(sessionId: string): void {
  if (!sessionId || ignoredSessions.has(sessionId)) return
  ignoredSessions.add(sessionId)
  ignoredOrder.push(sessionId)
  while (ignoredOrder.length > MAX_IGNORED_SESSIONS) {
    const oldest = ignoredOrder.shift()
    if (oldest) ignoredSessions.delete(oldest)
  }
}

function appendTranscript(tabId: string, data: string): void {
  if (!data) return
  const transcript = transcripts.get(tabId) ?? { chunks: [], length: 0 }
  if (data.length >= MAX_TRANSCRIPT_CHARS) {
    transcript.chunks = [data.slice(data.length - MAX_TRANSCRIPT_CHARS)]
    transcript.length = transcript.chunks[0].length
    transcripts.set(tabId, transcript)
    return
  }
  transcript.chunks.push(data)
  transcript.length += data.length
  while (transcript.length > MAX_TRANSCRIPT_CHARS && transcript.chunks.length > 1) {
    const removed = transcript.chunks.shift()
    transcript.length -= removed?.length ?? 0
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS && transcript.chunks.length === 1) {
    const only = transcript.chunks[0]
    transcript.chunks[0] = only.slice(only.length - MAX_TRANSCRIPT_CHARS)
    transcript.length = transcript.chunks[0].length
  }
  transcripts.set(tabId, transcript)
}

function routeSession(sessionId: string): string | null {
  if (ignoredSessions.has(sessionId)) return null
  return sessionTabs.get(sessionId) ?? null
}

function handleOutput(event: { sessionId: string; data: string }): void {
  if (typeof event.data !== 'string' || event.data.length === 0) return
  const tabId = routeSession(event.sessionId)
  if (!tabId) return
  appendTranscript(tabId, event.data)
  const listeners = outputListeners.get(tabId)
  if (!listeners) return
  for (const listener of listeners) {
    try {
      listener(event.data)
    } catch {
      // A disposed xterm instance must not break other terminal panes.
    }
  }
}

/**
 * Starts mirroring main-process terminal events into the renderer. The app root
 * keeps this attached for its whole lifetime so output produced while another
 * module view is open is still buffered for the affected tab.
 */
export function attachTerminalRuntime(): () => void {
  const bridge = terminalBridge()
  if (!bridge) return () => {}

  attachedCount += 1
  if (!detachBridge) {
    const unsubOutput = bridge.onOutput(handleOutput)
    const unsubStatus = bridge.onStatus((snapshot) => {
      const tabId = routeSession(snapshot.sessionId)
      if (!tabId) return
      bumpRevision(tabId)
      useTerminalStore.getState().applySnapshot(tabId, snapshot)
    })
    const unsubExit = bridge.onExit((event) => {
      const tabId = routeSession(event.sessionId)
      if (!tabId) return
      bumpRevision(tabId)
      useTerminalStore.getState().applyExit(tabId, event)
    })
    detachBridge = () => {
      unsubOutput()
      unsubStatus()
      unsubExit()
    }
  }

  let released = false
  return () => {
    if (released) return
    released = true
    attachedCount = Math.max(0, attachedCount - 1)
    if (attachedCount === 0 && detachBridge) {
      detachBridge()
      detachBridge = null
    }
  }
}

/**
 * Associates the tab with its current main-process session. Called whenever the
 * renderer receives a main-process snapshot that carries a session ID, so shell
 * events arriving before xterm mounts are not lost.
 */
export function bindTerminalTab(tabId: string, sessionId: string): void {
  const current = bindings.get(tabId)
  if (current?.sessionId === sessionId) return
  if (current) {
    sessionTabs.delete(current.sessionId)
    ignoreSession(current.sessionId)
  }
  const previousTab = sessionTabs.get(sessionId)
  if (previousTab && previousTab !== tabId) {
    ignoreSession(sessionId)
    return
  }
  // An explicit binding is authoritative: it wins over a previous ignore.
  ignoredSessions.delete(sessionId)
  bindings.set(tabId, { tabId, sessionId })
  sessionTabs.set(sessionId, tabId)
  bumpRevision(tabId)
}

/** Drops the session binding and ignores all later events from that session. */
export function unbindTerminalTab(tabId: string): void {
  const current = bindings.get(tabId)
  if (!current) return
  bindings.delete(tabId)
  if (sessionTabs.get(current.sessionId) === tabId) sessionTabs.delete(current.sessionId)
  ignoreSession(current.sessionId)
  bumpRevision(tabId)
}

export function subscribeTerminalOutput(tabId: string, listener: OutputListener): () => void {
  const listeners = outputListeners.get(tabId) ?? new Set<OutputListener>()
  listeners.add(listener)
  outputListeners.set(tabId, listeners)

  let active = true
  return () => {
    if (!active) return
    active = false
    const current = outputListeners.get(tabId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) outputListeners.delete(tabId)
  }
}

/** Replay buffer for xterm remounts and React StrictMode double-mounts. */
export function getTerminalTranscript(tabId: string): string {
  const transcript = transcripts.get(tabId)
  return transcript ? transcript.chunks.join('') : ''
}

/** Drops the replay buffer without touching the live PTY or remote shell. */
export function clearTerminalTranscript(tabId: string): void {
  transcripts.delete(tabId)
}

/** Reads plain text from the OS clipboard through the main process. */
export async function readTerminalClipboard(): Promise<string | null> {
  const bridge = terminalBridge()
  if (!bridge) return null
  try {
    const result = await bridge.readClipboard()
    return result.ok ? result.value : null
  } catch {
    return null
  }
}

export function normalizeTerminalSize(size: TerminalSize | null | undefined): TerminalSize | null {
  if (!size) return null
  const { cols, rows } = size
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null
  if (cols < 1 || rows < 1) return null
  if (cols > MAX_TERMINAL_COLUMNS || rows > MAX_TERMINAL_ROWS) return null
  return { cols, rows }
}

function failureFromOperation(error: OperationError): TerminalFailure {
  if (error.code === 'not-found') {
    return { code: 'session-unavailable', message: error.message }
  }
  return { code: 'shell-open-failed', message: error.message }
}

const BRIDGE_MISSING: TerminalFailure = {
  code: 'bridge-unavailable',
  message: '未加载 Electron preload bridge，无法打开远程终端。',
}

async function readAuthoritativeStatus(tabId: string): Promise<TerminalShellSnapshot | null> {
  const bridge = terminalBridge()
  const binding = bindings.get(tabId)
  if (!bridge || !binding) return null
  const revision = revisions.get(tabId) ?? 0
  try {
    const result = await bridge.getStatus(binding.sessionId)
    if (!result.ok) return null
    if (
      (revisions.get(tabId) ?? 0) !== revision ||
      bindings.get(tabId)?.sessionId !== binding.sessionId
    ) {
      return useTerminalStore.getState().shells[tabId] ?? null
    }
    useTerminalStore.getState().applySnapshot(tabId, result.value)
    return result.value
  } catch {
    return null
  }
}

/** Resolves and mirrors the current shell status without changing the PTY. */
export async function syncTerminalShellStatus(
  tabId: string,
): Promise<TerminalShellSnapshot | null> {
  return readAuthoritativeStatus(tabId)
}

/**
 * Makes sure exactly one PTY exists for the tab's current SSH session. Opened
 * shells are reused by the main process, so remounts and StrictMode double
 * effects never leak channels.
 */
export function ensureTerminalShell(
  tabId: string,
  size: TerminalSize,
): Promise<TerminalShellSnapshot | null> {
  const pending = pendingOpens.get(tabId)
  if (pending) return pending

  const request = openShellInternal(tabId, size).finally(() => {
    if (pendingOpens.get(tabId) === request) pendingOpens.delete(tabId)
  })
  pendingOpens.set(tabId, request)
  return request
}

async function openShellInternal(
  tabId: string,
  requestedSize: TerminalSize,
): Promise<TerminalShellSnapshot | null> {
  const bridge = terminalBridge()
  const size = normalizeTerminalSize(requestedSize) ?? {
    cols: DEFAULT_TERMINAL_SIZE.cols,
    rows: DEFAULT_TERMINAL_SIZE.rows,
  }
  const binding = bindings.get(tabId)
  if (!bridge || !binding) {
    useTerminalStore.getState().applyFailure(
      tabId,
      bridge ? { code: 'session-unavailable', message: 'SSH 会话尚未绑定到该标签。' } : BRIDGE_MISSING,
      size,
    )
    return null
  }

  const revision = revisions.get(tabId) ?? 0
  const current = await readAuthoritativeStatus(tabId)
  if (bindings.get(tabId)?.sessionId !== binding.sessionId) return null
  if (!current) {
    const existing = useTerminalStore.getState().shells[tabId]
    if (!existing) {
      useTerminalStore.getState().applyFailure(
        tabId,
        {
          code: 'session-unavailable',
          message: '无法读取远程 Shell 状态，SSH 会话可能已断开。',
        },
        size,
      )
    }
    return existing ?? useTerminalStore.getState().shells[tabId] ?? null
  }
  if (current.status === 'open' || current.status === 'opening' || current.status === 'closing') {
    return current
  }

  // The previous shell is final; its transcript must not be mixed with the new
  // PTY. Buffer is cleared before the open call so early prompt output survives.
  transcripts.delete(tabId)
  try {
    const result = await bridge.open(binding.sessionId, size)
    if (bindings.get(tabId)?.sessionId !== binding.sessionId) return null
    if (!result.ok) {
      if ((revisions.get(tabId) ?? 0) === revision) {
        useTerminalStore
          .getState()
          .applyFailure(tabId, failureFromOperation(result.error), size)
      }
      return useTerminalStore.getState().shells[tabId] ?? null
    }

    if ((revisions.get(tabId) ?? 0) === revision) {
      useTerminalStore.getState().applyOpenResult(tabId, result.value)
    }
    return useTerminalStore.getState().shells[tabId] ?? null
  } catch {
    if ((revisions.get(tabId) ?? 0) === revision) {
      useTerminalStore.getState().applyFailure(
        tabId,
        { code: 'shell-open-failed', message: '打开远程 Shell 的请求失败，请稍后重试。' },
        size,
      )
    }
    return useTerminalStore.getState().shells[tabId] ?? null
  }
}

function splitWriteChunks(data: string): string[] {
  const chunks: string[] = []
  let offset = 0
  while (offset < data.length) {
    let end = Math.min(offset + MAX_WRITE_CHUNK_CHARS, data.length)
    if (end < data.length) {
      const code = data.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    chunks.push(data.slice(offset, end))
    offset = end
  }
  return chunks
}

function enqueueTerminalWrite(
  tabId: string,
  data: string,
  expectedSessionId?: string,
): Promise<boolean> {
  if (!data) return Promise.resolve(false)
  const snapshot = useTerminalStore.getState().shells[tabId]
  if (snapshot?.status !== 'open') return Promise.resolve(false)
  if (expectedSessionId !== undefined && snapshot.sessionId !== expectedSessionId) {
    return Promise.resolve(false)
  }
  const binding = bindings.get(tabId)
  const bridge = terminalBridge()
  if (!binding || !bridge) return Promise.resolve(false)
  if (expectedSessionId !== undefined && binding.sessionId !== expectedSessionId) {
    return Promise.resolve(false)
  }

  const previous = writeQueues.get(tabId) ?? Promise.resolve()
  let written = true
  const next = previous
    .then(async () => {
      for (const chunk of splitWriteChunks(data)) {
        const current = useTerminalStore.getState().shells[tabId]
        if (
          current?.status !== 'open' ||
          current.sessionId !== binding.sessionId ||
          bindings.get(tabId) !== binding
        ) {
          written = false
          return
        }
        const result = await bridge.write(binding.sessionId, chunk)
        if (!result.ok) {
          written = false
          void syncTerminalShellStatus(tabId)
          return
        }
      }
    })
    .catch(() => {
      written = false
    })

  writeQueues.set(tabId, next)
  void next.then(() => {
    if (writeQueues.get(tabId) === next) writeQueues.delete(tabId)
  })
  return next.then(() => written)
}

/**
 * Routes keyboard/paste data to the tab's current PTY. The renderer never
 * echoes locally; no data is mirrored into React or Zustand. Writes are
 * serialized so a large paste cannot reorder chunks.
 */
export function writeTerminalInput(tabId: string, data: string): void {
  void enqueueTerminalWrite(tabId, data)
}

/**
 * Waits until every input queued for the tab has been handed to the main
 * process. A quick command uses this so it cannot overtake keystrokes that were
 * already accepted by xterm.
 */
export async function flushTerminalInput(tabId: string): Promise<void> {
  await (writeQueues.get(tabId) ?? Promise.resolve())
}

/**
 * Inserts text at the terminal cursor without a newline. The expected session
 * ID is rechecked against both the shell snapshot and the runtime binding so a
 * reconnect cannot silently retarget the insert.
 */
export function insertTerminalInput(
  tabId: string,
  sessionId: string,
  data: string,
): Promise<boolean> {
  return enqueueTerminalWrite(tabId, data, sessionId)
}

export function resizeTerminalShell(tabId: string, size: TerminalSize): void {
  const normalized = normalizeTerminalSize(size)
  if (!normalized) return
  const snapshot = useTerminalStore.getState().shells[tabId]
  if (snapshot?.status !== 'open' && snapshot?.status !== 'opening') return
  const binding = bindings.get(tabId)
  const bridge = terminalBridge()
  if (!binding || !bridge) return

  const key = `${binding.sessionId}:${normalized.cols}x${normalized.rows}`
  if (lastResizeKeys.get(tabId) === key) return
  lastResizeKeys.set(tabId, key)

  void bridge
    .resize(binding.sessionId, normalized)
    .then((result) => {
      if (result.ok) {
        useTerminalStore.getState().applySize(tabId, normalized)
        return
      }
      if (lastResizeKeys.get(tabId) === key) lastResizeKeys.delete(tabId)
      if (result.error.code === 'conflict') void syncTerminalShellStatus(tabId)
    })
    .catch(() => {
      if (lastResizeKeys.get(tabId) === key) lastResizeKeys.delete(tabId)
    })
}

export async function closeTerminalShell(tabId: string): Promise<void> {
  const binding = bindings.get(tabId)
  const bridge = terminalBridge()
  if (!bridge || !binding) return
  try {
    await bridge.close(binding.sessionId)
  } catch {
    // Status notifications remain authoritative for teardown.
  }
  await syncTerminalShellStatus(tabId)
}

/** Clears transcript and shell state before a reconnect binds a new session. */
export function clearTerminalTab(tabId: string): void {
  transcripts.delete(tabId)
  lastResizeKeys.delete(tabId)
  writeQueues.delete(tabId)
  pendingOpens.delete(tabId)
  useTerminalStore.getState().removeTab(tabId)
  bumpRevision(tabId)
}

/** Clears all renderer-side terminal state for a tab that is being closed. */
export function forgetTerminalTab(tabId: string): void {
  unbindTerminalTab(tabId)
  transcripts.delete(tabId)
  outputListeners.delete(tabId)
  revisions.delete(tabId)
  lastResizeKeys.delete(tabId)
  writeQueues.delete(tabId)
  pendingOpens.delete(tabId)
  useTerminalStore.getState().removeTab(tabId)
}

/** Reset for an explicit user action that tears down every SSH session. */
export function resetTerminalSessions(): void {
  for (const binding of bindings.values()) {
    ignoreSession(binding.sessionId)
  }
  bindings.clear()
  sessionTabs.clear()
  transcripts.clear()
  outputListeners.clear()
  revisions.clear()
  lastResizeKeys.clear()
  writeQueues.clear()
  pendingOpens.clear()
  useTerminalStore.getState().reset()
}
