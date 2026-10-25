import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OperationResult,
  TerminalExitEvent,
  TerminalOpenResult,
  TerminalOutputEvent,
  TerminalShellSnapshot,
  TerminalSize,
  TerminalStatusEvent,
} from '@shared/types'
import { DEFAULT_TERMINAL_SIZE } from '@shared/types'
import { DEFAULT_APP_PREFERENCES, TERMINAL_FONT_FAMILIES } from '@shared/constants'
import { useSettingsStore } from '../../src/renderer/src/stores/settingsStore'
import { createFakeBridge } from './helpers/fakeBridge'

const xtermMock = vi.hoisted(() => {
  const state = {
    terminals: [] as FakeTerminal[],
    searchAddons: [] as FakeSearchAddon[],
    nextCols: 100,
    nextRows: 30,
    fitCalls: 0,
  }

  class FakeTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    writes: string[] = []
    resets = 0
    focused = 0
    disposed = false
    cleared = 0
    selection = ''
    pasted: string[] = []
    addons: unknown[] = []
    dataListener: ((data: string) => void) | null = null
    selectionListeners = new Set<() => void>()
    customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
    openTarget: HTMLElement | null = null

    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options }
      state.terminals.push(this)
    }

    loadAddon(addon: unknown): void {
      this.addons.push(addon)
    }
    open(element?: HTMLElement): void {
      this.openTarget = element ?? null
    }
    write(data: string): void {
      this.writes.push(data)
    }
    reset(): void {
      this.resets += 1
      this.writes = []
    }
    clear(): void {
      this.cleared += 1
    }
    focus(): void {
      this.focused += 1
    }
    paste(data: string): void {
      this.pasted.push(data)
    }
    dispose(): void {
      this.disposed = true
    }
    hasSelection(): boolean {
      return this.selection.length > 0
    }
    getSelection(): string {
      return this.selection
    }
    select(text: string): void {
      this.selection = text
      for (const listener of this.selectionListeners) listener()
    }
    clearSelection(): void {
      this.selection = ''
      for (const listener of this.selectionListeners) listener()
    }
    onSelectionChange(listener: () => void) {
      this.selectionListeners.add(listener)
      return { dispose: () => this.selectionListeners.delete(listener) }
    }
    onData(listener: (data: string) => void) {
      this.dataListener = listener
      return {
        dispose: () => {
          this.dataListener = null
        },
      }
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.customKeyHandler = handler
    }
    emitKey(event: KeyboardEvent): boolean {
      return this.customKeyHandler ? this.customKeyHandler(event) : true
    }
    emitData(data: string): void {
      this.dataListener?.(data)
    }
  }

  class FakeFitAddon {
    fit(): void {
      state.fitCalls += 1
      const term = state.terminals.at(-1)
      if (!term) return
      term.cols = state.nextCols
      term.rows = state.nextRows
    }
  }

  interface SearchResult {
    resultIndex: number
    resultCount: number
  }

  class FakeSearchAddon {
    calls: Array<{
      query: string
      direction: 'next' | 'previous'
      options: Record<string, unknown>
    }> = []
    decorationsCleared = 0
    listeners = new Set<(result: SearchResult) => void>()

    constructor() {
      state.searchAddons.push(this)
    }

    findNext(query: string, options: Record<string, unknown> = {}): boolean {
      this.calls.push({ query, direction: 'next', options })
      return true
    }
    findPrevious(query: string, options: Record<string, unknown> = {}): boolean {
      this.calls.push({ query, direction: 'previous', options })
      return true
    }
    clearDecorations(): void {
      this.decorationsCleared += 1
    }
    onDidChangeResults(listener: (result: SearchResult) => void) {
      this.listeners.add(listener)
      return { dispose: () => this.listeners.delete(listener) }
    }
    emitResults(result: SearchResult): void {
      for (const listener of this.listeners) listener(result)
    }
  }

  return { state, FakeTerminal, FakeFitAddon, FakeSearchAddon }
})

