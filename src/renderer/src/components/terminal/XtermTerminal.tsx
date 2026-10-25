import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import type { ISearchOptions } from '@xterm/addon-search'
import { LoaderCircle, RotateCw, ShieldAlert, SquareTerminal } from 'lucide-react'
import { TERMINAL_FONT_FAMILIES } from '@shared/constants'
import type { TerminalFontFamilyId } from '@shared/constants'
import type { TerminalExitInfo, TerminalShellSnapshot, TerminalSize } from '@shared/types'
import { DEFAULT_TERMINAL_SIZE } from '@shared/types'
import { Button } from '@renderer/components/common/Button'
import { TerminalSearchBar } from '@renderer/components/terminal/TerminalSearchBar'
import {
  clearTerminalTranscript,
  ensureTerminalShell,
  getTerminalTranscript,
  readTerminalClipboard,
  resizeTerminalShell,
  subscribeTerminalOutput,
  writeTerminalInput,
} from '@renderer/services/terminalRuntime'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import {
  registerTerminalToolController,
  useTerminalToolStore,
} from '@renderer/stores/terminalToolStore'
import type { TerminalCopyResult, TerminalPasteResult } from '@renderer/stores/terminalToolStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'

interface XtermTerminalProps {
  /** Stable workspace tab ID. Terminal state and transcripts are keyed by it. */
  tabId: string
  active: boolean
  /** Changes whenever reconnect binds a new main-process SSH session. */
  generation: number
  sshConnected: boolean
}

const FINAL_STATUSES = new Set<TerminalShellSnapshot['status']>(['closed', 'exited', 'error'])

const SEARCH_DECORATIONS = {
  matchBackground: '#2c3a63',
  matchBorder: '#8c9bff',
  matchOverviewRuler: '#8c9bff',
  activeMatchBackground: '#8a6a24',
  activeMatchBorder: '#f0b85e',
  activeMatchColorOverviewRuler: '#f0b85e',
} as const

function searchOptions(caseSensitive: boolean, incremental: boolean): ISearchOptions {
  return { caseSensitive, incremental, decorations: SEARCH_DECORATIONS }
}

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim()
  return value || fallback
}

function readTerminalTheme(): ITheme {
  if (typeof document === 'undefined') return {}
  const styles = getComputedStyle(document.documentElement)
  return {
    background: cssVar(styles, '--tf-terminal-background', '#0a0e17'),
    foreground: cssVar(styles, '--tf-terminal-foreground', '#c9d4e8'),
    cursor: cssVar(styles, '--tf-terminal-cursor', '#8b9cff'),
    cursorAccent: cssVar(styles, '--tf-terminal-cursor-accent', '#0a0e17'),
    selectionBackground: cssVar(styles, '--tf-terminal-selection', 'rgba(109, 124, 255, 0.34)'),
    black: cssVar(styles, '--tf-terminal-black', '#141a26'),
    red: cssVar(styles, '--tf-terminal-red', '#f0717d'),
    green: cssVar(styles, '--tf-terminal-green', '#4cc9a0'),
    yellow: cssVar(styles, '--tf-terminal-yellow', '#f0b85e'),
    blue: cssVar(styles, '--tf-terminal-blue', '#8b9cff'),
    magenta: cssVar(styles, '--tf-terminal-magenta', '#c89bf5'),
    cyan: cssVar(styles, '--tf-terminal-cyan', '#5fe0d6'),
    white: cssVar(styles, '--tf-terminal-white', '#c9d4e8'),
    brightBlack: cssVar(styles, '--tf-terminal-bright-black', '#5a687a'),
    brightRed: cssVar(styles, '--tf-terminal-bright-red', '#ff8b96'),
    brightGreen: cssVar(styles, '--tf-terminal-bright-green', '#6fe3b8'),
    brightYellow: cssVar(styles, '--tf-terminal-bright-yellow', '#ffd08a'),
    brightBlue: cssVar(styles, '--tf-terminal-bright-blue', '#a5b2ff'),
    brightMagenta: cssVar(styles, '--tf-terminal-bright-magenta', '#ddb8fa'),
    brightCyan: cssVar(styles, '--tf-terminal-bright-cyan', '#85ece3'),
    brightWhite: cssVar(styles, '--tf-terminal-bright-white', '#f1f6fc'),
  }
}

function terminalFontFamily(id: TerminalFontFamilyId): string {
  return TERMINAL_FONT_FAMILIES[id] ?? TERMINAL_FONT_FAMILIES.cascadia
}

