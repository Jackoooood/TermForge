import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { SessionInfo, TerminalShellSnapshot } from '@shared/types'
import { TerminalWorkspace } from '@renderer/features/terminal/TerminalWorkspace'
import { useAppStore } from '@renderer/stores/appStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import {
  registerTerminalToolController,
  useTerminalToolStore,
} from '@renderer/stores/terminalToolStore'
import type {
  TerminalCopyResult,
  TerminalPasteResult,
  TerminalToolController,
} from '@renderer/stores/terminalToolStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge, fakeSessionInfo } from './helpers/fakeBridge'

vi.mock('@renderer/components/terminal/XtermTerminal', () => ({
  XtermTerminal: ({ tabId }: { tabId: string }) => <div data-testid={`xterm-${tabId}`} />,
}))

const TAB_ID = 'sshtab-tools'
const SESSION_ID = 'ssh-tools'

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return fakeSessionInfo({
    id: TAB_ID,
    sessionId: SESSION_ID,
    connectionId: 'conn-tools',
    connectionName: 'ops-shell',
    title: 'ops-shell',
    status: 'connected',
    hasTerminal: true,
    ...overrides,
  })
}

function shell(status: TerminalShellSnapshot['status']): TerminalShellSnapshot {
  return {
    sessionId: SESSION_ID,
    status,
    size: { cols: 100, rows: 30 },
    failure: null,
    exit: null,
  }
}

function createController() {
  return {
    copySelection: vi.fn<() => Promise<TerminalCopyResult>>(async () => 'copied'),
    pasteClipboard: vi.fn<() => Promise<TerminalPasteResult>>(async () => 'pasted'),
    clearBuffer: vi.fn<() => void>(),
    openSearch: vi.fn<() => void>(),
  } satisfies TerminalToolController
}

let unregister: (() => void) | null = null

function setup(status: TerminalShellSnapshot['status'] = 'open'): void {
  useSessionStore.setState({ sessions: { [TAB_ID]: session() }, dismissedSessionIds: [] })
  const workspace = useWorkspaceStore.getState()
  workspace.resetTabs()
  workspace.addTab(TAB_ID)
  workspace.activateTab(TAB_ID)
  useTerminalStore.setState({ shells: { [TAB_ID]: shell(status) } })
  useTerminalToolStore.getState().reset()
  useAppStore.setState({ toasts: [] })
}

beforeEach(() => {
  window.termforge = createFakeBridge()
  setup()
})

afterEach(() => {
  unregister?.()
  unregister = null
  delete window.termforge
})

describe('terminal tool buttons', () => {
  it('shows the four terminal tools only when the tab owns a terminal', () => {
    const view = render(<TerminalWorkspace />)
    expect(screen.getByRole('button', { name: '复制' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '粘贴' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '清除缓存' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '查找' })).toBeEnabled()
    view.unmount()

    const withoutTerminal = session({ hasTerminal: false })
    useSessionStore.setState({ sessions: { [TAB_ID]: withoutTerminal } })
    render(<TerminalWorkspace />)
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull()
    expect(screen.queryByRole('button', { name: '粘贴' })).toBeNull()
    expect(screen.queryByRole('button', { name: '清除缓存' })).toBeNull()
    expect(screen.queryByRole('button', { name: '查找' })).toBeNull()
  })

  it('enables copy only with a selection and paste only while the shell is open', () => {
    const view = render(<TerminalWorkspace />)
    act(() => useTerminalToolStore.getState().setSelection(TAB_ID, true))
    expect(screen.getByRole('button', { name: '复制' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '粘贴' })).toBeEnabled()
    view.unmount()

    setup('exited')
    act(() => useTerminalToolStore.getState().setSelection(TAB_ID, true))
    render(<TerminalWorkspace />)
    expect(screen.getByRole('button', { name: '复制' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '粘贴' })).toBeDisabled()
  })

  it('routes copy, paste, clear and find to the active tab controller with toasts', async () => {
    const controller = createController()
    unregister = registerTerminalToolController(TAB_ID, controller)
    render(<TerminalWorkspace />)
    act(() => useTerminalToolStore.getState().setSelection(TAB_ID, true))

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await vi.waitFor(() => expect(controller.copySelection).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(useAppStore.getState().toasts).toEqual([
        expect.objectContaining({ tone: 'success', title: '已复制终端选中内容' }),
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: '粘贴' }))
    await vi.waitFor(() => expect(controller.pasteClipboard).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
        tone: 'success',
        title: '已粘贴到终端',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '清除缓存' }))
    expect(controller.clearBuffer).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
      tone: 'info',
      title: '已清除终端缓存',
    })

    fireEvent.click(screen.getByRole('button', { name: '查找' }))
    expect(controller.openSearch).toHaveBeenCalledTimes(1)
  })

  it('reports empty selections, empty clipboards and controller failures without touching the shell', async () => {
    const controller = createController()
    controller.copySelection.mockResolvedValueOnce('empty')
    controller.pasteClipboard.mockResolvedValueOnce('empty')
    unregister = registerTerminalToolController(TAB_ID, controller)
    render(<TerminalWorkspace />)

    act(() => useTerminalToolStore.getState().setSelection(TAB_ID, true))
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await vi.waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
        tone: 'warning',
        title: '没有选中内容',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '粘贴' }))
    await vi.waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
        tone: 'warning',
        title: '剪贴板为空',
      }),
    )

    controller.pasteClipboard.mockResolvedValueOnce('failed')
    fireEvent.click(screen.getByRole('button', { name: '粘贴' }))
    await vi.waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
        tone: 'danger',
        title: '粘贴失败',
      }),
    )
    expect(controller.clearBuffer).not.toHaveBeenCalled()
    expect(controller.openSearch).not.toHaveBeenCalled()
  })

  it('warns instead of throwing when a button is pressed before the terminal controller mounts', async () => {
    render(<TerminalWorkspace />)
    act(() => useTerminalToolStore.getState().setSelection(TAB_ID, true))

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await vi.waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
        tone: 'warning',
        title: '终端尚未就绪',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '粘贴' }))
    await vi.waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
        tone: 'warning',
        title: '终端尚未就绪',
      }),
    )
  })
})
