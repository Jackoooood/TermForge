import { ArrowUpDown, SquareTerminal } from 'lucide-react'
import { isActiveTransferStatus } from '@shared/types'
import { StatusDot } from '@renderer/components/common/StatusDot'
import { useAppStore } from '@renderer/stores/appStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useTransferStore } from '@renderer/stores/transferStore'

const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  other: '其他平台',
}

export function StatusBar() {
  const sessions = useSessionStore((state) => state.sessions)
  const shells = useTerminalStore((state) => state.shells)
  const tasks = useTransferStore((state) => state.tasks)
  const transferPanelOpen = useTransferStore((state) => state.panelOpen)
  const toggleTransferPanel = useTransferStore((state) => state.togglePanel)
  const appInfo = useAppStore((state) => state.appInfo)
  const bridgeStatus = useAppStore((state) => state.bridgeStatus)
  const bridgeError = useAppStore((state) => state.bridgeError)

  const sessionList = Object.values(sessions)
  const connectedCount = sessionList.filter((session) => session.status === 'connected').length
  const openShellCount = sessionList.filter(
    (session) => shells[session.id]?.status === 'open',
  ).length
  const pendingCount = sessionList.filter((session) =>
    ['connecting', 'authenticating', 'awaiting-host-key', 'reconnecting'].includes(session.status),
  ).length
  const activeTransfers = tasks.filter((task) => isActiveTransferStatus(task.status)).length
  const conflictTransfers = tasks.filter(
    (task) => task.status === 'waitingForConflictResolution',
  ).length

  let bridgeText = '读取应用信息…'
  if (bridgeStatus === 'unavailable') bridgeText = '浏览器预览 · 未加载 preload bridge'
  if (bridgeStatus === 'ready' && appInfo) {
    const platform = PLATFORM_LABELS[appInfo.platform] ?? appInfo.platform
    bridgeText = `${appInfo.appName} v${appInfo.appVersion} · ${platform}`
  }

  return (
    <footer className="status-bar" aria-label="状态栏">
      <div className="status-bar__group">
        <span className="status-bar__item" title="渲染进程与主进程数据桥已就绪">
          <StatusDot status="online" label="工作区就绪" />
          <span>工作区就绪</span>
        </span>
        <span
          className="status-bar__item"
          title={`${sessionList.length} 个主进程 SSH 会话，其中 ${connectedCount} 个已连接、${openShellCount} 个 Shell 已打开`}
        >
          <SquareTerminal size={11} aria-hidden="true" />
          <span>
            SSH 会话 {sessionList.length} · 已连接 {connectedCount} · Shell {openShellCount}
            {pendingCount > 0 ? ` · 进行中 ${pendingCount}` : ''}
          </span>
        </span>
        <button
          type="button"
          className={
            activeTransfers > 0 || transferPanelOpen
              ? 'status-bar__item status-bar__item--active'
              : 'status-bar__item'
          }
          title="打开或收起主进程传输队列"
          aria-expanded={transferPanelOpen}
          onClick={toggleTransferPanel}
        >
          <ArrowUpDown size={11} aria-hidden="true" />
          <span>
            传输任务 {tasks.length}
            {activeTransfers > 0 ? ` · 进行中 ${activeTransfers}` : ''}
            {conflictTransfers > 0 ? ` · 待处理冲突 ${conflictTransfers}` : ''}
          </span>
        </button>
      </div>

      <span className="status-bar__spacer" aria-hidden="true" />

      <span
        className="status-bar__badge"
        title="SSH 会话与 SFTP 文件传输均由 Electron 主进程执行"
      >
        {bridgeStatus === 'unavailable'
          ? '浏览器预览 · 无 SSH 能力'
          : '主进程管理 SSH 与文件传输'}
      </span>
      <span
        className={
          bridgeStatus === 'unavailable'
            ? 'status-bar__bridge status-bar__bridge--error'
            : 'status-bar__bridge'
        }
        title={bridgeError ?? 'preload 只读 bridge 状态'}
      >
        {bridgeText}
      </span>
    </footer>
  )
}
