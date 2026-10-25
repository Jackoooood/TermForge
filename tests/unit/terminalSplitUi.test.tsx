import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionInfo } from '@shared/types'
import { TerminalWorkspace } from '@renderer/features/terminal/TerminalWorkspace'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge, fakeSessionInfo } from './helpers/fakeBridge'

vi.mock('@renderer/components/terminal/XtermTerminal', () => ({
  XtermTerminal: ({ tabId, active }: { tabId: string; active: boolean }) => (
    <div data-testid={`xterm-${tabId}`} data-focused={active ? 'true' : 'false'} />
  ),
}))

function session(id: string, title: string): SessionInfo {
  return fakeSessionInfo({
    id,
    sessionId: `ssh-${id}`,
    connectionId: `conn-${id}`,
    connectionName: title,
    title,
    status: 'connected',
    hasTerminal: true,
  })
}

function seedSessions(): void {
  const sessions = {
    'sshtab-a': session('sshtab-a', 'prod-web'),
    'sshtab-b': session('sshtab-b', 'stage-api'),
    'sshtab-c': session('sshtab-c', 'prod-db'),
  }
  useSessionStore.setState({ sessions, dismissedSessionIds: [] })
  const workspace = useWorkspaceStore.getState()
  workspace.addTab('sshtab-a')
  workspace.addTab('sshtab-b')
  workspace.addTab('sshtab-c')
  workspace.activateTab('sshtab-a')
}

function visiblePanes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.terminal-pane--visible'))
}

describe('split terminal UI', () => {
  beforeEach(() => {
    window.termforge = createFakeBridge()
    useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
    useWorkspaceStore.getState().resetTabs()
    useTerminalStore.getState().reset()
    seedSessions()
  })

  afterEach(() => {
    delete window.termforge
  })

  it('mounts exactly one terminal per tab and keeps the DOM node across split changes', () => {
    const view = render(<TerminalWorkspace />)
    const first = screen.getByTestId('xterm-sshtab-a')
    expect(screen.getAllByTestId('xterm-sshtab-a')).toHaveLength(1)
    expect(screen.getAllByTestId('xterm-sshtab-b')).toHaveLength(1)
    expect(visiblePanes()).toHaveLength(1)

    act(() => useWorkspaceStore.getState().enableSplit('row'))

    expect(view.container.contains(first)).toBe(true)
    expect(screen.getByTestId('xterm-sshtab-a')).toBe(first)
    expect(screen.getAllByTestId('xterm-sshtab-a')).toHaveLength(1)
    expect(visiblePanes()).toHaveLength(2)

    act(() => useWorkspaceStore.getState().disableSplit())
    expect(screen.getByTestId('xterm-sshtab-a')).toBe(first)
    expect(visiblePanes()).toHaveLength(1)
  })

  it('enables both directions from the toolbar and merges without closing sessions', () => {
    render(<TerminalWorkspace />)

    fireEvent.click(screen.getByRole('button', { name: '左右分屏' }))
    expect(useWorkspaceStore.getState().split).toMatchObject({
      enabled: true,
      direction: 'row',
    })
    expect(visiblePanes()).toHaveLength(2)
    expect(screen.getByRole('button', { name: '退出分屏' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '上下' }))
    expect(useWorkspaceStore.getState().split.direction).toBe('column')

    fireEvent.click(screen.getByRole('button', { name: '退出分屏' }))
    expect(useWorkspaceStore.getState().split.enabled).toBe(false)
    expect(useWorkspaceStore.getState().activeTabId).toBe('sshtab-a')
    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(3)
    expect(visiblePanes()).toHaveLength(1)
  })

  it('moves keyboard focus between panes without remounting either terminal', () => {
    useWorkspaceStore.getState().enableSplit('row')
    render(<TerminalWorkspace />)

    expect(screen.getByTestId('xterm-sshtab-a')).toHaveAttribute('data-focused', 'true')
    expect(screen.getByTestId('xterm-sshtab-b')).toHaveAttribute('data-focused', 'false')

    const paneB = document.querySelector<HTMLElement>('[id="terminal-panel-sshtab-b"]')
    expect(paneB).not.toBeNull()
    fireEvent.click(within(paneB as HTMLElement).getByTitle('聚焦此窗格'))

    expect(useWorkspaceStore.getState().split.focusedPaneId).toBe('pane-b')
    expect(useWorkspaceStore.getState().activeTabId).toBe('sshtab-b')
    expect(screen.getByTestId('xterm-sshtab-a')).toHaveAttribute('data-focused', 'false')
    expect(screen.getByTestId('xterm-sshtab-b')).toHaveAttribute('data-focused', 'true')
  })

  it('adjusts the ratio from the keyboard and clamps it to the allowed range', () => {
    useWorkspaceStore.getState().enableSplit('row')
    render(<TerminalWorkspace />)

    const divider = screen.getByRole('separator', { name: '调整分屏比例' })
    expect(divider).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(useWorkspaceStore.getState().split.ratio).toBeCloseTo(0.52)
    expect(divider).toHaveAttribute('aria-valuenow', '52')

    fireEvent.keyDown(divider, { key: 'Home' })
    expect(useWorkspaceStore.getState().split.ratio).toBe(0.2)
    expect(divider).toHaveAttribute('aria-valuenow', '20')

    fireEvent.keyDown(divider, { key: 'End' })
    expect(useWorkspaceStore.getState().split.ratio).toBe(0.8)
    expect(divider).toHaveAttribute('aria-valuenow', '80')
  })

  it('shows an empty pane selector and binds another open tab without closing anything', () => {
    useWorkspaceStore.getState().enableSplit('row')
    render(<TerminalWorkspace />)

    fireEvent.click(screen.getByRole('button', { name: '将 stage-api 从分屏中移除' }))

    const emptyPane = screen.getByRole('region', { name: '右侧空窗格' })
    expect(useSessionStore.getState().sessions['sshtab-b']).toBeDefined()
    expect(visiblePanes()).toHaveLength(1)

    const select = within(emptyPane).getByRole('combobox', {
      name: '选择放入右侧窗格的会话',
    })
    fireEvent.change(select, { target: { value: 'sshtab-c' } })

    expect(useWorkspaceStore.getState().split.panes['pane-b'].tabId).toBe('sshtab-c')
    expect(useWorkspaceStore.getState().activeTabId).toBe('sshtab-c')
    expect(screen.queryByRole('region', { name: '右侧空窗格' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('xterm-sshtab-c')).toBeInTheDocument()
  })

  it('does not call SSH connect or disconnect when changing split layout', () => {
    const bridge = createFakeBridge()
    window.termforge = bridge
    const connect = vi.spyOn(bridge.ssh, 'connect')
    const disconnect = vi.spyOn(bridge.ssh, 'disconnect')
    render(<TerminalWorkspace />)

    fireEvent.click(screen.getByRole('button', { name: '上下分屏' }))
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('button', { name: '将 prod-web 从分屏中移除' }))
    fireEvent.click(screen.getByRole('button', { name: '退出分屏' }))

    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })
})
