import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import { App } from '@renderer/app/App'
import { useAppStore } from '@renderer/stores/appStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { usePortForwardStore } from '@renderer/stores/portForwardStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import { useWallpaperStore } from '@renderer/stores/wallpaperStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { createFakeBridge, fakeSessionInfo } from './helpers/fakeBridge'

vi.mock('@renderer/components/terminal/TerminalPane', () => ({
  TerminalPane: ({ session, active }: { session: { title: string }; active: boolean }) => (
    <div role="tabpanel" aria-hidden={!active} data-testid={`terminal-${session.title}`}>
      {session.title} terminal (mock)
    </div>
  ),
}))

describe('App shell', () => {
  beforeEach(() => {
    window.termforge = createFakeBridge()
    useConnectionStore.setState({
      connections: [],
      groups: [],
      loadStatus: 'idle',
      loadError: null,
      persistenceError: null,
      searchQuery: '',
      collapsedGroupIds: [],
      editor: { open: false, mode: 'create', connectionId: null },
      deleteTargetId: null,
      deleteStatus: 'idle',
      deleteError: null,
      deleteImpact: null,
      deleteImpactStatus: 'idle',
      deleteImpactError: null,
      cascadePortForwards: false,
    })
    usePortForwardStore.setState({
      items: [],
      revision: 0,
      loadStatus: 'idle',
      loadError: null,
      actionError: null,
      editor: { open: false, mode: 'create', ruleId: null },
      startTargetId: null,
      deleteTargetId: null,
      pending: {},
    })
    useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
    useWorkspaceStore.setState({ tabOrder: [], activeTabId: null })
    const prod = fakeSessionInfo({
      id: 'sshtab-prod-web',
      sessionId: 'ssh-prod-web',
      connectionId: 'conn-prod-web-01',
      connectionName: 'prod-web-01',
      title: 'prod-web-01',
      username: 'deploy',
    })
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
    useSessionStore.setState({ sessions: { [prod.id]: prod, [stage.id]: stage } })
    useWorkspaceStore.getState().addTab(prod.id)
    useWorkspaceStore.getState().addTab(stage.id)
    useWorkspaceStore.getState().activateTab(prod.id)
    useSettingsStore.setState({
      theme: 'aurora',
      terminalFontSize: 13,
      wallpaperEnabled: false,
      wallpaperIntensity: 'balanced',
      status: 'idle',
      warnings: [],
      error: null,
    })
    useWallpaperStore.setState({
      dataUrl: null,
      fileName: null,
      updatedAt: null,
      status: 'idle',
      error: null,
      busy: false,
    })
    useWorkspaceStore.setState({
      activeModule: 'workbench',
      sidebarCollapsed: false,
      paletteMode: null,
    })
    useTransferStore.setState({ tasks: [], panelOpen: false })
    useAppStore.setState({
      appInfo: null,
      bridgeStatus: 'idle',
      bridgeError: null,
      securityStatus: null,
      securityStatusError: null,
      toasts: [],
    })
  })

  afterEach(() => {
    delete window.termforge
  })

  it('renders the shell regions and switches primary modules', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)

    const titleBar = container.querySelector<HTMLElement>('.top-bar')
    expect(titleBar).not.toBeNull()
    const sidebar = screen.getByRole('complementary', { name: '主导航与服务器资源' })
    const navigation = within(sidebar).getByRole('navigation', { name: '主导航' })
    expect(
      within(navigation)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual(['首页', '连接管理', 'SFTP 文件', '命令库', '端口转发', '设置'])
    expect(within(navigation).getByRole('button', { name: '首页' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(titleBar!).getByRole('button', { name: '收起服务器侧栏' })).toBeInTheDocument()
    expect(within(titleBar!).getByRole('button', { name: '全局搜索' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '壁纸' })).not.toBeInTheDocument()
    expect(
      (await screen.findAllByRole('button', { name: /连接 prod-web-01/ })).length,
    ).toBeGreaterThan(0)

    const sessionTablist = screen.getByRole('tablist', { name: '会话标签' })
    expect(sessionTablist).toBeInTheDocument()
    expect(within(sessionTablist).getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByTestId('terminal-prod-web-01')).toBeInTheDocument()

    expect(screen.getByRole('contentinfo', { name: '状态栏' })).toHaveTextContent(
      '主进程管理 SSH 与文件传输',
    )
    expect(await screen.findByText('TermForge v0.1.0 · Windows')).toBeInTheDocument()

    await user.click(within(navigation).getByRole('button', { name: '设置' }))
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '经典主题' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '扩展色板' })).toBeInTheDocument()

    await user.click(within(navigation).getByRole('button', { name: '端口转发' }))
    expect(screen.getByRole('heading', { level: 1, name: '端口转发' })).toBeInTheDocument()
    expect(await screen.findByText('还没有端口转发规则')).toBeInTheDocument()

    await user.click(within(navigation).getByRole('button', { name: '连接管理' }))
    expect(screen.getByRole('heading', { level: 1, name: '服务器连接' })).toBeInTheDocument()
    expect(await screen.findByText('共 7 个连接 · 分组 3 个')).toBeInTheDocument()

    await user.click(within(navigation).getByRole('button', { name: '命令库' }))
    const dialog = screen.getByRole('dialog', { name: '快速命令' })
    expect(within(dialog).getByRole('tab', { name: /命令库/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.click(within(dialog).getByRole('tab', { name: /历史/ }))
    expect(within(dialog).getByRole('tab', { name: /历史/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('activates the wallpaper layer only when enabled with a stored image', async () => {
    window.termforge = createFakeBridge(
      {},
      {},
      {},
      {},
      {},
      {
        get: async () => ({
          ok: true,
          value: {
            preferences: {
              ...DEFAULT_APP_PREFERENCES,
              wallpaperEnabled: true,
              wallpaperIntensity: 'strong',
            },
            warnings: [],
          },
        }),
      },
      {},
      {},
      {
        get: async () => ({
          ok: true,
          value: {
            dataUrl: 'data:image/jpeg;base64,AAAA',
            fileName: 'desk.jpg',
            updatedAt: '2026-10-22T08:00:00.000Z',
          },
        }),
      },
    )

    const { container } = render(<App />)
    const shell = container.querySelector('.app-shell')

    await vi.waitFor(() => {
      expect(shell).toHaveAttribute('data-wallpaper', 'on')
    })
    expect(shell).toHaveAttribute('data-wallpaper-intensity', 'strong')
    expect(shell?.getAttribute('style')).toContain('--tf-wallpaper-image')
    expect(shell?.getAttribute('style')).toContain('data:image/jpeg;base64,AAAA')
  })
})
