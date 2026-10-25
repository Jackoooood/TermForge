import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ServersView } from '@renderer/features/connections/ServersView'
import { DeleteConnectionModal } from '@renderer/features/connections/DeleteConnectionModal'
import { useAppStore } from '@renderer/stores/appStore'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { usePortForwardStore } from '@renderer/stores/portForwardStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge } from './helpers/fakeBridge'

function resetStores(): void {
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
  useAppStore.setState({
    appInfo: null,
    bridgeStatus: 'idle',
    bridgeError: null,
    securityStatus: null,
    securityStatusError: null,
    toasts: [],
  })
  useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
  useWorkspaceStore.setState({ tabOrder: [], activeTabId: null })
}

describe('connection management', () => {
  beforeEach(resetStores)
  afterEach(() => {
    delete window.termforge
  })

  it('deletes a persisted connection after explicit confirmation', async () => {
    const user = userEvent.setup()
    window.termforge = createFakeBridge({
      remove: async (id) => ({ ok: true, value: { id } }),
    })
    await useConnectionStore.getState().loadConnections()
    render(
      <>
        <ServersView />
        <DeleteConnectionModal />
      </>,
    )

    await user.click(await screen.findByRole('button', { name: '删除 prod-db-01' }))
    const dialog = screen.getByRole('dialog', { name: '删除连接？' })
    expect(dialog).toHaveTextContent('dba@10.20.4.21:22')

    await user.click(within(dialog).getByRole('button', { name: '删除连接' }))
    await waitFor(() => {
      expect(useConnectionStore.getState().connections).toHaveLength(6)
    })
    expect(screen.queryByRole('button', { name: '删除 prod-db-01' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('连接已删除')
  })

  it('keeps the dialog open and shows a safe error when persistence fails', async () => {
    const user = userEvent.setup()
    window.termforge = createFakeBridge({
      remove: async () => ({
        ok: false,
        error: { code: 'storage-write-failed', message: '无法保存本地连接配置。' },
      }),
    })
    await useConnectionStore.getState().loadConnections()
    render(
      <>
        <ServersView />
        <DeleteConnectionModal />
      </>,
    )

    await user.click(await screen.findByRole('button', { name: '删除 prod-db-01' }))
    const dialog = screen.getByRole('dialog', { name: '删除连接？' })
    await user.click(within(dialog).getByRole('button', { name: '删除连接' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('无法保存本地连接配置。')
    expect(screen.getByRole('button', { name: '删除 prod-db-01' })).toBeInTheDocument()
    expect(useConnectionStore.getState().deleteTargetId).toBe('conn-prod-db-01')
  })

  it('shows an empty state when no connection is stored', () => {
    useConnectionStore.setState({ loadStatus: 'ready', connections: [], groups: [] })
    render(<ServersView />)
    expect(screen.getByText('还没有连接')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '新建连接' }).length).toBeGreaterThan(0)
  })

  it('shows and dismisses the persistence failure banner', async () => {
    const user = userEvent.setup()
    useConnectionStore.setState({
      loadStatus: 'ready',
      connections: [],
      groups: [],
      persistenceError: '收藏状态未保存。',
    })
    render(<ServersView />)

    expect(screen.getByRole('alert')).toHaveTextContent('收藏状态未保存。')
    await user.click(screen.getByRole('button', { name: '关闭存储错误提示' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(useConnectionStore.getState().persistenceError).toBeNull()
  })

  it('requires explicit confirmation before cascading port forwarding rule deletion', async () => {
    const user = userEvent.setup()
    const remove = vi.fn(async (id: string) => ({ ok: true as const, value: { id } }))
    window.termforge = createFakeBridge(
      { remove },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {
        getConnectionRemovalImpact: async (connectionId) => ({
          ok: true,
          value: {
            connectionId,
            portForwardRuleCount: 2,
            runningPortForwardCount: 1,
          },
        }),
      },
    )
    await useConnectionStore.getState().loadConnections()
    render(
      <>
        <ServersView />
        <DeleteConnectionModal />
      </>,
    )

    await user.click(await screen.findByRole('button', { name: '删除 prod-db-01' }))
    const dialog = screen.getByRole('dialog', { name: '删除连接？' })
    expect(
      await within(dialog).findByText(/该连接下仍有 2 条端口转发规则（其中 1 条运行中）/),
    ).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: '删除连接并清理规则' })
    expect(confirm).toBeDisabled()
    expect(remove).not.toHaveBeenCalled()

    await user.click(
      within(dialog).getByRole('checkbox', { name: /我已确认停止并删除这 2 条端口转发规则/ }),
    )
    expect(confirm).toBeEnabled()
    await user.click(confirm)

    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith('conn-prod-db-01', { cascadePortForwards: true })
    })
    expect(useConnectionStore.getState().connections).toHaveLength(6)
    expect(useAppStore.getState().toasts.at(-1)?.description).toContain(
      '同时停止并删除了 2 条端口转发规则',
    )
  })

  it('blocks deletion until the port forwarding impact check succeeds', async () => {
    const user = userEvent.setup()
    let attempts = 0
    window.termforge = createFakeBridge(
      { remove: async (id) => ({ ok: true, value: { id } }) },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {
        getConnectionRemovalImpact: async (connectionId) => {
          attempts += 1
          if (attempts === 1) {
            return {
              ok: false,
              error: { code: 'internal', message: '检查规则失败。' },
            }
          }
          return {
            ok: true,
            value: {
              connectionId,
              portForwardRuleCount: 0,
              runningPortForwardCount: 0,
            },
          }
        },
      },
    )
    await useConnectionStore.getState().loadConnections()
    render(
      <>
        <ServersView />
        <DeleteConnectionModal />
      </>,
    )

    await user.click(await screen.findByRole('button', { name: '删除 prod-db-01' }))
    const dialog = screen.getByRole('dialog', { name: '删除连接？' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('检查规则失败。')
    expect(within(dialog).getByRole('button', { name: '删除连接' })).toBeDisabled()

    await user.click(within(dialog).getByRole('button', { name: '重试检查' }))
    expect(await within(dialog).findByText('未发现关联的端口转发规则。')).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: '删除连接' })
    expect(confirm).toBeEnabled()
    await user.click(confirm)

    await waitFor(() => {
      expect(useConnectionStore.getState().connections).toHaveLength(6)
    })
  })

  it('surfaces a load failure with a retry action instead of an empty list', async () => {
    window.termforge = createFakeBridge({
      list: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'storage-read-failed', message: '无法读取本地连接配置。' },
      }),
    })
    await useConnectionStore.getState().loadConnections()
    render(<ServersView />)

    expect(screen.getByText('连接列表加载失败')).toBeInTheDocument()
    expect(screen.getByText('无法读取本地连接配置。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
