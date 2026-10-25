import { SquareTerminal } from 'lucide-react'
import type { ChangeEvent } from 'react'
import type { SplitPaneId } from '@renderer/features/terminal/splitLayout'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'

interface TerminalEmptyPaneProps {
  paneId: SplitPaneId
  direction: 'row' | 'column'
}

export function TerminalEmptyPane({ paneId, direction }: TerminalEmptyPaneProps) {
  const sessions = useSessionStore((state) => state.sessions)
  const tabOrder = useWorkspaceStore((state) => state.tabOrder)
  const split = useWorkspaceStore((state) => state.split)
  const assignPaneTab = useWorkspaceStore((state) => state.assignPaneTab)
  const otherPane = paneId === 'pane-a' ? 'pane-b' : 'pane-a'
  const boundElsewhere = split.panes[otherPane].tabId
  const candidates = tabOrder.filter((tabId) => tabId !== boundElsewhere && sessions[tabId])
  const slotLabel =
    direction === 'row'
      ? paneId === 'pane-a'
        ? '左侧'
        : '右侧'
      : paneId === 'pane-a'
        ? '上方'
        : '下方'

  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const tabId = event.currentTarget.value
    if (tabId) assignPaneTab(paneId, tabId)
  }

  return (
    <section
      className={`terminal-empty-pane terminal-empty-pane--slot-${paneId === 'pane-a' ? 'a' : 'b'}`}
      aria-label={`${slotLabel}空窗格`}
    >
      <div className="terminal-empty-pane__card">
        <span className="terminal-empty-pane__icon" aria-hidden="true">
          <SquareTerminal size={20} />
        </span>
        <h4 className="terminal-empty-pane__title">空窗格</h4>
        <p className="terminal-empty-pane__description">
          选择一个已打开的会话放入{slotLabel}窗格。分屏只改变布局，不会创建新的 SSH 连接。
        </p>
        <label className="terminal-empty-pane__field">
          <span>已打开的会话</span>
          <select
            className="terminal-empty-pane__select"
            aria-label={`选择放入${slotLabel}窗格的会话`}
            value=""
            disabled={candidates.length === 0}
            onChange={handleChange}
          >
            <option value="">
              {candidates.length === 0 ? '没有可放入的其他会话' : '选择会话…'}
            </option>
            {candidates.map((tabId) => {
              const session = sessions[tabId]
              if (!session) return null
              return (
                <option key={tabId} value={tabId}>
                  {session.title} · {session.username}@{session.host}
                </option>
              )
            })}
          </select>
        </label>
        <p className="terminal-empty-pane__hint">
          也可以点击标签栏中的其他会话；它会被放入这个空窗格。
        </p>
      </div>
    </section>
  )
}
