import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionTabs } from '@renderer/features/sessions/SessionTabs'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge, fakeSessionInfo } from './helpers/fakeBridge'

function resetSessionFixtures(): void {
  useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
  useWorkspaceStore.setState({ tabOrder: [], activeTabId: null })
  useTerminalStore.getState().reset()
  const prod = fakeSessionInfo({
    id: 'sshtab-prod-web',
    sessionId: 'ssh-prod-web',
    connectionId: 'conn-prod-web-01',
    connectionName: 'prod-web-01',
    title: 'prod-web-01',
    username: 'deploy',
    createdAt: '2026-10-21T12:30:00.000Z',
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
    createdAt: '2026-10-21T12:34:00.000Z',
  })
  useSessionStore.setState({ sessions: { [prod.id]: prod, [stage.id]: stage } })
  useWorkspaceStore.getState().addTab(prod.id)
  useWorkspaceStore.getState().addTab(stage.id)
  useWorkspaceStore.getState().activateTab(prod.id)
}

async function loadPersistedConnections(): Promise<void> {
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
  })
  await useConnectionStore.getState().loadConnections()
}

describe('SessionTabs', () => {
  beforeEach(async () => {
    window.termforge = createFakeBridge()
    resetSessionFixtures()
    await loadPersistedConnections()
  })

  afterEach(() => {
    delete window.termforge
  })

  function tabFor(title: string): HTMLElement {
    const tab = screen.getByText(title).closest('[role="tab"]')
    expect(tab).not.toBeNull()
    return tab as HTMLElement
  }

  it('switches the active simulated session', async () => {
    const user = userEvent.setup()
    render(<SessionTabs />)

    const stageLabel = screen.getByText('stage-api-01')
    const stageTab = stageLabel.closest('[role="tab"]')
    expect(stageTab).not.toBeNull()
    expect(stageTab).toHaveAttribute('aria-selected', 'false')

    await user.click(stageLabel)

    expect(stageTab).toHaveAttribute('aria-selected', 'true')
    expect(useWorkspaceStore.getState().activeTabId).toBe('sshtab-stage-api')
  })

  it('closes a session tab and falls back to a neighbor', async () => {
    const user = userEvent.setup()
    render(<SessionTabs />)

    await user.click(screen.getByRole('button', { name: '关闭 stage-api-01 会话' }))

    await waitFor(() => expect(screen.queryByText('stage-api-01')).not.toBeInTheDocument())
    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(1)
    expect(useWorkspaceStore.getState().activeTabId).toBe('sshtab-prod-web')
  })

  it('opens a new independent session from the tab picker', async () => {
    const user = userEvent.setup()
    render(<SessionTabs />)

    await user.click(screen.getByRole('button', { name: '新建会话' }))
    const option = await screen.findByRole('menuitem', { name: /prod-db-01/ })
    await user.click(option)

    await waitFor(() => expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(3))
    expect(screen.getByText('prod-db-01')).toBeInTheDocument()
    const activeTabId = useWorkspaceStore.getState().activeTabId
    expect(activeTabId).not.toBeNull()
    expect(useSessionStore.getState().sessions[activeTabId!]?.title).toBe('prod-db-01')
  })

  it('opens a tab context menu with positional disabled actions', async () => {
    render(<SessionTabs />)

    fireEvent.contextMenu(tabFor('prod-web-01'))
    const firstMenu = await screen.findByRole('menu', {
      name: 'prod-web-01 标签页操作',
    })
    expect(within(firstMenu).getAllByRole('menuitem')).toHaveLength(5)
    expect(within(firstMenu).getByRole('menuitem', { name: '关闭标签页' })).toBeEnabled()
    expect(within(firstMenu).getByRole('menuitem', { name: '关闭其他标签页' })).toBeEnabled()
    expect(within(firstMenu).getByRole('menuitem', { name: '关闭左边标签页' })).toBeDisabled()
    expect(within(firstMenu).getByRole('menuitem', { name: '关闭右边标签页' })).toBeEnabled()
    expect(within(firstMenu).getByRole('menuitem', { name: '关闭全部标签页' })).toBeEnabled()

    fireEvent.contextMenu(tabFor('stage-api-01'))
    const lastMenu = await screen.findByRole('menu', {
      name: 'stage-api-01 标签页操作',
    })
    expect(within(lastMenu).getByRole('menuitem', { name: '关闭左边标签页' })).toBeEnabled()
    expect(within(lastMenu).getByRole('menuitem', { name: '关闭右边标签页' })).toBeDisabled()
  })

  it('closes every other tab from the context menu', async () => {
    const user = userEvent.setup()
    render(<SessionTabs />)

    fireEvent.contextMenu(tabFor('stage-api-01'))
    await user.click(await screen.findByRole('menuitem', { name: '关闭其他标签页' }))

    await waitFor(() => expect(useWorkspaceStore.getState().tabOrder).toEqual(['sshtab-stage-api']))
    expect(screen.getByText('stage-api-01')).toBeInTheDocument()
    expect(screen.queryByText('prod-web-01')).not.toBeInTheDocument()
    expect(useWorkspaceStore.getState().activeTabId).toBe('sshtab-stage-api')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes tabs to the left of the target tab', async () => {
    const user = userEvent.setup()
    render(<SessionTabs />)

    fireEvent.contextMenu(tabFor('stage-api-01'))
    await user.click(await screen.findByRole('menuitem', { name: '关闭左边标签页' }))

    await waitFor(() => expect(useWorkspaceStore.getState().tabOrder).toEqual(['sshtab-stage-api']))
    expect(screen.queryByText('prod-web-01')).not.toBeInTheDocument()
    expect(screen.getByText('stage-api-01')).toBeInTheDocument()
  })

  it('closes tabs to the right of the target tab', async () => {
    const user = userEvent.setup()
    render(<SessionTabs />)

    fireEvent.contextMenu(tabFor('prod-web-01'))
    await user.click(await screen.findByRole('menuitem', { name: '关闭右边标签页' }))

    await waitFor(() => expect(useWorkspaceStore.getState().tabOrder).toEqual(['sshtab-prod-web']))
    expect(screen.queryByText('stage-api-01')).not.toBeInTheDocument()
    expect(screen.getByText('prod-web-01')).toBeInTheDocument()
  })

  it('closes all tabs from the context menu', async () => {
    const user = userEvent.setup()
    render(<SessionTabs />)

    fireEvent.contextMenu(tabFor('stage-api-01'))
    await user.click(await screen.findByRole('menuitem', { name: '关闭全部标签页' }))

    await waitFor(() => expect(useWorkspaceStore.getState().tabOrder).toEqual([]))
    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(0)
    expect(useWorkspaceStore.getState().activeTabId).toBeNull()
    expect(screen.getByText('暂无打开的会话')).toBeInTheDocument()
  })
})
