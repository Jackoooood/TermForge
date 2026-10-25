import { Columns2, Rows2, X } from 'lucide-react'
import type { SessionInfo } from '@shared/types'
import { StatusDot, statusLabel } from '@renderer/components/common/StatusDot'
import type { SplitPaneId } from '@renderer/features/terminal/splitLayout'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'

interface TerminalPaneHeaderProps {
  session: SessionInfo
  paneId: SplitPaneId
  focused: boolean
  direction: 'row' | 'column'
}

export function TerminalPaneHeader({
  session,
  paneId,
  focused,
  direction,
}: TerminalPaneHeaderProps) {
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const assignPaneTab = useWorkspaceStore((state) => state.assignPaneTab)
  const slotLabel = direction === 'row' ? (paneId === 'pane-a' ? '左' : '右') : paneId === 'pane-a' ? '上' : '下'
  const DirectionIcon = direction === 'row' ? Columns2 : Rows2

  return (
    <header
      className={
        focused
          ? 'terminal-pane__header terminal-pane__header--focused'
          : 'terminal-pane__header'
      }
    >
      <button
        type="button"
        className="terminal-pane__focus"
        title="聚焦此窗格"
        onClick={() => focusPane(paneId)}
      >
        <StatusDot status={session.status} />
        <span className="terminal-pane__title">{session.title}</span>
        <span className="terminal-pane__identity">
          {session.username}@{session.host}
        </span>
        <span className="terminal-pane__state">{statusLabel(session.status)}</span>
      </button>
      <span className="terminal-pane__slot" title={`${slotLabel}侧窗格`}>
        <DirectionIcon size={11} aria-hidden="true" />
        {slotLabel}
      </span>
      <button
        type="button"
        className="terminal-pane__close"
        aria-label={`将 ${session.title} 从分屏中移除`}
        title="仅从分屏中移除，不会关闭 SSH 会话"
        onClick={() => assignPaneTab(paneId, null)}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </header>
  )
}
