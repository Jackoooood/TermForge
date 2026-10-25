import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  CommandHistoryClearAck,
  CommandHistoryEntry,
  QuickCommand,
  QuickCommandExecuteInput,
  TerminalShellSnapshot,
} from '@shared/types'
import { DEFAULT_TERMINAL_SIZE } from '@shared/types'
import { QuickCommandComposeModal } from '@renderer/features/quickCommands/QuickCommandComposeModal'
import { QuickCommandDrawer } from '@renderer/features/quickCommands/QuickCommandDrawer'
import { QuickCommandEditorModal } from '@renderer/features/quickCommands/QuickCommandEditorModal'
import { bindTerminalTab, resetTerminalSessions } from '@renderer/services/terminalRuntime'
import { useAppStore } from '@renderer/stores/appStore'
import { useQuickCommandStore } from '@renderer/stores/quickCommandStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge, fakeQuickCommand, fakeSessionInfo } from './helpers/fakeBridge'

const TAB_ID = 'sshtab-test'
const SESSION_ID = 'ssh-test-session'

const CUSTOM_COMMAND = fakeQuickCommand({
  id: 'qc-service-status',
  source: 'custom',
  name: '服务状态',
  category: '服务诊断',
  description: '查看指定服务状态',
  body: 'systemctl status {{service}} --no-pager',
  parameters: [{ name: 'service', defaultValue: '' }],
  editable: true,
  createdAt: '2026-10-23T08:00:00.000Z',
  updatedAt: '2026-10-23T08:00:00.000Z',
})

const HISTORY_ENTRY: CommandHistoryEntry = {
  id: 'ch-history-1',
  body: 'df -h',
  sentAt: '2026-10-23T08:00:00.000Z',
  tabId: TAB_ID,
  sessionId: SESSION_ID,
  connectionId: 'conn-prod-web-01',
  connectionName: 'prod-web-01',
  host: '10.20.4.11',
}

function openShell(sessionId = SESSION_ID): TerminalShellSnapshot {
  return {
    sessionId,
    status: 'open',
    size: { ...DEFAULT_TERMINAL_SIZE },
    failure: null,
    exit: null,
  }
}

function setupTarget(tabId = TAB_ID, sessionId = SESSION_ID): void {
  useSessionStore.setState({
    sessions: {
      [tabId]: fakeSessionInfo({
        id: tabId,
        sessionId,
        connectionName: 'prod-web-01',
        title: 'prod-web-01',
      }),
    },
  })
  useTerminalStore.setState({ shells: { [tabId]: openShell(sessionId) } })
}

beforeEach(() => {
  resetTerminalSessions()
  useQuickCommandStore.getState().reset()
  useSessionStore.setState({ sessions: {} })
  useTerminalStore.setState({ shells: {} })
  useWorkspaceStore.setState({ activeTabId: null, tabOrder: [] })
  useSettingsStore.setState({ commandHistoryEnabled: false })
  useAppStore.setState({ toasts: [] })
  window.termforge = createFakeBridge()
})