vi.mock('@xterm/xterm', () => ({ Terminal: xtermMock.FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xtermMock.FakeFitAddon }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: xtermMock.FakeSearchAddon }))

import { XtermTerminal } from '../../src/renderer/src/components/terminal/XtermTerminal'
import * as terminalRuntime from '../../src/renderer/src/services/terminalRuntime'
import {
  getTerminalToolController,
  useTerminalToolStore,
} from '../../src/renderer/src/stores/terminalToolStore'
import { useTerminalStore } from '../../src/renderer/src/stores/terminalStore'

const SESSION_ID = 'ssh-session-1'
const TAB_ID = 'sshtab-1'

const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
const originalResizeObserver = globalThis.ResizeObserver

let resizeCallback: ResizeObserverCallback | null = null
let releaseRuntime: (() => void) | null = null
const clipboardWrite = vi.fn(async (_text: string) => {})

function ok<T>(value: T): OperationResult<T> {
  return { ok: true, value }
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

function createAttachedHarness() {
  const harness = createComponentHarness()
  releaseRuntime = terminalRuntime.attachTerminalRuntime()
  return harness
}

function createComponentHarness() {
  let current = idleSnapshot(SESSION_ID)
  const outputListeners = new Set<(event: TerminalOutputEvent) => void>()
  const statusListeners = new Set<(event: TerminalStatusEvent) => void>()
  const exitListeners = new Set<(event: TerminalExitEvent) => void>()

  function emitStatus(snapshot: TerminalShellSnapshot): void {
    current = snapshot
    for (const listener of [...statusListeners]) listener(snapshot)
  }

  const open = vi.fn(async (sessionId: string, size: TerminalSize) => {
    emitStatus({
      sessionId,
      status: 'opening',
      size: { ...size },
      failure: null,
      exit: null,
    })
    const snapshot: TerminalShellSnapshot = {
      sessionId,
      status: 'open',
      size: { ...size },
      failure: null,
      exit: null,
    }
    emitStatus(snapshot)
    return ok<TerminalOpenResult>({ sessionId, status: 'open', size, reused: false })
  })
  const resize = vi.fn(async (sessionId: string, _size: TerminalSize) => ok({ sessionId }))
  const write = vi.fn(async (sessionId: string, _data: string) => ok({ sessionId }))
  const close = vi.fn(async (sessionId: string) => ok({ sessionId }))
  const readClipboard = vi.fn(async () => ok(''))

  window.termforge = createFakeBridge(
    {},
    {},
    {
      getStatus: async (sessionId) => ok({ ...current, sessionId }),
      open,
      resize,
      write,
      close,
      readClipboard,
      onOutput: (listener) => {
        outputListeners.add(listener)
        return () => outputListeners.delete(listener)
      },
      onStatus: (listener) => {
        statusListeners.add(listener)
        return () => statusListeners.delete(listener)
      },
      onExit: (listener) => {
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      },
    },
  )

  return {
    open,
    resize,
    write,
    close,
    readClipboard,
    emitStatus,
    emitOutput: (event: TerminalOutputEvent) => {
      for (const listener of [...outputListeners]) listener(event)
    },
    emitExit: (event: TerminalExitEvent) => {
      for (const listener of [...exitListeners]) listener(event)
    },
    statusListenerCount: () => statusListeners.size,
    outputListenerCount: () => outputListeners.size,
  }
}

beforeEach(() => {
  useSettingsStore.setState({
    ...DEFAULT_APP_PREFERENCES,
    resolvedTheme: 'dark',
    status: 'ready',
    warnings: [],
    error: null,
  })
  useTerminalStore.getState().reset()
  useTerminalToolStore.getState().reset()
  terminalRuntime.resetTerminalSessions()
  xtermMock.state.terminals.length = 0
  xtermMock.state.searchAddons.length = 0
  xtermMock.state.nextCols = 100
  xtermMock.state.nextRows = 30
  xtermMock.state.fitCalls = 0
  resizeCallback = null
  clipboardWrite.mockReset()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  })

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList?.contains('terminal-xterm') ? 800 : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList?.contains('terminal-xterm') ? 600 : 0
    },
  })
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  releaseRuntime?.()
  releaseRuntime = null
})

