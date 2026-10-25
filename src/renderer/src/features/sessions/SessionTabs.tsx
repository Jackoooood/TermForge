import { useRef, useState } from 'react'
import type { WheelEvent } from 'react'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  Plus,
  Server,
  SquareTerminal,
  X,
  XCircle,
  XSquare,
} from 'lucide-react'
import { FloatingMenu, MenuItem, MenuLabel, MenuSeparator } from '@renderer/components/common/Menu'
import type { MenuPosition } from '@renderer/components/common/Menu'
import { StatusDot, statusLabel } from '@renderer/components/common/StatusDot'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { paneIdForTab } from '@renderer/features/terminal/splitLayout'
import { openConnectionSession } from './openConnectionSession'
import { formatSshFailureMessage } from '@renderer/lib/formatSshFailure'

function positionBelow(button: HTMLButtonElement): MenuPosition {
  const rect = button.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom + 4 }
}

export function SessionTabs() {
  const sessions = useSessionStore((state) => state.sessions)
  const closeSession = useSessionStore((state) => state.closeSession)
  const shells = useTerminalStore((state) => state.shells)
  const connections = useConnectionStore((state) => state.connections)
  const openCreateEditor = useConnectionStore((state) => state.openCreateEditor)
  const tabOrder = useWorkspaceStore((state) => state.tabOrder)
  const activeTabId = useWorkspaceStore((state) => state.activeTabId)
  const activateTab = useWorkspaceStore((state) => state.activateTab)
  const split = useWorkspaceStore((state) => state.split)
  const tabsRef = useRef<HTMLDivElement>(null)
  const [newSessionMenu, setNewSessionMenu] = useState<MenuPosition | null>(null)
  const [overflowMenu, setOverflowMenu] = useState<MenuPosition | null>(null)
  const [tabMenu, setTabMenu] = useState<{ position: MenuPosition; tabId: string } | null>(null)

  const orderedSessions = tabOrder
    .map((tabId) => sessions[tabId])
    .filter((session): session is NonNullable<typeof session> => Boolean(session))
  const openConnectionCounts = new Map<string, number>()
  for (const session of orderedSessions) {
    openConnectionCounts.set(
      session.connectionId,
      (openConnectionCounts.get(session.connectionId) ?? 0) + 1,
    )
  }

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const element = tabsRef.current
    if (!element || element.scrollWidth <= element.clientWidth) return
    element.scrollLeft += event.deltaY !== 0 ? event.deltaY : event.deltaX
  }

  const handleOverflow = (button: HTMLButtonElement): void => {
    const rect = button.getBoundingClientRect()
    setOverflowMenu((current) =>
      current ? null : { x: Math.max(8, rect.right - 232), y: rect.bottom + 4 },
    )
  }

  const closeTabs = (tabIds: string[]): void => {
    setTabMenu(null)
    for (const tabId of tabIds) void closeSession(tabId)
  }

  const tabMenuIndex = tabMenu
    ? orderedSessions.findIndex((session) => session.id === tabMenu.tabId)
    : -1
  const tabMenuSession = tabMenuIndex >= 0 ? orderedSessions[tabMenuIndex] : null

  return (
    <div className="tabs-bar">
      <div
        ref={tabsRef}
        className="tabs-bar__scroll"
        role="tablist"
        aria-label="会话标签"
        onWheel={handleWheel}
      >
        {orderedSessions.map((session) => {
          const active = session.id === activeTabId
          const closing = session.status === 'closing'
          const shellOpen = shells[session.id]?.status === 'open'
          const paneId = split.enabled ? paneIdForTab(split, session.id) : null
          const statusText = session.failure
            ? `${statusLabel(session.status)}：${formatSshFailureMessage(session.failure)}`
            : statusLabel(session.status)
          return (
            <div
              key={session.id}
              id={`session-tab-${session.id}`}
              role="tab"
              aria-selected={active}
              aria-controls={`terminal-panel-${session.id}`}
              tabIndex={active ? 0 : -1}
              title={statusText}
              className={active ? 'session-tab session-tab--active' : 'session-tab'}
              onClick={() => activateTab(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activateTab(session.id)
                }
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  if (!closing) void closeSession(session.id)
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                setTabMenu({
                  position: { x: event.clientX, y: event.clientY },
                  tabId: session.id,
                })
              }}
            >
              <StatusDot status={session.status} label={statusText} />
              <span className="session-tab__label" title={session.title}>
                {session.title}
              </span>
              {shellOpen ? (
                <SquareTerminal
                  className="session-tab__shell"
                  size={11}
                  aria-label="Shell 已就绪"
                />
              ) : null}
              {paneId ? (
                <span
                  className={
                    paneId === split.focusedPaneId
                      ? 'session-tab__pane session-tab__pane--focused'
                      : 'session-tab__pane'
                  }
                  title={`显示在${paneId === 'pane-a' ? '第一' : '第二'}个分屏窗格`}
                >
                  {paneId === 'pane-a' ? 'A' : 'B'}
                </span>
              ) : null}
              <button
                type="button"
                className="session-tab__close"
                aria-label={`关闭 ${session.title} 会话`}
                title={closing ? `正在关闭 ${session.title}` : `关闭 ${session.title}`}
                aria-busy={closing}
                disabled={closing}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!closing) void closeSession(session.id)
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          )
        })}
        {orderedSessions.length === 0 ? (
          <span className="tabs-bar__empty">暂无打开的会话</span>
        ) : null}
      </div>

      <div className="tabs-bar__actions">
        <button
          type="button"
          className="tabs-bar__button"
          aria-label="新建会话"
          title="连接服务器"
          onClick={(event) => {
            const trigger = event.currentTarget
            setNewSessionMenu((current) => (current ? null : positionBelow(trigger)))
          }}
        >
          <Plus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tabs-bar__button"
          aria-label="所有会话"
          title="所有打开的会话"
          disabled={orderedSessions.length === 0}
          onClick={(event) => handleOverflow(event.currentTarget)}
        >
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      </div>

      {newSessionMenu ? (
        <FloatingMenu
          position={newSessionMenu}
          onClose={() => setNewSessionMenu(null)}
          ariaLabel="选择服务器建立 SSH 连接"
          className="floating-menu--picker"
        >
          <MenuLabel>连接服务器</MenuLabel>
          {connections.length > 0 ? (
            <div className="menu-scroll">
              {connections.map((connection) => {
                const openCount = openConnectionCounts.get(connection.id) ?? 0
                return (
                  <MenuItem
                    key={connection.id}
                    icon={Server}
                    label={connection.name}
                    description={
                      openCount > 0
                        ? `已打开 ${openCount} 个会话 · 再次选择会新建独立 SSH 连接`
                        : `${connection.username}@${connection.host}:${connection.port}`
                    }
                    onSelect={() => {
                      void openConnectionSession(connection)
                      setNewSessionMenu(null)
                    }}
                  />
                )
              })}
            </div>
          ) : (
            <p className="menu-empty">暂无可用连接</p>
          )}
          <MenuSeparator />
          <MenuItem
            icon={Plus}
            label="新建连接…"
            onSelect={() => {
              setNewSessionMenu(null)
              openCreateEditor()
            }}
          />
        </FloatingMenu>
      ) : null}

      {overflowMenu ? (
        <FloatingMenu
          position={overflowMenu}
          onClose={() => setOverflowMenu(null)}
          ariaLabel="所有打开的会话"
        >
          <MenuLabel>所有会话</MenuLabel>
          {orderedSessions.map((session) => (
            <MenuItem
              key={session.id}
              icon={SquareTerminal}
              label={session.title}
              description={session.id === activeTabId ? '当前会话' : statusLabel(session.status)}
              onSelect={() => {
                activateTab(session.id)
                setOverflowMenu(null)
              }}
            />
          ))}
        </FloatingMenu>
      ) : null}

      {tabMenu && tabMenuSession ? (
        <FloatingMenu
          position={tabMenu.position}
          onClose={() => setTabMenu(null)}
          ariaLabel={`${tabMenuSession.title} 标签页操作`}
        >
          <MenuLabel>{tabMenuSession.title}</MenuLabel>
          <MenuItem
            icon={X}
            label="关闭标签页"
            disabled={tabMenuSession.status === 'closing'}
            onSelect={() => closeTabs([tabMenuSession.id])}
          />
          <MenuItem
            icon={XCircle}
            label="关闭其他标签页"
            disabled={orderedSessions.length <= 1}
            onSelect={() =>
              closeTabs(
                orderedSessions
                  .filter((session) => session.id !== tabMenuSession.id)
                  .map((session) => session.id),
              )
            }
          />
          <MenuSeparator />
          <MenuItem
            icon={ArrowLeftToLine}
            label="关闭左边标签页"
            disabled={tabMenuIndex <= 0}
            onSelect={() =>
              closeTabs(orderedSessions.slice(0, tabMenuIndex).map((session) => session.id))
            }
          />
          <MenuItem
            icon={ArrowRightToLine}
            label="关闭右边标签页"
            disabled={tabMenuIndex === orderedSessions.length - 1}
            onSelect={() =>
              closeTabs(orderedSessions.slice(tabMenuIndex + 1).map((session) => session.id))
            }
          />
          <MenuSeparator />
          <MenuItem
            icon={XSquare}
            label="关闭全部标签页"
            onSelect={() => closeTabs(orderedSessions.map((session) => session.id))}
          />
        </FloatingMenu>
      ) : null}
    </div>
  )
}
