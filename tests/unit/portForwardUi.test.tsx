import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  ConnectionProfile,
  PortForwardItem,
  PortForwardRule,
  PortForwardRuntime,
  TermForgeBridge,
} from '@shared/types'
import { PortForwardEditorModal } from '@renderer/features/portForwards/PortForwardEditorModal'
import { PortForwardStartModal } from '@renderer/features/portForwards/PortForwardStartModal'
import { PortForwardsView } from '@renderer/features/portForwards/PortForwardsView'
import { useAppStore } from '@renderer/stores/appStore'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { usePortForwardStore } from '@renderer/stores/portForwardStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge, fakeSessionInfo } from './helpers/fakeBridge'

const CONNECTION: ConnectionProfile = {
  id: 'conn-1',
  name: '测试服务器',
  host: '127.0.0.1',
  port: 22,
  username: 'tester',
  authMethod: 'password',
  groupId: 'group-1',
  tagIds: [],
  jumpConnectionIds: [],
  favorite: false,
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
}

const LOCAL_RULE: PortForwardRule = {
  id: 'pf-local',
  name: '本地数据库',
  type: 'local',
  connectionId: 'conn-1',
  bindAddress: '0.0.0.0',
  bindPort: 18080,
  targetHost: '10.0.0.5',
  targetPort: 5432,
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
}

const REMOTE_RULE: PortForwardRule = {
  id: 'pf-remote',
  name: '远端端口',
  type: 'remote',
  connectionId: 'conn-1',
  bindAddress: '127.0.0.1',
  bindPort: 9090,
  targetHost: '127.0.0.1',
  targetPort: 3000,
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
}

function runtime(ruleId: string, overrides: Partial<PortForwardRuntime> = {}): PortForwardRuntime {
  return {
    ruleId,
    status: 'stopped',
    sessionId: null,
    boundAddress: null,
    boundPort: null,
    activeConnections: 0,
    startedAt: null,
    lastStopReason: null,
    failure: null,
    cleanupPending: false,
    ...overrides,
  }
}

function item(rule: PortForwardRule, overrides: Partial<PortForwardRuntime> = {}): PortForwardItem {
  return { rule, runtime: runtime(rule.id, overrides) }
}

function bridgeWithPortForwards(
  portForwards: Partial<TermForgeBridge['portForwards']>,
): TermForgeBridge {
  return createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, portForwards)
}

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
  useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
  useWorkspaceStore.setState({ tabOrder: [], activeTabId: null })
  useAppStore.setState({
    appInfo: null,
    bridgeStatus: 'idle',
    bridgeError: null,
    securityStatus: null,
    securityStatusError: null,
    toasts: [],
  })
}

