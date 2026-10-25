import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OperationError,
  OperationResult,
  TerminalExitEvent,
  TerminalOpenResult,
  TerminalOutputEvent,
  TerminalShellSnapshot,
  TerminalSize,
  TerminalStatusEvent,
} from '@shared/types'
import { DEFAULT_TERMINAL_SIZE } from '@shared/types'
import { createFakeBridge } from './helpers/fakeBridge'

const SESSION_ID = 'ssh-session-1'
const TAB_ID = 'sshtab-1'
const OTHER_SESSION_ID = 'ssh-session-2'
const OTHER_TAB_ID = 'sshtab-2'

function ok<T>(value: T): OperationResult<T> {
  return { ok: true, value }
}

function failed(error: OperationError): OperationResult<never> {
  return { ok: false, error }
}

function idleSnapshot(sessionId: string): TerminalShellSnapshot {
  return {
    sessionId,
    status: 'idle',
    size: { ...DEFAULT_TERMINAL_SIZE },
    failure: null,
    exit: null,
  }
}

function openSnapshot(sessionId: string, size: TerminalSize): TerminalShellSnapshot {
  return { sessionId, status: 'open', size: { ...size }, failure: null, exit: null }
}

interface BridgeHarnessOptions {
  getStatusError?: OperationError
  openError?: OperationError
  initialStatus?: 'idle' | 'exited'
}

function createTerminalHarness(options: BridgeHarnessOptions = {}) {
  let current =
    options.initialStatus === 'exited'
      ? {
          ...idleSnapshot(SESSION_ID),
          status: 'exited' as const,
          exit: { code: 0, signal: null, reason: 'remote-exit' as const },
        }
      : idleSnapshot(SESSION_ID)

  const outputListeners = new Set<(event: TerminalOutputEvent) => void>()
  const statusListeners = new Set<(event: TerminalStatusEvent) => void>()
  const exitListeners = new Set<(event: TerminalExitEvent) => void>()
  const removed = vi.fn()

  function emitStatus(snapshot: TerminalShellSnapshot): void {
    current = snapshot
    for (const listener of [...statusListeners]) listener(snapshot)
  }

  function emitExit(event: TerminalExitEvent): void {
    for (const listener of [...exitListeners]) listener(event)
  }

  const open = vi.fn(async (sessionId: string, size: TerminalSize) => {
    if (options.openError) return failed(options.openError)
    current = openSnapshot(sessionId, size)
    for (const listener of [...statusListeners]) listener(current)
    return ok<TerminalOpenResult>({ sessionId, status: 'open', size, reused: false })
  })
  const write = vi.fn(async (sessionId: string, _data: string) => ok({ sessionId }))
  const resize = vi.fn(async (sessionId: string, _size: TerminalSize) => ok({ sessionId }))
  const close = vi.fn(async (sessionId: string) => {
    current = {
      ...current,
      status: 'closed',
      exit: { code: null, signal: null, reason: 'local-close' },
    }
    for (const listener of [...statusListeners]) listener(current)
    return ok({ sessionId })
  })
  const getStatus = vi.fn(async (sessionId: string) => {
    if (options.getStatusError) return failed(options.getStatusError)
    return ok({ ...current, sessionId })
  })

  const bridge = createFakeBridge(
    {},
    {},
    {
      open,
      write,
      resize,
      close,
      getStatus,
      onOutput: (listener) => {
        outputListeners.add(listener)
        return () => {
          outputListeners.delete(listener)
          removed('output', listener)
        }
      },
      onStatus: (listener) => {
        statusListeners.add(listener)
        return () => {
          statusListeners.delete(listener)
          removed('status', listener)
        }
      },
      onExit: (listener) => {
        exitListeners.add(listener)
        return () => {
          exitListeners.delete(listener)
          removed('exit', listener)
        }
      },
    },
  )
  window.termforge = bridge

  return {
    bridge,
    open,
    write,
    resize,
    close,
    getStatus,
    removed,
    emitStatus,
    emitExit,
    emitOutput: (event: TerminalOutputEvent) => {
      for (const listener of [...outputListeners]) listener(event)
    },
    listenerCounts: () => ({
      output: outputListeners.size,
      status: statusListeners.size,
      exit: exitListeners.size,
    }),
    current: () => current,
  }
}

