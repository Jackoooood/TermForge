import {
  ClipboardPaste,
  Columns2,
  Copy,
  Eraser,
  FolderSync,
  KeyRound,
  PanelLeftClose,
  PlugZap,
  RotateCw,
  Rows2,
  Search,
  SquareTerminal,
  X,
  Zap,
} from 'lucide-react'
import type { SessionInfo } from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import type { BadgeTone } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { StatusDot, statusLabel } from '@renderer/components/common/StatusDot'
import { closeTerminalShell } from '@renderer/services/terminalRuntime'
import { useAppStore } from '@renderer/stores/appStore'
import { useQuickCommandStore } from '@renderer/stores/quickCommandStore'
import { promptForCredentialIfNeeded, useSessionStore } from '@renderer/stores/sessionStore'
import { getTerminalToolController, useTerminalToolStore } from '@renderer/stores/terminalToolStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'

interface TerminalToolbarProps {
  session: SessionInfo
}

const BUSY_STATUSES = new Set<SessionInfo['status']>([
  'connecting',
  'authenticating',
  'awaiting-host-key',
  'reconnecting',
])

const SHELL_LABELS = {
  idle: 'Shell 未打开',
  opening: 'Shell 启动中',
  open: 'Shell 就绪',
  closing: 'Shell 关闭中',
  closed: 'Shell 已关闭',
  exited: 'Shell 已退出',
  error: 'Shell 异常',
} as const

const SHELL_TONES: Record<string, BadgeTone> = {
  idle: 'neutral',
  opening: 'warning',
  open: 'success',
  closing: 'warning',
  closed: 'warning',
  exited: 'warning',
  error: 'danger',
}