afterAll(() => {
  if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthDescriptor)
  if (heightDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', heightDescriptor)
  globalThis.ResizeObserver = originalResizeObserver
})

describe('XtermTerminal component', () => {
  it('opens a shell on mount, streams output and input, and leaves the PTY open on unmount', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    const view = render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)

    await vi.waitFor(() =>
      expect(harness.open).toHaveBeenCalledWith(SESSION_ID, { cols: 100, rows: 30 }),
    )
    const term = xtermMock.state.terminals[0]!
    expect(term.options.convertEol).toBe(false)
    expect(term.options.allowProposedApi).toBe(true)

    act(() => harness.emitOutput({ sessionId: SESSION_ID, data: '\u001b[32mhello\u001b[0m\r\n' }))
    expect(term.writes).toContain('\u001b[32mhello\u001b[0m\r\n')

    act(() => term.emitData('pwd\r'))
    await vi.waitFor(() => expect(harness.write).toHaveBeenCalledWith(SESSION_ID, 'pwd\r'))

    view.unmount()
    expect(term.disposed).toBe(true)
    expect(harness.close).not.toHaveBeenCalled()
    expect(harness.outputListenerCount()).toBe(1)
  })

  it('applies persisted font, cursor and scrollback settings without recreating the PTY', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))

    const term = xtermMock.state.terminals[0]!
    expect(term.options).toMatchObject({
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5_000,
      fontFamily: TERMINAL_FONT_FAMILIES.cascadia,
    })

    const fitCallsBefore = xtermMock.state.fitCalls
    act(() =>
      useSettingsStore.setState({
        terminalFontFamily: 'jetbrains',
        terminalFontSize: 16,
        terminalCursorStyle: 'underline',
        terminalCursorBlink: false,
        terminalScrollback: 10_000,
        resolvedTheme: 'light',
      }),
    )

    await vi.waitFor(() =>
      expect(term.options).toMatchObject({
        cursorBlink: false,
        cursorStyle: 'underline',
        scrollback: 10_000,
        fontSize: 16,
        fontFamily: TERMINAL_FONT_FAMILIES.jetbrains,
      }),
    )
    await vi.waitFor(() => expect(xtermMock.state.fitCalls).toBeGreaterThan(fitCallsBefore))
    expect(xtermMock.state.terminals).toHaveLength(1)
    expect(harness.open).toHaveBeenCalledTimes(1)
  })

  it('mounts xterm into an unpadded inner box so FitAddon measures the visible area', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))

    const host = screen.getByTestId('terminal-xterm')
    const mount = host.querySelector('.terminal-xterm__mount')
    expect(mount).not.toBeNull()
    expect(mount?.parentElement).toBe(host)
    expect(xtermMock.state.terminals[0]!.openTarget).toBe(mount)
  })

  it('fits the terminal through ResizeObserver and never sends zero dimensions', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))
    expect(resizeCallback).toBeTypeOf('function')
    harness.resize.mockClear()

    xtermMock.state.nextCols = 120
    xtermMock.state.nextRows = 40
    act(() => resizeCallback?.([], {} as ResizeObserver))
    await vi.waitFor(() =>
      expect(harness.resize).toHaveBeenCalledWith(SESSION_ID, { cols: 120, rows: 40 }),
    )

    const callsAfterValid = harness.resize.mock.calls.length
    xtermMock.state.nextCols = 0
    xtermMock.state.nextRows = 0
    act(() => resizeCallback?.([], {} as ResizeObserver))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(harness.resize).toHaveBeenCalledTimes(callsAfterValid)
    const invalid = harness.resize.mock.calls.some(([, size]) => size.cols <= 0 || size.rows <= 0)
    expect(invalid).toBe(false)

    xtermMock.state.nextCols = 130
    xtermMock.state.nextRows = 50
    act(() => resizeCallback?.([], {} as ResizeObserver))
    await vi.waitFor(() =>
      expect(harness.resize).toHaveBeenCalledWith(SESSION_ID, { cols: 130, rows: 50 }),
    )
  })

  it('keeps one PTY across StrictMode double effects and clears output when reopening', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    const view = render(
      <StrictMode>
        <XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />
      </StrictMode>,
    )

    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(xtermMock.state.terminals.length).toBe(2))
    expect(harness.close).not.toHaveBeenCalled()

    const first = xtermMock.state.terminals[0]!
    expect(first.disposed).toBe(true)
    const visible = xtermMock.state.terminals[1]!
    act(() => harness.emitOutput({ sessionId: SESSION_ID, data: 'before exit\r\n' }))
    expect(visible.writes.join('')).toContain('before exit')

    act(() =>
      harness.emitStatus({
        sessionId: SESSION_ID,
        status: 'exited',
        size: { cols: 100, rows: 30 },
        failure: null,
        exit: { code: 0, signal: null, reason: 'remote-exit' },
      }),
    )
    expect(await screen.findByText('远程 Shell 已退出')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /重新打开 Shell/ }))
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(2))
    expect(visible.resets).toBeGreaterThan(0)

    view.unmount()
    expect(harness.close).not.toHaveBeenCalled()
  })

  it('shows shell errors without closing the SSH transport and syncs runtime listeners', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    const view = render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))

    act(() =>
      harness.emitStatus({
        sessionId: SESSION_ID,
        status: 'error',
        size: { cols: 100, rows: 30 },
        failure: { code: 'shell-error', message: '远程 Shell 通道发生错误。' },
        exit: null,
      }),
    )
    expect(await screen.findByText('远程 Shell 通道发生错误。')).toBeInTheDocument()
    expect(harness.close).not.toHaveBeenCalled()
    expect(harness.statusListenerCount()).toBe(1)

    view.unmount()
    expect(harness.statusListenerCount()).toBe(1)
    expect(harness.outputListenerCount()).toBe(1)
  })

  it('tracks terminal selection, copies it, and leaves plain Ctrl+C to xterm', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    const view = render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))
    const term = xtermMock.state.terminals[0]!

    expect(useTerminalToolStore.getState().selection[TAB_ID] ?? false).toBe(false)
    act(() => term.select('echo hello'))
    expect(useTerminalToolStore.getState().selection[TAB_ID]).toBe(true)

    const controller = getTerminalToolController(TAB_ID)
    expect(controller).not.toBeNull()
    await expect(controller!.copySelection()).resolves.toBe('copied')
    expect(clipboardWrite).toHaveBeenCalledWith('echo hello')

    clipboardWrite.mockClear()
    act(() =>
      expect(
        term.emitKey(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true })),
      ).toBe(false),
    )
    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('echo hello'))
    expect(term.emitKey(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))).toBe(true)

    act(() => term.clearSelection())
    expect(useTerminalToolStore.getState().selection[TAB_ID]).toBe(false)

    view.unmount()
    expect(getTerminalToolController(TAB_ID)).toBeNull()
    expect(useTerminalToolStore.getState().selection[TAB_ID]).toBeUndefined()
  })

  it('pastes clipboard text into the PTY only while the shell is open', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))
    const term = xtermMock.state.terminals[0]!
    const controller = getTerminalToolController(TAB_ID)!

    harness.readClipboard.mockResolvedValueOnce(ok('ls -la\n'))
    await expect(controller.pasteClipboard()).resolves.toBe('pasted')
    expect(harness.readClipboard).toHaveBeenCalledTimes(1)
    expect(term.pasted).toEqual(['ls -la\n'])

    harness.readClipboard.mockResolvedValueOnce(ok(''))
    await expect(controller.pasteClipboard()).resolves.toBe('empty')

    harness.readClipboard.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unavailable', message: '剪贴板不可用。' },
    })
    await expect(controller.pasteClipboard()).resolves.toBe('failed')

    act(() =>
      harness.emitStatus({
        sessionId: SESSION_ID,
        status: 'exited',
        size: { cols: 100, rows: 30 },
        failure: null,
        exit: { code: 0, signal: null, reason: 'remote-exit' },
      }),
    )
    harness.readClipboard.mockResolvedValueOnce(ok('ignored'))
    await expect(controller.pasteClipboard()).resolves.toBe('failed')
    expect(term.pasted).toHaveLength(1)
    expect(harness.write).not.toHaveBeenCalled()
  })

  it('clears the local buffer and replay transcript without signaling the remote shell', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))
    const term = xtermMock.state.terminals[0]!
    act(() => harness.emitOutput({ sessionId: SESSION_ID, data: 'before-clear\r\n' }))
    expect(terminalRuntime.getTerminalTranscript(TAB_ID)).toContain('before-clear')
    act(() => term.select('before-clear'))
    const focusedBefore = term.focused

    act(() => getTerminalToolController(TAB_ID)!.clearBuffer())

    expect(term.cleared).toBe(1)
    expect(term.getSelection()).toBe('')
    expect(useTerminalToolStore.getState().selection[TAB_ID]).toBe(false)
    expect(term.focused).toBeGreaterThan(focusedBefore)
    expect(terminalRuntime.getTerminalTranscript(TAB_ID)).toBe('')
    expect(harness.write).not.toHaveBeenCalled()
    expect(harness.close).not.toHaveBeenCalled()
  })

  it('searches the scrollback, navigates matches, reports counts and closes on Escape', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))
    const addon = xtermMock.state.searchAddons[0]!

    act(() => getTerminalToolController(TAB_ID)!.openSearch())
    const input = await screen.findByRole('searchbox', { name: '查找内容' })
    fireEvent.change(input, { target: { value: 'error' } })
    await vi.waitFor(() => expect(addon.calls).toHaveLength(1))
    expect(addon.calls[0]).toMatchObject({
      query: 'error',
      direction: 'next',
      options: { incremental: true, caseSensitive: false },
    })

    act(() => addon.emitResults({ resultIndex: 1, resultCount: 3 }))
    expect(screen.getByText('2/3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一个匹配' }))
    expect(addon.calls.at(-1)).toMatchObject({
      direction: 'next',
      options: { incremental: false },
    })

    fireEvent.click(screen.getByRole('button', { name: '上一个匹配' }))
    expect(addon.calls.at(-1)).toMatchObject({
      direction: 'previous',
      options: { incremental: false },
    })

    const clearedBeforeToggle = addon.decorationsCleared
    fireEvent.click(screen.getByRole('button', { name: '区分大小写' }))
    await vi.waitFor(() =>
      expect(addon.calls.at(-1)).toMatchObject({
        direction: 'next',
        options: { caseSensitive: true },
      }),
    )
    expect(addon.decorationsCleared).toBeGreaterThan(clearedBeforeToggle)

    const clearedBefore = addon.decorationsCleared
    fireEvent.keyDown(input, { key: 'Escape' })
    await vi.waitFor(() => expect(screen.queryByRole('searchbox', { name: '查找内容' })).toBeNull())
    expect(addon.decorationsCleared).toBeGreaterThan(clearedBefore)
  })

  it('opens search with Ctrl+Shift+F and pre-fills a single-line selection', async () => {
    const harness = createAttachedHarness()
    terminalRuntime.bindTerminalTab(TAB_ID, SESSION_ID)
    render(<XtermTerminal tabId={TAB_ID} active generation={1} sshConnected />)
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1))
    const term = xtermMock.state.terminals[0]!

    act(() => term.select('needle'))
    act(() =>
      expect(
        term.emitKey(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true })),
      ).toBe(false),
    )
    const input = (await screen.findByRole('searchbox', {
      name: '查找内容',
    })) as HTMLInputElement
    expect(input.value).toBe('needle')
    expect(term.emitKey(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))).toBe(true)
  })
})