function isValidSize(size: TerminalSize | null): size is TerminalSize {
  return (
    size !== null &&
    Number.isInteger(size.cols) &&
    Number.isInteger(size.rows) &&
    size.cols > 0 &&
    size.rows > 0
  )
}

function exitSummary(exit: TerminalExitInfo | null): string {
  if (!exit) return '远程 Shell 已关闭。'
  if (exit.signal) return `Shell 被信号 ${exit.signal} 终止。`
  if (exit.code !== null) return `远程 Shell 已退出，退出码 ${exit.code}。`
  if (exit.reason === 'ssh-closed') return 'SSH 连接已关闭，远程 Shell 已终止。'
  return '远程 Shell 已关闭。'
}

function ShellStateOverlay({
  snapshot,
  onReopen,
}: {
  snapshot: TerminalShellSnapshot | undefined
  onReopen: () => void
}) {
  const status = snapshot?.status ?? 'idle'

  if (status === 'open') return null

  if (status === 'idle' || status === 'opening' || status === 'closing') {
    const label =
      status === 'closing' ? '正在关闭远程 Shell…' : '正在打开远程 Shell（xterm-256color）…'
    return (
      <div className="terminal-shell-overlay" role="status" aria-live="polite">
        <div className="terminal-shell-overlay__busy">
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
          <span>{label}</span>
        </div>
      </div>
    )
  }

  const danger = status === 'error'
  return (
    <div className="terminal-shell-overlay">
      <section
        className={
          danger
            ? 'terminal-shell-overlay__card terminal-shell-overlay__card--danger'
            : 'terminal-shell-overlay__card'
        }
        aria-live="polite"
        aria-label="远程 Shell 状态"
      >
        <span className="terminal-shell-overlay__icon" aria-hidden="true">
          {danger ? <ShieldAlert size={18} /> : <SquareTerminal size={18} />}
        </span>
        <h4 className="terminal-shell-overlay__title">
          {status === 'exited' ? '远程 Shell 已退出' : '远程 Shell 已关闭'}
        </h4>
        <p className="terminal-shell-overlay__description">
          {danger
            ? (snapshot?.failure?.message ?? '远程 Shell 发生错误。')
            : (snapshot?.failure?.message ?? exitSummary(snapshot?.exit ?? null))}
        </p>
        <p className="terminal-shell-overlay__meta">
          SSH 连接仍然保留；重新打开会在同一会话上创建新的 PTY，不会新建 SSH 连接。
        </p>
        <Button variant="primary" size="sm" onClick={onReopen}>
          <RotateCw size={13} aria-hidden="true" />
          重新打开 Shell
        </Button>
        <span className="terminal-shell-overlay__session" title="SSH 会话 ID">
          {snapshot?.sessionId}
        </span>
      </section>
    </div>
  )
}

