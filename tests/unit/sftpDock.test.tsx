import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SftpDock } from '@renderer/features/workbench/SftpDock'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSftpStore } from '@renderer/stores/sftpStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge, fakeSessionInfo } from './helpers/fakeBridge'

function resetFixtures(): void {
  useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
  useSftpStore.getState().reset()
  useWorkspaceStore.setState({
    tabOrder: [],
    activeTabId: null,
    activeModule: 'workbench',
    sftpDockOpen: true,
  })
}

function seedConnectedSession(): void {
  const prod = fakeSessionInfo({
    id: 'sshtab-prod-web',
    sessionId: 'ssh-prod-web',
    connectionId: 'conn-prod-web-01',
    connectionName: 'prod-web-01',
    title: 'prod-web-01',
    username: 'deploy',
    status: 'connected',
  })
  useSessionStore.setState({ sessions: { [prod.id]: prod } })
  useWorkspaceStore.getState().addTab(prod.id)
  useWorkspaceStore.getState().activateTab(prod.id)
}

describe('SftpDock', () => {
  beforeEach(() => {
    window.termforge = createFakeBridge()
    resetFixtures()
  })

  afterEach(() => {
    delete window.termforge
  })

  it('renders nothing without an active session tab', () => {
    const { container } = render(<SftpDock />)
    expect(container).toBeEmptyDOMElement()
  })

  it('opens the remote directory for the active tab and shows breadcrumbs', async () => {
    seedConnectedSession()
    render(<SftpDock />)

    expect(screen.getByText('SFTP')).toBeInTheDocument()
    expect(screen.getByText('prod-web-01')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText(/SFTP 已连接/)).toBeInTheDocument()
    })

    const crumbs = screen.getByRole('navigation', { name: '远程路径' })
    expect(crumbs.textContent?.replace(/\s+/g, '')).toBe('/home/deploy')
    expect(screen.getByRole('tree', { name: '远程目录树' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建远程目录' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: '筛选当前远程目录的文件名' })).toBeInTheDocument()
    expect(screen.getByText('此目录为空')).toBeInTheDocument()
    expect(screen.getByText(/0 个条目/)).toBeInTheDocument()
  })

  it('roots the tree at home when the server denies listing the remote root', async () => {
    window.termforge = createFakeBridge(
      {},
      {},
      {},
      {
        list: async (sessionId, path) =>
          path === '/'
            ? {
                ok: false,
                error: { code: 'permission-denied', message: '服务器拒绝访问该目录' },
              }
            : {
                ok: true,
                value: {
                  sessionId,
                  path,
                  entries: [],
                  loadedAt: '2026-10-22T08:00:00.000Z',
                },
              },
      },
    )
    seedConnectedSession()
    render(<SftpDock />)

    const item = await screen.findByRole('treeitem', { name: 'deploy' })
    expect(item).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('treeitem', { name: '/' })).not.toBeInTheDocument()
    expect(screen.queryByText('服务器拒绝访问该目录')).not.toBeInTheDocument()
  })

  it('hides the dock and jumps to the full SFTP view via header buttons', async () => {
    const user = userEvent.setup()
    seedConnectedSession()
    render(<SftpDock />)

    await waitFor(() => {
      expect(screen.getByText(/SFTP 已连接/)).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: '在 SFTP 页打开完整双栏视图' }))
    expect(useWorkspaceStore.getState().activeModule).toBe('sftp')
    expect(useWorkspaceStore.getState().activeTabId).toBe('sshtab-prod-web')

    await user.click(screen.getByRole('button', { name: '隐藏 SFTP 面板' }))
    expect(useWorkspaceStore.getState().sftpDockOpen).toBe(false)
  })

  it('shows the disconnected state when the active session is not connected', () => {
    const stage = fakeSessionInfo({
      id: 'sshtab-stage-api',
      sessionId: 'ssh-stage-api',
      connectionId: 'conn-stage-api-01',
      connectionName: 'stage-api-01',
      title: 'stage-api-01',
      username: 'ubuntu',
      status: 'disconnected',
      connectedAt: null,
    })
    useSessionStore.setState({ sessions: { [stage.id]: stage } })
    useWorkspaceStore.getState().addTab(stage.id)
    useWorkspaceStore.getState().activateTab(stage.id)

    render(<SftpDock />)

    expect(screen.getByText('SSH 已断开')).toBeInTheDocument()
    expect(screen.getByText('SSH 会话不可用')).toBeInTheDocument()
    expect(screen.queryByRole('tree', { name: '远程目录树' })).not.toBeInTheDocument()
    expect(useSftpStore.getState().tabs[stage.id]).toBeUndefined()
  })

  it('clamps runtime dock and tree widths instead of persisting layout settings', () => {
    useWorkspaceStore.getState().setSftpDockWidth(9999)
    expect(useWorkspaceStore.getState().sftpDockWidth).toBe(640)
    useWorkspaceStore.getState().setSftpDockWidth(100)
    expect(useWorkspaceStore.getState().sftpDockWidth).toBe(320)
    useWorkspaceStore.getState().setSftpDockWidth(null)
    expect(useWorkspaceStore.getState().sftpDockWidth).toBeNull()

    useWorkspaceStore.getState().setSftpTreeWidth(9999)
    expect(useWorkspaceStore.getState().sftpTreeWidth).toBe(280)
    useWorkspaceStore.getState().setSftpTreeWidth(10)
    expect(useWorkspaceStore.getState().sftpTreeWidth).toBe(140)
  })
})
