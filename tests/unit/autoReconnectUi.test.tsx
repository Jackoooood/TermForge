import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { SessionAutoReconnect, SessionInfo } from '@shared/types'
import { TerminalWorkspace } from '@renderer/features/terminal/TerminalWorkspace'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge, fakeSessionInfo, fakeSshSnapshot } from './helpers/fakeBridge'

vi.mock('@renderer/components/terminal/XtermTerminal', () => ({
  XtermTerminal: ({ tabId, active }: { tabId: string; active: boolean }) => (
    <div data-testid={`xterm-${tabId}`} data-focused={active ? 'true' : 'false'} />
  ),
}))

const TAB_ID = 'sshtab-auto'

function progress(overrides: Partial<SessionAutoReconnect> = {}): SessionAutoReconnect {
  return {
    attempt: 1,
    maxAttempts: 5,
    nextRetryAt: new Date(Date.now() + 4_000).toISOString(),
    exhausted: false,
    ...overrides,
  }
}

function seedSession(overrides: Partial<SessionInfo> = {}): void {
  const session = fakeSessionInfo({
    id: TAB_ID,
    sessionId: 'ssh-auto',
    connectionId: 'conn-1',
    connectionName: 'prod',
    title: 'prod',
    status: 'disconnected',
    hasTerminal: true,
    connectedAt: null,
    failure: { code: 'network-error', message: '网络中断。' },
    autoReconnect: progress(),
    ...overrides,
  })
  useSessionStore.setState({ sessions: { [TAB_ID]: session }, dismissedSessionIds: [] })
  useWorkspaceStore.getState().addTab(TAB_ID)
  useWorkspaceStore.getState().activateTab(TAB_ID)
}

describe('automatic reconnect UI', () => {
  beforeEach(() => {
    window.termforge = createFakeBridge()
    useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
    useWorkspaceStore.getState().resetTabs()
    useTerminalStore.getState().reset()
  })

  afterEach(() => {
    delete window.termforge
  })

  it('shows the countdown for a waiting retry and stops it from the terminal overlay', () => {
    seedSession()
    render(<TerminalWorkspace />)

    expect(screen.getByText('等待自动重连')).toBeInTheDocument()
    expect(screen.getByText(/秒后进行第 1\/5 次自动尝试/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '停止自动重连' }))

    expect(useSessionStore.getState().sessions[TAB_ID]?.autoReconnect).toBeNull()
    expect(screen.queryByText('等待自动重连')).not.toBeInTheDocument()
  })

  it('shows the in-flight attempt and lets the user cancel it without closing the tab', async () => {
    const cancelConnect = vi.fn(async (clientId: string) => ({
      ok: true as const,
      value: {
        cancelled: true,
        session: fakeSshSnapshot({
          clientId,
          sessionId: 'ssh-auto',
          connectionId: 'conn-1',
          connectionName: 'prod',
          status: 'disconnected',
          connectedAt: null,
          error: { code: 'cancelled', message: '连接已取消。' },
        }),
      },
    }))
    window.termforge = createFakeBridge({}, { cancelConnect })
    seedSession({
      status: 'reconnecting',
      hasTerminal: false,
      failure: null,
      autoReconnect: progress({ nextRetryAt: null }),
    })
    render(<TerminalWorkspace />)

    expect(screen.getByText('正在自动重连')).toBeInTheDocument()
    expect(screen.getByText(/第 1\/5 次自动尝试/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消自动重连' }))

    expect(cancelConnect).toHaveBeenCalledWith(TAB_ID)
    expect(await screen.findByText('SSH 连接已断开')).toBeInTheDocument()
    expect(useSessionStore.getState().sessions[TAB_ID]).toMatchObject({
      status: 'disconnected',
      autoReconnect: null,
      failure: { code: 'cancelled' },
    })
    expect(useWorkspaceStore.getState().tabOrder).toEqual([TAB_ID])
  })

  it('shows a terminal exhausted state after the fifth failed attempt', () => {
    seedSession({
      status: 'error',
      hasTerminal: false,
      autoReconnect: progress({ attempt: 5, nextRetryAt: null, exhausted: true }),
    })
    render(<TerminalWorkspace />)

    expect(screen.getByText('自动重连已停止')).toBeInTheDocument()
    expect(screen.getByText(/已自动尝试 5 次/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '重新连接' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '取消自动重连' })).not.toBeInTheDocument()
  })
})