export function TerminalToolbar({ session }: TerminalToolbarProps) {
  const requestDisconnect = useSessionStore((state) => state.requestDisconnect)
  const cancelConnect = useSessionStore((state) => state.cancelConnect)
  const reconnectSession = useSessionStore((state) => state.reconnectSession)
  const openQuickCommands = useQuickCommandStore((state) => state.openDrawer)
  const split = useWorkspaceStore((state) => state.split)
  const enableSplit = useWorkspaceStore((state) => state.enableSplit)
  const disableSplit = useWorkspaceStore((state) => state.disableSplit)
  const setSplitDirection = useWorkspaceStore((state) => state.setSplitDirection)
  const sftpDockOpen = useWorkspaceStore((state) => state.sftpDockOpen)
  const toggleSftpDock = useWorkspaceStore((state) => state.toggleSftpDock)
  const shell = useTerminalStore((state) => state.shells[session.id])
  const shellStatus = shell?.status ?? 'idle'
  const hasSelection = useTerminalToolStore((state) => state.selection[session.id] ?? false)
  const pushToast = useAppStore((state) => state.pushToast)
  const showShell = session.status === 'connected'
  const canCloseShell = showShell && (shellStatus === 'open' || shellStatus === 'opening')
  const busy = BUSY_STATUSES.has(session.status)
  const autoReconnectActive = session.autoReconnect !== null && !session.autoReconnect.exhausted
  const canRetry = session.status === 'error' || session.status === 'disconnected'
  const canProvideCredential =
    session.status === 'error' && session.failure?.credentialKind !== undefined

  const handleCopy = async (): Promise<void> => {
    const controller = getTerminalToolController(session.id)
    if (!controller) {
      pushToast({
        tone: 'warning',
        title: '终端尚未就绪',
        description: '请等待远程 Shell 启动后再复制。',
      })
      return
    }
    const result = await controller.copySelection()
    if (result === 'copied') {
      pushToast({ tone: 'success', title: '已复制终端选中内容' })
    } else if (result === 'empty') {
      pushToast({
        tone: 'warning',
        title: '没有选中内容',
        description: '先在终端中拖选文本，再执行复制。',
      })
    } else {
      pushToast({
        tone: 'danger',
        title: '复制失败',
        description: '无法写入系统剪贴板，请稍后重试。',
      })
    }
  }

  const handlePaste = async (): Promise<void> => {
    const controller = getTerminalToolController(session.id)
    if (!controller) {
      pushToast({
        tone: 'warning',
        title: '终端尚未就绪',
        description: '请等待远程 Shell 启动后再粘贴。',
      })
      return
    }
    const result = await controller.pasteClipboard()
    if (result === 'pasted') {
      pushToast({ tone: 'success', title: '已粘贴到终端' })
    } else if (result === 'empty') {
      pushToast({ tone: 'warning', title: '剪贴板为空', description: '没有可粘贴的文本。' })
    } else {
      pushToast({
        tone: 'danger',
        title: '粘贴失败',
        description: '终端未就绪，或无法读取系统剪贴板。',
      })
    }
  }

  const handleClear = (): void => {
    const controller = getTerminalToolController(session.id)
    if (!controller) return
    controller.clearBuffer()
    pushToast({
      tone: 'info',
      title: '已清除终端缓存',
      description: '仅清空本地显示与回放缓冲，不会清屏远程 Shell。',
    })
  }

  const handleFind = (): void => {
    getTerminalToolController(session.id)?.openSearch()
  }

  return (
    <div className="terminal-toolbar">
      <div className="terminal-toolbar__left">
        <SquareTerminal
          className="terminal-toolbar__icon"
          size={15}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="terminal-toolbar__title">{session.title}</span>
        <span className="terminal-toolbar__identity">
          {session.username}@{session.host}:{session.port}
        </span>
        <span className="terminal-toolbar__status">
          <StatusDot status={session.status} />
          {statusLabel(session.status)}
        </span>
        <Badge tone="primary" title="由 Electron 主进程管理的 SSH 会话">
          SSH
        </Badge>
        {showShell ? (
          <>
            <Badge
              tone={SHELL_TONES[shellStatus] ?? 'neutral'}
              title="主进程 PTY 状态；SSH 已连接不等于 Shell 已就绪"
            >
              {SHELL_LABELS[shellStatus]}
            </Badge>
            {shellStatus === 'open' && shell ? (
              <span
                className="terminal-toolbar__size"
                title={`PTY ${shell.size.cols} 列 × ${shell.size.rows} 行`}
              >
                {shell.size.cols}×{shell.size.rows}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="terminal-toolbar__actions">
        {session.hasTerminal ? (
          <div className="terminal-toolbar__tools" role="group" aria-label="终端操作">
            <Button
              variant="ghost"
              size="sm"
              aria-label="复制"
              title="复制选中的终端文本（Ctrl+Shift+C）"
              disabled={!hasSelection}
              onClick={() => void handleCopy()}
            >
              <Copy size={14} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="粘贴"
              title="把系统剪贴板文本粘贴到终端（Ctrl+Shift+V）；Shell 就绪后可用"
              disabled={shellStatus !== 'open'}
              onClick={() => void handlePaste()}
            >
              <ClipboardPaste size={14} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="清除缓存"
              title="清除本地终端显示与回放缓冲；不会向远程 Shell 发送清屏命令"
              onClick={handleClear}
            >
              <Eraser size={14} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="查找"
              title="在当前终端回滚缓冲中查找（Ctrl+Shift+F）"
              onClick={handleFind}
            >
              <Search size={14} aria-hidden="true" />
            </Button>
          </div>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-label={sftpDockOpen ? '隐藏 SFTP 面板' : '显示 SFTP 面板'}
          title={
            sftpDockOpen
              ? '隐藏工作台右侧的 SFTP 文件面板'
              : '在工作台右侧显示 SFTP 文件面板（跟随当前会话）'
          }
          aria-pressed={sftpDockOpen}
          onClick={toggleSftpDock}
        >
          <FolderSync size={14} aria-hidden="true" />
        </Button>
        {split.enabled ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label="左右"
              title="切换为左右分屏"
              aria-pressed={split.direction === 'row'}
              onClick={() => setSplitDirection('row')}
            >
              <Columns2 size={14} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="上下"
              title="切换为上下分屏"
              aria-pressed={split.direction === 'column'}
              onClick={() => setSplitDirection('column')}
            >
              <Rows2 size={14} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="退出分屏"
              title="退出分屏；仅合并布局，不关闭任何 SSH 会话"
              onClick={disableSplit}
            >
              <PanelLeftClose size={14} aria-hidden="true" />
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label="左右分屏"
              title="左右分屏；仅改变布局，不建立新的 SSH 连接"
              onClick={() => enableSplit('row')}
            >
              <Columns2 size={14} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="上下分屏"
              title="上下分屏；仅改变布局，不建立新的 SSH 连接"
              onClick={() => enableSplit('column')}
            >
              <Rows2 size={14} aria-hidden="true" />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label="快速命令"
          title="打开快速命令与命令历史"
          onClick={() => openQuickCommands(session.id)}
        >
          <Zap size={14} aria-hidden="true" />
        </Button>
        {canCloseShell ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="关闭 Shell"
            title="关闭远程 Shell，但保留 SSH 连接"
            onClick={() => void closeTerminalShell(session.id)}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        ) : null}
        {session.status === 'connected' ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label="断开连接"
            title="断开 SSH 连接"
            onClick={() => void requestDisconnect(session.id)}
          >
            <PlugZap size={14} aria-hidden="true" />
          </Button>
        ) : null}
        {(busy || session.status === 'closing') && !autoReconnectActive ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={session.status === 'closing' ? '正在断开…' : '取消连接'}
            title={session.status === 'closing' ? '正在断开连接' : '取消进行中的连接尝试'}
            disabled={session.status === 'closing'}
            onClick={() => void cancelConnect(session.id)}
          >
            <PlugZap size={14} aria-hidden="true" />
          </Button>
        ) : null}
        {canRetry ? (
          <Button
            variant="primary"
            size="sm"
            aria-label="重新连接"
            title="重新连接；会创建新的 SSH 传输与新的远程 Shell"
            onClick={() => void reconnectSession(session.id)}
          >
            <RotateCw size={14} aria-hidden="true" />
          </Button>
        ) : null}
        {canProvideCredential ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="输入凭据"
            title="补录缺失的认证凭据"
            onClick={() => promptForCredentialIfNeeded(session)}
          >
            <KeyRound size={14} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