async function loadTerminalModules() {
  const runtime = await import('../../src/renderer/src/services/terminalRuntime')
  const storeModule = await import('../../src/renderer/src/stores/terminalStore')
  return { runtime, useTerminalStore: storeModule.useTerminalStore }
}

describe('renderer terminal runtime', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useRealTimers()
  })

  it('opens exactly one PTY for concurrent and repeated requests', async () => {
    const harness = createTerminalHarness()
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)

    const first = runtime.ensureTerminalShell(TAB_ID, { cols: 100, rows: 40 })
    const second = runtime.ensureTerminalShell(TAB_ID, { cols: 80, rows: 24 })
    await Promise.all([first, second])
    await runtime.ensureTerminalShell(TAB_ID, { cols: 80, rows: 24 })

    expect(harness.open).toHaveBeenCalledTimes(1)
    expect(harness.open).toHaveBeenCalledWith(SESSION_ID, { cols: 100, rows: 40 })
    expect(useTerminalStore.getState().shells[TAB_ID]).toMatchObject({
      status: 'open',
      size: { cols: 100, rows: 40 },
    })
  })

  it('surfaces an unavailable SSH session without calling open', async () => {
    const harness = createTerminalHarness({
      getStatusError: { code: 'not-found', message: '找不到该 SSH 会话。' },
    })
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)

    const snapshot = await runtime.ensureTerminalShell(TAB_ID, { cols: 80, rows: 24 })

    expect(snapshot?.status).toBe('error')
    expect(harness.open).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().shells[TAB_ID]?.failure).toMatchObject({
      code: 'session-unavailable',
    })
  })

  it('surfaces an open failure as a shell error snapshot', async () => {
    createTerminalHarness({
      openError: { code: 'unavailable', message: 'SSH 会话尚未连接。' },
    })
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)

    const snapshot = await runtime.ensureTerminalShell(TAB_ID, { cols: 80, rows: 24 })

    expect(snapshot?.status).toBe('error')
    expect(useTerminalStore.getState().shells[TAB_ID]?.failure).toEqual({
      code: 'shell-open-failed',
      message: 'SSH 会话尚未连接。',
    })
  })

  it('replaces an exited shell with a new PTY on demand', async () => {
    const harness = createTerminalHarness({ initialStatus: 'exited' })
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)

    await runtime.ensureTerminalShell(TAB_ID, { cols: 90, rows: 30 })

    expect(harness.open).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().shells[TAB_ID]).toMatchObject({
      status: 'open',
      exit: null,
      failure: null,
    })
  })

  it('buffers output per tab, replays it and keeps output out of Zustand', async () => {
    const harness = createTerminalHarness()
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)
    runtime.bindTerminalTab(OTHER_TAB_ID, OTHER_SESSION_ID)
    const release = runtime.attachTerminalRuntime()
    const received: string[] = []
    const unsubscribe = runtime.subscribeTerminalOutput(TAB_ID, (data) => received.push(data))

    harness.emitOutput({ sessionId: 'ssh-unbound', data: 'leak' })
    harness.emitOutput({ sessionId: OTHER_SESSION_ID, data: 'other' })
    harness.emitOutput({ sessionId: SESSION_ID, data: 'pwd\r\n' })
    harness.emitStatus(openSnapshot(SESSION_ID, { cols: 80, rows: 24 }))
    harness.emitExit({
      sessionId: SESSION_ID,
      code: 0,
      signal: null,
      reason: 'remote-exit',
    })

    expect(received).toEqual(['pwd\r\n'])
    expect(runtime.getTerminalTranscript(TAB_ID)).toBe('pwd\r\n')
    expect(runtime.getTerminalTranscript(OTHER_TAB_ID)).toBe('other')
    expect(runtime.getTerminalTranscript('ssh-unbound')).toBe('')
    expect(useTerminalStore.getState().shells[TAB_ID]).toMatchObject({
      status: 'open',
      exit: { code: 0, reason: 'remote-exit' },
    })
    expect(JSON.stringify(useTerminalStore.getState())).not.toContain('pwd')

    unsubscribe()
    harness.emitOutput({ sessionId: SESSION_ID, data: 'ignored' })
    expect(received).toEqual(['pwd\r\n'])

    const huge = 'y'.repeat(300 * 1024)
    harness.emitOutput({ sessionId: SESSION_ID, data: huge })
    const transcript = runtime.getTerminalTranscript(TAB_ID)
    expect(transcript.length).toBe(256 * 1024)
    expect(transcript.endsWith('y')).toBe(true)

    release()
  })

  it('keeps the tab transcript and ignores events from a replaced SSH session', async () => {
    const harness = createTerminalHarness()
    const { runtime } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)
    const release = runtime.attachTerminalRuntime()

    harness.emitOutput({ sessionId: SESSION_ID, data: 'old\r\n' })
    runtime.bindTerminalTab(TAB_ID, OTHER_SESSION_ID)
    harness.emitOutput({ sessionId: SESSION_ID, data: 'late-old' })
    harness.emitOutput({ sessionId: OTHER_SESSION_ID, data: 'new\r\n' })

    expect(runtime.getTerminalTranscript(TAB_ID)).toBe('old\r\nnew\r\n')
    release()
  })

  it('subscribes once, survives StrictMode-style re-attach and unsubscribes cleanly', async () => {
    const harness = createTerminalHarness()
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)

    const releaseFirst = runtime.attachTerminalRuntime()
    const releaseSecond = runtime.attachTerminalRuntime()
    expect(harness.listenerCounts()).toEqual({ output: 1, status: 1, exit: 1 })

    releaseFirst()
    harness.emitStatus(openSnapshot(SESSION_ID, { cols: 80, rows: 24 }))
    expect(useTerminalStore.getState().shells[TAB_ID]?.status).toBe('open')
    expect(harness.listenerCounts()).toEqual({ output: 1, status: 1, exit: 1 })

    releaseSecond()
    expect(harness.listenerCounts()).toEqual({ output: 0, status: 0, exit: 0 })
    expect(harness.removed).toHaveBeenCalledTimes(3)

    harness.emitStatus(openSnapshot(SESSION_ID, { cols: 90, rows: 30 }))
    expect(useTerminalStore.getState().shells[TAB_ID]?.size).toEqual({
      cols: 80,
      rows: 24,
    })
  })

  it('routes input only while open, serializes large paste chunks and never stores it', async () => {
    const harness = createTerminalHarness()
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)

    runtime.writeTerminalInput(TAB_ID, 'pwd\r')
    expect(harness.write).not.toHaveBeenCalled()

    useTerminalStore
      .getState()
      .applySnapshot(TAB_ID, openSnapshot(SESSION_ID, { cols: 80, rows: 24 }))
    runtime.writeTerminalInput(TAB_ID, 'pwd\r')
    await vi.waitFor(() => expect(harness.write).toHaveBeenCalledWith(SESSION_ID, 'pwd\r'))

    const payload = 'x'.repeat(70_000)
    runtime.writeTerminalInput(TAB_ID, payload)
    await vi.waitFor(() => expect(harness.write).toHaveBeenCalledTimes(4))
    const sent = harness.write.mock.calls
      .slice(1)
      .map(([, data]) => data)
      .join('')
    expect(sent).toBe(payload)
    expect(
      harness.write.mock.calls.slice(1).every(([, data]) => (data as string).length <= 32 * 1024),
    ).toBe(true)
    expect(JSON.stringify(useTerminalStore.getState())).not.toContain('xxxxx')

    useTerminalStore.getState().applySnapshot(TAB_ID, {
      ...openSnapshot(SESSION_ID, { cols: 80, rows: 24 }),
      status: 'closed',
    })
    runtime.writeTerminalInput(TAB_ID, 'ls\r')
    await Promise.resolve()
    expect(harness.write).toHaveBeenCalledTimes(4)
  })

  it('inserts without a newline after queued input and flushes the queue', async () => {
    const harness = createTerminalHarness()
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)
    useTerminalStore
      .getState()
      .applySnapshot(TAB_ID, openSnapshot(SESSION_ID, { cols: 80, rows: 24 }))

    runtime.writeTerminalInput(TAB_ID, 'echo typed')
    const inserted = await runtime.insertTerminalInput(TAB_ID, SESSION_ID, 'df -h')
    expect(inserted).toBe(true)
    await runtime.flushTerminalInput(TAB_ID)

    expect(harness.write.mock.calls.map(([, data]) => data)).toEqual(['echo typed', 'df -h'])
    expect(JSON.stringify(harness.write.mock.calls)).not.toContain('\\r')

    const mismatched = await runtime.insertTerminalInput(TAB_ID, OTHER_SESSION_ID, 'whoami')
    expect(mismatched).toBe(false)
    await Promise.resolve()
    expect(harness.write).toHaveBeenCalledTimes(2)
  })

  it('waits for the active input queue before reporting a flush', async () => {
    const harness = createTerminalHarness()
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)
    useTerminalStore
      .getState()
      .applySnapshot(TAB_ID, openSnapshot(SESSION_ID, { cols: 80, rows: 24 }))

    const release: { current: (() => void) | null } = { current: null }
    harness.write.mockImplementationOnce(
      (sessionId: string) =>
        new Promise((resolve) => {
          release.current = () => resolve(ok({ sessionId }))
        }),
    )

    runtime.writeTerminalInput(TAB_ID, 'queued')
    let flushed = false
    const flush = runtime.flushTerminalInput(TAB_ID).then(() => {
      flushed = true
    })
    await Promise.resolve()
    expect(harness.write).toHaveBeenCalledWith(SESSION_ID, 'queued')
    expect(flushed).toBe(false)

    release.current?.()
    await flush
    expect(flushed).toBe(true)
  })

  it('sends valid resize values once and rejects invalid or swapped sizes', async () => {
    const harness = createTerminalHarness()
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)
    useTerminalStore
      .getState()
      .applySnapshot(TAB_ID, openSnapshot(SESSION_ID, { cols: 80, rows: 24 }))

    runtime.resizeTerminalShell(TAB_ID, { cols: 120, rows: 40 })
    runtime.resizeTerminalShell(TAB_ID, { cols: 120, rows: 40 })
    await vi.waitFor(() =>
      expect(harness.resize).toHaveBeenCalledWith(SESSION_ID, { cols: 120, rows: 40 }),
    )
    expect(harness.resize).toHaveBeenCalledTimes(1)

    for (const size of [
      { cols: 0, rows: 40 },
      { cols: 120, rows: 0 },
      { cols: -5, rows: 40 },
      { cols: 1.5, rows: 40 },
      { cols: Number.NaN, rows: 40 },
      { cols: 2_001, rows: 40 },
      { cols: 120, rows: 1_001 },
    ]) {
      runtime.resizeTerminalShell(TAB_ID, size)
    }
    await Promise.resolve()
    expect(harness.resize).toHaveBeenCalledTimes(1)

    useTerminalStore.getState().applySnapshot(TAB_ID, {
      ...openSnapshot(SESSION_ID, { cols: 120, rows: 40 }),
      status: 'closed',
    })
    runtime.resizeTerminalShell(TAB_ID, { cols: 100, rows: 30 })
    await Promise.resolve()
    expect(harness.resize).toHaveBeenCalledTimes(1)
  })

  it('closes the shell, syncs authority and clears renderer state when forgotten', async () => {
    const harness = createTerminalHarness()
    const { runtime, useTerminalStore } = await loadTerminalModules()
    runtime.bindTerminalTab(TAB_ID, SESSION_ID)
    const release = runtime.attachTerminalRuntime()
    useTerminalStore
      .getState()
      .applySnapshot(TAB_ID, openSnapshot(SESSION_ID, { cols: 80, rows: 24 }))
    harness.emitOutput({ sessionId: SESSION_ID, data: 'logout\r\n' })

    await runtime.closeTerminalShell(TAB_ID)
    expect(harness.close).toHaveBeenCalledWith(SESSION_ID)
    expect(useTerminalStore.getState().shells[TAB_ID]?.status).toBe('closed')

    runtime.forgetTerminalTab(TAB_ID)
    expect(useTerminalStore.getState().shells[TAB_ID]).toBeUndefined()
    expect(runtime.getTerminalTranscript(TAB_ID)).toBe('')

    harness.emitOutput({ sessionId: SESSION_ID, data: 'late' })
    harness.emitStatus(openSnapshot(SESSION_ID, { cols: 80, rows: 24 }))
    expect(useTerminalStore.getState().shells[TAB_ID]).toBeUndefined()
    expect(runtime.getTerminalTranscript(TAB_ID)).toBe('')
    release()
  })
})