export function XtermTerminal({ tabId, active, generation, sshConnected }: XtermTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mountRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const scheduleFitRef = useRef<() => void>(() => {})
  const previousStatusRef = useRef<TerminalShellSnapshot['status'] | null>(null)
  const sshConnectedRef = useRef(sshConnected)
  const shellOpenRef = useRef(false)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchCaseRef = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchResults, setSearchResults] = useState({ index: -1, count: 0 })
  const snapshot = useTerminalStore((state) => state.shells[tabId])
  const shellStatus = snapshot?.status ?? 'idle'
  shellOpenRef.current = shellStatus === 'open'
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme)
  const resolvedStyle = useSettingsStore((state) => state.resolvedStyle)
  const fontSize = useSettingsStore((state) => state.terminalFontSize)
  const fontFamilyId = useSettingsStore((state) => state.terminalFontFamily)
  const cursorStyle = useSettingsStore((state) => state.terminalCursorStyle)
  const cursorBlink = useSettingsStore((state) => state.terminalCursorBlink)
  const scrollback = useSettingsStore((state) => state.terminalScrollback)

  useEffect(() => {
    sshConnectedRef.current = sshConnected
  }, [sshConnected])

  useEffect(() => {
    const host = hostRef.current
    const mount = mountRef.current
    if (!host || !mount) return

    setSearchOpen(false)
    setSearchQuery('')
    setSearchCaseSensitive(false)
    setSearchResults({ index: -1, count: 0 })

    const preferences = useSettingsStore.getState()
    const term = new Terminal({
      // SearchAddon highlights matches through registerDecoration(), which is
      // gated behind xterm's proposed API. xterm is pinned, so the surface is stable.
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: preferences.terminalCursorBlink,
      cursorStyle: preferences.terminalCursorStyle,
      fontFamily: terminalFontFamily(preferences.terminalFontFamily),
      fontSize: preferences.terminalFontSize,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: preferences.terminalScrollback,
      rightClickSelectsWord: true,
      theme: readTerminalTheme(),
      allowTransparency: false,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    searchAddonRef.current = searchAddon
    // FitAddon measures the direct parent of `.xterm`. Mounting into the
    // unpadded inner box keeps the host's visual padding out of that
    // measurement; otherwise the last row spills past the clipped pane edge.
    term.open(mount)
    terminalRef.current = term

    const transcript = getTerminalTranscript(tabId)
    if (transcript) term.write(transcript)

    const unsubscribeOutput = subscribeTerminalOutput(tabId, (data) => {
      if (terminalRef.current === term) term.write(data)
    })
    const dataDisposable = term.onData((data) => {
      if (!sshConnectedRef.current || !shellOpenRef.current) return
      writeTerminalInput(tabId, data)
    })
    const selectionDisposable = term.onSelectionChange(() => {
      useTerminalToolStore.getState().setSelection(tabId, term.hasSelection())
    })
    const searchResultsDisposable = searchAddon.onDidChangeResults(
      ({ resultIndex, resultCount }) => {
        setSearchResults({ index: resultIndex, count: resultCount })
      },
    )

    const copySelection = async (): Promise<TerminalCopyResult> => {
      const selection = term.getSelection()
      if (!selection) return 'empty'
      if (!navigator.clipboard?.writeText) return 'failed'
      try {
        await navigator.clipboard.writeText(selection)
        return 'copied'
      } catch {
        return 'failed'
      }
    }

    const pasteClipboard = async (): Promise<TerminalPasteResult> => {
      if (!sshConnectedRef.current || !shellOpenRef.current) return 'failed'
      const text = await readTerminalClipboard()
      if (text === null) return 'failed'
      if (text.length === 0) return 'empty'
      if (terminalRef.current !== term || !sshConnectedRef.current || !shellOpenRef.current) {
        return 'failed'
      }
      term.paste(text)
      return 'pasted'
    }

    const resetSearch = (): void => {
      searchAddon.clearDecorations()
      setSearchOpen(false)
      setSearchQuery('')
      setSearchResults({ index: -1, count: 0 })
    }

    const clearBuffer = (): void => {
      term.clear()
      term.clearSelection()
      clearTerminalTranscript(tabId)
      resetSearch()
      term.focus()
    }

    const openSearch = (): void => {
      const selection = term.getSelection().trim()
      if (selection.length > 0 && selection.length <= 200 && !selection.includes('\n')) {
        setSearchQuery(selection)
      }
      setSearchOpen(true)
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.altKey || !event.shiftKey || !(event.ctrlKey || event.metaKey)) return true
      const key = event.key.toLowerCase()
      if (key === 'c') {
        event.preventDefault()
        void copySelection()
        return false
      }
      if (key === 'v') {
        event.preventDefault()
        void pasteClipboard()
        return false
      }
      if (key === 'f') {
        event.preventDefault()
        openSearch()
        return false
      }
      return true
    })

    const unregisterControls = registerTerminalToolController(tabId, {
      copySelection,
      pasteClipboard,
      clearBuffer,
      openSearch,
    })

    let fitTimer: ReturnType<typeof setTimeout> | null = null
    const fitNow = (): void => {
      if (terminalRef.current !== term) return
      if (host.clientWidth < 40 || host.clientHeight < 40) return
      try {
        fitAddon.fit()
      } catch {
        return
      }
      const size = { cols: term.cols, rows: term.rows }
      if (isValidSize(size)) resizeTerminalShell(tabId, size)
    }
    const scheduleFit = (): void => {
      if (fitTimer) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        fitTimer = null
        fitNow()
      }, 60)
    }
    scheduleFitRef.current = scheduleFit

    if (host.clientWidth >= 40 && host.clientHeight >= 40) {
      try {
        fitAddon.fit()
      } catch {
        // The renderer may not have measured cell sizes yet; ResizeObserver retries.
      }
    }
    if (sshConnectedRef.current) {
      const initialSize = isValidSize({ cols: term.cols, rows: term.rows })
        ? { cols: term.cols, rows: term.rows }
        : { ...DEFAULT_TERMINAL_SIZE }
      void ensureTerminalShell(tabId, initialSize)
    }

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => scheduleFit())
    observer?.observe(host)

    return () => {
      observer?.disconnect()
      if (fitTimer) clearTimeout(fitTimer)
      scheduleFitRef.current = () => {}
      unregisterControls()
      searchResultsDisposable.dispose()
      selectionDisposable.dispose()
      useTerminalToolStore.getState().forgetTab(tabId)
      searchAddonRef.current = null
      dataDisposable.dispose()
      unsubscribeOutput()
      terminalRef.current = null
      term.dispose()
      // A component unmount (tab switch, module switch, StrictMode replay) must
      // not close the PTY; the main process keeps the shell until SSH disconnects
      // or the user explicitly closes it.
    }
  }, [tabId, generation])

  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    const previous = previousStatusRef.current
    if (shellStatus === 'opening' && previous !== null && FINAL_STATUSES.has(previous)) {
      term.reset()
    }
    previousStatusRef.current = shellStatus
  }, [shellStatus])

  useEffect(() => {
    if (!active || !sshConnected) return
    scheduleFitRef.current()
    const frame = requestAnimationFrame(() => {
      scheduleFitRef.current()
      if (shellStatus === 'open') terminalRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, shellStatus, sshConnected])

  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    const frame = requestAnimationFrame(() => {
      if (terminalRef.current !== term) return
      term.options.fontSize = fontSize
      term.options.fontFamily = terminalFontFamily(fontFamilyId)
      term.options.cursorStyle = cursorStyle
      term.options.cursorBlink = cursorBlink
      term.options.scrollback = scrollback
      term.options.theme = readTerminalTheme()
      scheduleFitRef.current()
    })
    return () => cancelAnimationFrame(frame)
  }, [fontSize, fontFamilyId, cursorStyle, cursorBlink, scrollback, resolvedTheme, resolvedStyle])

  useEffect(() => {
    if (!searchOpen) return
    const addon = searchAddonRef.current
    if (!addon) return
    if (!searchQuery) {
      addon.clearDecorations()
      terminalRef.current?.clearSelection()
      setSearchResults({ index: -1, count: 0 })
      return
    }
    // addon-search records the new options before checking whether they changed,
    // so a lone Aa toggle keeps the previous highlight count until decorations reset.
    if (searchCaseRef.current !== searchCaseSensitive) addon.clearDecorations()
    searchCaseRef.current = searchCaseSensitive
    addon.findNext(searchQuery, searchOptions(searchCaseSensitive, true))
  }, [searchOpen, searchQuery, searchCaseSensitive])

  useEffect(() => {
    if (!searchOpen) return
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [searchOpen])

  const closeSearch = (): void => {
    searchAddonRef.current?.clearDecorations()
    setSearchOpen(false)
    setSearchResults({ index: -1, count: 0 })
    terminalRef.current?.focus()
  }

  const findNextMatch = (): void => {
    const addon = searchAddonRef.current
    if (!addon || !searchQuery) return
    addon.findNext(searchQuery, searchOptions(searchCaseSensitive, false))
  }

  const findPreviousMatch = (): void => {
    const addon = searchAddonRef.current
    if (!addon || !searchQuery) return
    addon.findPrevious(searchQuery, searchOptions(searchCaseSensitive, false))
  }

  const reopen = (): void => {
    if (!sshConnectedRef.current) return
    const term = terminalRef.current
    const size =
      term && isValidSize({ cols: term.cols, rows: term.rows })
        ? { cols: term.cols, rows: term.rows }
        : (snapshot?.size ?? { ...DEFAULT_TERMINAL_SIZE })
    term?.reset()
    void ensureTerminalShell(tabId, size)
  }

  return (
    <div className="terminal-shell">
      <div
        ref={hostRef}
        className="terminal-xterm"
        data-testid="terminal-xterm"
        aria-label="交互式 SSH 终端"
      >
        <div ref={mountRef} className="terminal-xterm__mount" />
      </div>
      {searchOpen ? (
        <TerminalSearchBar
          query={searchQuery}
          caseSensitive={searchCaseSensitive}
          resultIndex={searchResults.index}
          resultCount={searchResults.count}
          inputRef={searchInputRef}
          onQueryChange={setSearchQuery}
          onNext={findNextMatch}
          onPrevious={findPreviousMatch}
          onToggleCase={() => setSearchCaseSensitive((current) => !current)}
          onClose={closeSearch}
        />
      ) : null}
      {sshConnected ? <ShellStateOverlay snapshot={snapshot} onReopen={reopen} /> : null}
    </div>
  )
}
