import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OperationResult,
  QuickCommandExecuteAck,
  QuickCommandExecuteInput,
  TerminalAck,
  TerminalShellSnapshot,
} from '@shared/types'
import { DEFAULT_TERMINAL_SIZE } from '@shared/types'
import { useQuickCommandStore } from '@renderer/stores/quickCommandStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import {
  bindTerminalTab,
  resetTerminalSessions,
  writeTerminalInput,
} from '@renderer/services/terminalRuntime'
import { createFakeBridge, fakeSessionInfo } from './helpers/fakeBridge'

const TAB_ID = 'sshtab-test'
const SESSION_ID = 'ssh-test-session'

function openShell(sessionId = SESSION_ID): TerminalShellSnapshot {
  return {
    sessionId,
    status: 'open',
    size: { ...DEFAULT_TERMINAL_SIZE },
    failure: null,
    exit: null,
  }
}

function readyTargets(): void {
  useSessionStore.setState({
    sessions: {
      [TAB_ID]: fakeSessionInfo({ id: TAB_ID, sessionId: SESSION_ID, status: 'connected' }),
    },
  })
  useTerminalStore.setState({ shells: { [TAB_ID]: openShell() } })
  useWorkspaceStore.setState({ activeTabId: TAB_ID, tabOrder: [TAB_ID] })
}

function ack(): QuickCommandExecuteAck {
  return {
    requestId: 'req-test',
    body: 'uptime',
    writtenAt: '2026-10-23T08:00:00.000Z',
    historyRecorded: false,
    historyWarning: null,
  }
}

describe('quick command store', () => {
  beforeEach(() => {
    resetTerminalSessions()
    useQuickCommandStore.getState().reset()
    useSessionStore.setState({ sessions: {} })
    useTerminalStore.setState({ shells: {} })
    useWorkspaceStore.setState({ activeTabId: null, tabOrder: [] })
    useSettingsStore.setState({ commandHistoryEnabled: false })
    window.termforge = createFakeBridge()
  })

  it('captures the active connected terminal when the drawer opens without switching tabs', () => {
    readyTargets()
    useWorkspaceStore.setState({ activeTabId: TAB_ID, tabOrder: [TAB_ID] })

    useQuickCommandStore.getState().openDrawer()

    expect(useQuickCommandStore.getState().capturedTarget).toEqual({
      tabId: TAB_ID,
      sessionId: SESSION_ID,
    })
    expect(useWorkspaceStore.getState().activeTabId).toBe(TAB_ID)
    expect(useWorkspaceStore.getState().tabOrder).toEqual([TAB_ID])
  })

  it('captures no target when the active tab is disconnected or has no open shell', () => {
    readyTargets()
    useSessionStore.setState({
      sessions: {
        [TAB_ID]: fakeSessionInfo({ id: TAB_ID, sessionId: SESSION_ID, status: 'disconnected' }),
      },
    })

    useQuickCommandStore.getState().openDrawer(TAB_ID)
    expect(useQuickCommandStore.getState().capturedTarget).toBeNull()

    readyTargets()
    useTerminalStore.setState({ shells: { [TAB_ID]: { ...openShell(), status: 'closed' } } })
    useQuickCommandStore.getState().openDrawer(TAB_ID)
    expect(useQuickCommandStore.getState().capturedTarget).toBeNull()
  })

  it('refuses to execute when the session or shell no longer matches the requested target', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, value: ack() }))
    window.termforge = createFakeBridge(
      {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
      { execute },
    )
    readyTargets()

    const result = await useQuickCommandStore.getState().executeQuickCommand({
      kind: 'history',
      requestId: 'req-target-1',
      body: 'uptime',
      tabId: TAB_ID,
      sessionId: 'ssh-old-session',
      recordHistory: false,
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('flushes queued terminal input before asking the main process to write', async () => {
    const release: { current: (() => void) | null } = { current: null }
    const write = vi.fn(
      (sessionId: string, _data: string) =>
        new Promise<OperationResult<TerminalAck>>((resolve) => {
          release.current = () => resolve({ ok: true, value: { sessionId } })
        }),
    )
    const execute = vi.fn(async (_input: QuickCommandExecuteInput) => ({
      ok: true as const,
      value: ack(),
    }))
    window.termforge = createFakeBridge(
      {}, {}, { write }, {}, {}, {}, {}, {}, {}, {}, {},
      { execute },
    )
    readyTargets()
    bindTerminalTab(TAB_ID, SESSION_ID)

    writeTerminalInput(TAB_ID, 'typed-but-not-submitted')
    const sending = useQuickCommandStore.getState().executeQuickCommand({
      kind: 'history',
      requestId: 'req-order-1',
      body: 'uptime',
      tabId: TAB_ID,
      sessionId: SESSION_ID,
      recordHistory: false,
    })

    await Promise.resolve()
    expect(write).toHaveBeenCalledWith(SESSION_ID, 'typed-but-not-submitted')
    expect(execute).not.toHaveBeenCalled()

    release.current?.()
    await sending
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      kind: 'history',
      body: 'uptime',
      tabId: TAB_ID,
      sessionId: SESSION_ID,
    })
  })

  it('rejects insert writes whose expected session was replaced', async () => {
    const write = vi.fn(async (sessionId: string) => ({ ok: true as const, value: { sessionId } }))
    window.termforge = createFakeBridge({}, {}, { write })
    readyTargets()
    bindTerminalTab(TAB_ID, SESSION_ID)

    const result = await useQuickCommandStore
      .getState()
      .insertQuickCommand(TAB_ID, 'ssh-old-session', 'df -h')

    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(write).not.toHaveBeenCalled()
  })
})