describe('port forwarding UI', () => {
  beforeEach(resetStores)
  afterEach(() => {
    delete window.termforge
  })

  it('renders authoritative runtime status, bound endpoint and failure from the main process', async () => {
    window.termforge = bridgeWithPortForwards({
      list: async () => ({
        ok: true,
        value: {
          revision: 3,
          items: [
            item(LOCAL_RULE, {
              status: 'running',
              sessionId: 'ssh-1',
              boundAddress: '127.0.0.1',
              boundPort: 18080,
              activeConnections: 2,
              startedAt: '2026-10-23T08:00:00.000Z',
            }),
            item(REMOTE_RULE, {
              status: 'error',
              failure: {
                code: 'remote-bind-failed',
                message: '远端拒绝监听该地址。',
              },
            }),
          ],
        },
      }),
    })
    useConnectionStore.setState({
      connections: [CONNECTION],
      groups: [],
      loadStatus: 'ready',
    })
    await usePortForwardStore.getState().sync()

    render(<PortForwardsView />)

    expect(screen.getByText('本地数据库')).toBeInTheDocument()
    expect(screen.getByText('远端端口')).toBeInTheDocument()
    expect(screen.getByText('127.0.0.1:18080')).toBeInTheDocument()
    expect(screen.getByText('运行中')).toBeInTheDocument()
    expect(screen.getByText('异常')).toBeInTheDocument()
    expect(screen.getByText('远端拒绝监听该地址。')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑 本地数据库' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除 本地数据库' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除 远端端口' })).toBeEnabled()
  })

  it('requires explicit exposure confirmation before starting a non-loopback rule', async () => {
    const user = userEvent.setup()
    const start = vi.fn(async () => ({
      ok: true as const,
      value: item(LOCAL_RULE, {
        status: 'running',
        sessionId: 'ssh-1',
        boundAddress: '0.0.0.0',
        boundPort: 18080,
        startedAt: '2026-10-23T08:00:00.000Z',
      }),
    }))
    window.termforge = bridgeWithPortForwards({ start })
    useConnectionStore.setState({ connections: [CONNECTION], groups: [], loadStatus: 'ready' })
    usePortForwardStore.setState({
      items: [item(LOCAL_RULE)],
      revision: 1,
      loadStatus: 'ready',
      startTargetId: LOCAL_RULE.id,
    })
    const session = fakeSessionInfo({
      id: 'sshtab-1',
      sessionId: 'ssh-1',
      connectionId: 'conn-1',
      status: 'connected',
    })
    useSessionStore.setState({ sessions: { [session.id]: session }, dismissedSessionIds: [] })
    useWorkspaceStore.setState({ activeTabId: session.id })

    render(<PortForwardStartModal />)

    const dialog = screen.getByRole('dialog', { name: /启动转发 · 本地数据库/ })
    const submit = within(dialog).getByRole('button', { name: '启动转发' })
    expect(submit).toBeDisabled()
    expect(dialog).toHaveTextContent('非回环地址会向其他主机暴露端口')

    await user.click(within(dialog).getByRole('checkbox', { name: /我已确认该监听地址的暴露范围/ }))
    expect(submit).toBeEnabled()
    await user.click(submit)

    await waitFor(() => {
      expect(start).toHaveBeenCalledWith({
        ruleId: LOCAL_RULE.id,
        sessionId: 'ssh-1',
        confirmExposure: true,
      })
    })
    await waitFor(() => {
      expect(usePortForwardStore.getState().startTargetId).toBeNull()
    })
    expect(usePortForwardStore.getState().items[0]?.runtime.status).toBe('running')
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('端口转发已启动')
  })

  it('refuses to start when no connected SSH session exists for the rule', () => {
    window.termforge = bridgeWithPortForwards({})
    useConnectionStore.setState({ connections: [CONNECTION], groups: [], loadStatus: 'ready' })
    usePortForwardStore.setState({
      items: [item(REMOTE_RULE)],
      revision: 1,
      loadStatus: 'ready',
      startTargetId: REMOTE_RULE.id,
    })

    render(<PortForwardStartModal />)

    const dialog = screen.getByRole('dialog', { name: /启动转发/ })
    expect(dialog).toHaveTextContent('当前没有该连接的活动 SSH 会话')
    expect(within(dialog).getByRole('button', { name: '启动转发' })).toBeDisabled()
  })

  it('creates a local rule with the loopback default address', async () => {
    const user = userEvent.setup()
    const created = {
      ...item({
        ...LOCAL_RULE,
        id: 'pf-new',
        name: '新转发',
        bindAddress: '127.0.0.1',
        bindPort: 15432,
        targetHost: '10.0.0.5',
        targetPort: 5432,
      }),
    }
    const create = vi.fn(async () => ({ ok: true as const, value: created }))
    window.termforge = bridgeWithPortForwards({ create })
    useConnectionStore.setState({ connections: [CONNECTION], groups: [], loadStatus: 'ready' })
    usePortForwardStore.setState({ loadStatus: 'ready' })
    usePortForwardStore.getState().openCreateEditor()

    render(<PortForwardEditorModal />)

    const dialog = screen.getByRole('dialog', { name: '新建端口转发规则' })
    await user.type(within(dialog).getByLabelText(/规则名称/), '新转发')
    await user.type(within(dialog).getByLabelText(/监听端口/), '15432')
    await user.clear(within(dialog).getByLabelText(/目标主机/))
    await user.type(within(dialog).getByLabelText(/目标主机/), '10.0.0.5')
    await user.type(within(dialog).getByLabelText(/目标端口/), '5432')
    await user.click(within(dialog).getByRole('button', { name: '创建规则' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        type: 'local',
        name: '新转发',
        connectionId: 'conn-1',
        bindAddress: '127.0.0.1',
        bindPort: 15432,
        targetHost: '10.0.0.5',
        targetPort: 5432,
      })
    })
    expect(usePortForwardStore.getState().editor.open).toBe(false)
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('转发规则已创建')
  })

  it('ignores stale snapshots and never marks a rule running after a rejected start', async () => {
    window.termforge = bridgeWithPortForwards({
      list: async () => ({ ok: true, value: { revision: 0, items: [] } }),
      start: async () => ({
        ok: false,
        error: { code: 'conflict', message: '该规则已在其他会话运行。' },
      }),
    })
    usePortForwardStore.getState().applySnapshot({
      snapshot: { revision: 5, items: [item(LOCAL_RULE)] },
    })
    usePortForwardStore.getState().applySnapshot({
      snapshot: { revision: 4, items: [] },
    })
    expect(usePortForwardStore.getState().items).toHaveLength(1)

    await expect(
      usePortForwardStore.getState().startRule({
        ruleId: LOCAL_RULE.id,
        sessionId: 'ssh-1',
      }),
    ).rejects.toThrow('该规则已在其他会话运行。')
    expect(usePortForwardStore.getState().items[0]?.runtime.status).toBe('stopped')
    expect(usePortForwardStore.getState().actionError).toBe('该规则已在其他会话运行。')
  })
})