describe('quick command drawer', () => {
  it('keeps built-ins read-only while allowing favorite and custom editing actions', async () => {
    const user = userEvent.setup()
    const setFavorite = vi.fn(async (id: string, favorite: boolean) => ({
      ok: true as const,
      value:
        id === CUSTOM_COMMAND.id ? { ...CUSTOM_COMMAND, favorite } : fakeQuickCommand({ favorite }),
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { setFavorite })
    useQuickCommandStore.setState({
      drawerOpen: true,
      commands: [fakeQuickCommand(), CUSTOM_COMMAND],
      commandsStatus: 'ready',
      history: [],
      historyStatus: 'ready',
    })

    render(<QuickCommandDrawer />)

    const builtIn = screen.getByRole('article', { name: '系统运行时间' })
    expect(within(builtIn).getByText('内置 · 只读')).toBeInTheDocument()
    expect(within(builtIn).queryByRole('button', { name: /编辑/ })).not.toBeInTheDocument()
    expect(within(builtIn).queryByRole('button', { name: /删除/ })).not.toBeInTheDocument()
    expect(within(builtIn).getByRole('button', { name: '收藏 系统运行时间' })).toBeInTheDocument()

    const custom = screen.getByRole('article', { name: '服务状态' })
    expect(within(custom).getByRole('button', { name: '编辑 服务状态' })).toBeInTheDocument()
    expect(within(custom).getByRole('button', { name: '删除 服务状态' })).toBeInTheDocument()

    await user.click(within(custom).getByRole('button', { name: '收藏 服务状态' }))
    await waitFor(() => expect(setFavorite).toHaveBeenCalledWith(CUSTOM_COMMAND.id, true))
    expect(
      await within(custom).findByRole('button', { name: '取消收藏 服务状态' }),
    ).toBeInTheDocument()
  })

  it('shows the history-off disclosure and clears history only after confirmation', async () => {
    const user = userEvent.setup()
    const clear = vi.fn(async () => ({
      ok: true as const,
      value: { cleared: 1 } satisfies CommandHistoryClearAck,
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { clear })
    useQuickCommandStore.setState({
      drawerOpen: true,
      activePane: 'history',
      commands: [],
      commandsStatus: 'ready',
      history: [HISTORY_ENTRY],
      historyStatus: 'ready',
    })

    render(<QuickCommandDrawer />)

    expect(screen.getByText(/命令历史已在设置中关闭/)).toBeInTheDocument()
    expect(screen.getByText(/command-history\.json/)).toBeInTheDocument()
    expect(screen.getByRole('article', { name: /历史记录 df -h/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清空历史' }))
    const confirm = screen.getByRole('alertdialog', { name: '确认清空命令历史' })
    expect(clear).not.toHaveBeenCalled()

    await user.click(within(confirm).getByRole('button', { name: '确认清空' }))
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1))
    expect(useQuickCommandStore.getState().history).toEqual([])
    expect(screen.getByText('还没有命令历史')).toBeInTheDocument()
  })
})

describe('quick command send confirmation', () => {
  it('previews the rendered command, preselects the captured target and records history by default', async () => {
    const user = userEvent.setup()
    const execute = vi.fn(async (input: QuickCommandExecuteInput) => ({
      ok: true as const,
      value: {
        requestId: input.requestId,
        body: 'systemctl status nginx --no-pager',
        writtenAt: '2026-10-23T08:00:00.000Z',
        historyRecorded: input.recordHistory,
        historyWarning: null,
      },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { execute })
    setupTarget()
    useSettingsStore.setState({ commandHistoryEnabled: true })
    useQuickCommandStore.setState({
      commands: [CUSTOM_COMMAND],
      commandsStatus: 'ready',
      capturedTarget: { tabId: TAB_ID, sessionId: SESSION_ID },
      compose: {
        intent: 'send',
        source: { kind: 'command', commandId: CUSTOM_COMMAND.id },
      },
    })

    render(<QuickCommandComposeModal />)

    const target = screen.getByLabelText('目标终端（显式选择）')
    expect(target).toHaveValue(`${TAB_ID}|${SESSION_ID}`)

    const parameter = screen.getByLabelText('service')
    await user.type(parameter, 'nginx')
    expect(screen.getByLabelText('最终命令预览')).toHaveTextContent(
      'systemctl status nginx --no-pager',
    )

    const historyToggle = screen.getByRole('checkbox', {
      name: /记录本次发送到命令历史/,
    })
    expect(historyToggle).toBeChecked()

    await user.click(screen.getByRole('button', { name: '确认发送' }))
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1))

    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      kind: 'command',
      commandId: CUSTOM_COMMAND.id,
      parameterValues: { service: 'nginx' },
      tabId: TAB_ID,
      sessionId: SESSION_ID,
      recordHistory: true,
    })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认发送快速命令' })).not.toBeInTheDocument(),
    )
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
      tone: 'success',
      title: '命令已写入终端并记录历史',
    })
  })

  it('never auto-switches when the captured target became invalid and requires a new explicit choice', async () => {
    const user = userEvent.setup()
    const execute = vi.fn(async (input: QuickCommandExecuteInput) => ({
      ok: true as const,
      value: {
        requestId: input.requestId,
        body: 'uptime',
        writtenAt: '2026-10-23T08:00:00.000Z',
        historyRecorded: false,
        historyWarning: null,
      },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { execute })
    setupTarget()
    useSettingsStore.setState({ commandHistoryEnabled: true })
    useQuickCommandStore.setState({
      commands: [fakeQuickCommand()],
      commandsStatus: 'ready',
      capturedTarget: { tabId: 'sshtab-old', sessionId: 'ssh-old-session' },
      compose: {
        intent: 'send',
        source: { kind: 'command', commandId: 'builtin-uptime' },
      },
    })

    render(<QuickCommandComposeModal />)

    const target = screen.getByLabelText('目标终端（显式选择）')
    expect(target).toHaveValue('')
    expect(screen.getByText(/捕获的终端已断开、重连或关闭了 Shell/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认发送' })).toBeDisabled()
    expect(target).not.toHaveDisplayValue(/prod-web-01/)

    await user.selectOptions(target, `${TAB_ID}|${SESSION_ID}`)
    expect(screen.getByRole('button', { name: '确认发送' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '确认发送' }))

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      tabId: TAB_ID,
      sessionId: SESSION_ID,
      parameterValues: {},
    })
  })

  it('forces recordHistory off when the global setting is disabled', async () => {
    const user = userEvent.setup()
    const execute = vi.fn(async (input: QuickCommandExecuteInput) => ({
      ok: true as const,
      value: {
        requestId: input.requestId,
        body: 'uptime',
        writtenAt: '2026-10-23T08:00:00.000Z',
        historyRecorded: false,
        historyWarning: null,
      },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { execute })
    setupTarget()
    useQuickCommandStore.setState({
      commands: [fakeQuickCommand()],
      commandsStatus: 'ready',
      capturedTarget: { tabId: TAB_ID, sessionId: SESSION_ID },
      compose: {
        intent: 'send',
        source: { kind: 'command', commandId: 'builtin-uptime' },
      },
    })

    render(<QuickCommandComposeModal />)

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByText(/命令历史已在设置中关闭，本次发送不会记录/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '确认发送' }))
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ recordHistory: false })
  })

  it('inserts the rendered history body without a newline and never executes it', async () => {
    const user = userEvent.setup()
    const write = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: { sessionId },
    }))
    const execute = vi.fn()
    window.termforge = createFakeBridge(
      {},
      {},
      { write },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      { execute },
    )
    setupTarget()
    bindTerminalTab(TAB_ID, SESSION_ID)
    useQuickCommandStore.setState({
      commands: [],
      commandsStatus: 'ready',
      history: [HISTORY_ENTRY],
      historyStatus: 'ready',
      capturedTarget: { tabId: TAB_ID, sessionId: SESSION_ID },
      compose: {
        intent: 'insert',
        source: { kind: 'history', entryId: HISTORY_ENTRY.id },
      },
    })

    render(<QuickCommandComposeModal />)

    expect(screen.getByLabelText('最终命令预览')).toHaveTextContent('df -h')
    await user.click(screen.getByRole('button', { name: '插入到终端' }))

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(write).toHaveBeenCalledWith(SESSION_ID, 'df -h')
    expect(JSON.stringify(write.mock.calls)).not.toContain('\\r')
    expect(execute).not.toHaveBeenCalled()
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
      tone: 'success',
      title: '已插入终端输入行',
    })
  })
})

