import type { CSSProperties } from 'react'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { TerminalEmptyPane } from '@renderer/components/terminal/TerminalEmptyPane'
import { TerminalPane } from '@renderer/components/terminal/TerminalPane'
import { TerminalSplitDivider } from '@renderer/components/terminal/TerminalSplitDivider'
import { TerminalToolbar } from '@renderer/components/terminal/TerminalToolbar'
import { paneIdForTab } from './splitLayout'

export function TerminalWorkspace() {
  const sessions = useSessionStore((state) => state.sessions)
  const tabOrder = useWorkspaceStore((state) => state.tabOrder)
  const activeTabId = useWorkspaceStore((state) => state.activeTabId)
  const split = useWorkspaceStore((state) => state.split)
  const setSplitRatio = useWorkspaceStore((state) => state.setSplitRatio)
  const activeSession = activeTabId ? sessions[activeTabId] ?? null : null

  if (!activeSession) return null

  const stageClass = split.enabled
    ? `terminal-stage terminal-stage--split terminal-stage--split-${split.direction}`
    : 'terminal-stage'
  const stageStyle = split.enabled
    ? ({ '--split-ratio': `${split.ratio * 100}%` } as CSSProperties)
    : undefined

  return (
    <div className="terminal-workspace">
      <TerminalToolbar session={activeSession} />
      <div className={stageClass} style={stageStyle} aria-label="终端工作区">
        {tabOrder.map((tabId) => {
          const session = sessions[tabId]
          if (!session) return null
          const paneId = split.enabled ? paneIdForTab(split, tabId) : null
          const visible = split.enabled ? paneId !== null : tabId === activeTabId
          const focused = split.enabled
            ? visible && paneId === split.focusedPaneId
            : tabId === activeTabId
          return (
            <TerminalPane
              key={session.id}
              session={session}
              visible={visible}
              focused={focused}
              paneId={paneId}
              splitDirection={split.direction}
            />
          )
        })}
        {split.enabled ? (
          <>
            {split.panes['pane-a'].tabId === null ? (
              <TerminalEmptyPane paneId="pane-a" direction={split.direction} />
            ) : null}
            {split.panes['pane-b'].tabId === null ? (
              <TerminalEmptyPane paneId="pane-b" direction={split.direction} />
            ) : null}
            <TerminalSplitDivider
              direction={split.direction}
              ratio={split.ratio}
              onChange={setSplitRatio}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}
