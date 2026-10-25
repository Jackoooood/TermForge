import { useRef } from 'react'
import { FolderSync, Server, SquareTerminal } from 'lucide-react'
import { Button } from '@renderer/components/common/Button'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import {
  SFTP_DOCK_MAX_WIDTH,
  SFTP_DOCK_MIN_WIDTH,
  useWorkspaceStore,
} from '@renderer/stores/workspaceStore'
import { openConnectionSession } from '@renderer/features/sessions/openConnectionSession'
import { SessionTabs } from '@renderer/features/sessions/SessionTabs'
import { TerminalWorkspace } from '@renderer/features/terminal/TerminalWorkspace'
import { SftpDock } from '@renderer/features/workbench/SftpDock'
import { PaneResizer } from '@renderer/features/workbench/PaneResizer'

export function WorkbenchView() {
  const hasSessions = useWorkspaceStore((state) => state.tabOrder.length > 0)
  const sftpDockOpen = useWorkspaceStore((state) => state.sftpDockOpen)
  const sftpDockWidth = useWorkspaceStore((state) => state.sftpDockWidth)
  const setSftpDockWidth = useWorkspaceStore((state) => state.setSftpDockWidth)
  const dockAreaRef = useRef<HTMLDivElement>(null)
  const connections = useConnectionStore((state) => state.connections)
  const openCreateEditor = useConnectionStore((state) => state.openCreateEditor)
  const setActiveModule = useWorkspaceStore((state) => state.setActiveModule)

  const connectFirst = (): void => {
    const connection = connections[0]
    if (connection) {
      void openConnectionSession(connection)
      return
    }
    openCreateEditor()
  }

  return (
    <div className="workbench">
      <SessionTabs />
      {hasSessions ? (
        <div className="workbench__body">
          <div className="workbench__center">
            <TerminalWorkspace />
          </div>
          {sftpDockOpen ? (
            <div
              className="workbench__dock"
              ref={dockAreaRef}
              style={
                sftpDockWidth ? { flexBasis: `${sftpDockWidth}px` } : undefined
              }
            >
              <PaneResizer
                className="workbench__dock-resizer"
                edge="right"
                label="调整 SFTP 面板宽度"
                width={sftpDockWidth}
                min={SFTP_DOCK_MIN_WIDTH}
                max={SFTP_DOCK_MAX_WIDTH}
                fallbackWidth={380}
                getTargetWidth={() =>
                  dockAreaRef.current?.getBoundingClientRect().width ?? null
                }
                onChange={setSftpDockWidth}
                onReset={() => setSftpDockWidth(null)}
              />
              <SftpDock />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="workbench__empty">
          <EmptyState
            icon={SquareTerminal}
            title="没有打开的会话"
            description="连接到一台服务器以发起真实 SSH 握手，并在终端标签内打开远程 PTY。终端输入与输出不经过本地 shell 模拟。"
          >
            <Button variant="primary" onClick={connectFirst}>
              <SquareTerminal size={14} aria-hidden="true" />
              连接第一台服务器
            </Button>
            <Button variant="secondary" onClick={() => setActiveModule('servers')}>
              <Server size={14} aria-hidden="true" />
              管理服务器
            </Button>
            <Button variant="ghost" onClick={() => setActiveModule('sftp')}>
              <FolderSync size={14} aria-hidden="true" />
              SFTP（演示）
            </Button>
          </EmptyState>
        </div>
      )}
    </div>
  )
}