describe('quick command editor', () => {
  it('derives template parameters, blocks malformed bodies and saves the validated draft', async () => {
    const user = userEvent.setup()
    const create = vi.fn(async (draft) => ({
      ok: true as const,
      value: {
        ...CUSTOM_COMMAND,
        ...draft,
        id: 'qc-created',
      } satisfies QuickCommand,
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { create })
    useQuickCommandStore.setState({
      editor: { commandId: null },
      commands: [CUSTOM_COMMAND],
      commandsStatus: 'ready',
    })

    render(<QuickCommandEditorModal />)

    await user.type(screen.getByRole('textbox', { name: '命令名称' }), '最近日志')
    await user.type(screen.getByRole('combobox', { name: '分类' }), '服务诊断')
    const body = screen.getByRole('textbox', { name: '命令正文' })
    fireEvent.change(body, { target: { value: 'journalctl -u {{' } })
    expect(screen.getByText(/模板包含未闭合/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存命令' }))
    expect(create).not.toHaveBeenCalled()

    fireEvent.change(body, { target: { value: 'journalctl -u {{service}} -n 100' } })
    const defaultValue = screen.getByLabelText('service')
    await user.type(defaultValue, 'nginx')

    await user.click(screen.getByRole('button', { name: '保存命令' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: '最近日志',
      category: '服务诊断',
      body: 'journalctl -u {{service}} -n 100',
      parameters: [{ name: 'service', defaultValue: 'nginx' }],
    })
    expect(useQuickCommandStore.getState().editor).toBeNull()
  })
})
