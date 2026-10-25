import { useEffect, useId, useMemo } from 'react'
import { Info, Server, WifiOff } from 'lucide-react'
import { isActiveTransferStatus } from '@shared/types'
import type { RemoteFileEntry, SessionInfo, SessionStatus } from '@shared/types'
import { remoteParentPath } from '@shared/sftp/remotePath'
import { isLocalPathAtRoot } from '@shared/localFs/localPath'
import { Badge } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { useAppStore } from '@renderer/stores/appStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSftpStore } from '@renderer/stores/sftpStore'
import type { SftpViewStatus } from '@renderer/stores/sftpStore'
import { useTextEditorStore } from '@renderer/stores/textEditorStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { LocalFilePanel } from './LocalFilePanel'
import { RemoteFilePanel } from './RemoteFilePanel'
import { useSftpMutationDialog } from './useSftpMutationDialog'

const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  idle: '空闲',
  connecting: '连接中',
  authenticating: '认证中',
  'awaiting-host-key': '等待确认主机密钥',
  connected: '已连接',
  reconnecting: '重连中',
  closing: '关闭中',
  disconnected: '已断开',
  error: '连接失败',
}

export function SftpView() {
  const sessionSelectId = useId()
  const sessions = useSessionStore((state) => state.sessions)
  const tabOrder = useWorkspaceStore((state) => state.tabOrder)
  const workspaceActiveTabId = useWorkspaceStore((state) => state.activeTabId)
  const setActiveModule = useWorkspaceStore((state) => state.setActiveModule)
  const activateTab = useWorkspaceStore((state) => state.activateTab)
  const activeTabId = useSftpStore((state) => state.activeTabId)
  const setActiveTab = useSftpStore((state) => state.setActiveTab)
  const tab = useSftpStore((state) => (activeTabId ? state.tabs[activeTabId] : undefined))
  const pushToast = useAppStore((state) => state.pushToast)
  const transferTasks = useTransferStore((state) => state.tasks)
  const setTransferPanelOpen = useTransferStore((state) => state.setPanelOpen)

  const orderedSessions = useMemo(() => {
    const ids: string[] = []
    for (const id of tabOrder) {
      if (sessions[id] && !ids.includes(id)) ids.push(id)
    }
    for (const id of Object.keys(sessions)) {
      if (!ids.includes(id)) ids.push(id)
    }
    return ids
      .map((id) => sessions[id])
      .filter((session): session is SessionInfo => Boolean(session))
  }, [sessions, tabOrder])

  useEffect(() => {
    if (activeTabId && sessions[activeTabId]) return
    const preferredId =
      workspaceActiveTabId && sessions[workspaceActiveTabId]?.status === 'connected'
        ? workspaceActiveTabId
        : (orderedSessions.find((session) => session.status === 'connected')?.id ??
          orderedSessions[0]?.id ??
          null)
    if (preferredId !== activeTabId) setActiveTab(preferredId)
  }, [activeTabId, orderedSessions, sessions, setActiveTab, workspaceActiveTabId])

  const session = activeTabId ? (sessions[activeTabId] ?? null) : null
  const sessionId = session?.sessionId ?? null
  const sessionConnected = session?.status === 'connected' && sessionId !== null
  const tabMatchesSession = Boolean(tab && tab.sessionId === sessionId)
  const canMutate = Boolean(
    sessionConnected &&
    tabMatchesSession &&
    tab &&
    tab.sessionId === sessionId &&
    tab.status === 'ready',
  )

  useEffect(() => {
    if (!activeTabId || !sessionId || !sessionConnected) return
    if (tabMatchesSession && tab && tab.status !== 'idle') return
    void useSftpStore.getState().open(activeTabId, sessionId)
  }, [activeTabId, sessionConnected, sessionId, tab, tabMatchesSession])

  const remoteStatus: SftpViewStatus = !sessionConnected
    ? 'disconnected'
    : tabMatchesSession && tab
      ? tab.status === 'idle'
        ? 'opening'
        : tab.status
      : 'opening'
  const remotePath = tabMatchesSession && tab ? tab.path : ''
  const remoteEntries = tabMatchesSession && tab ? tab.entries : []
  const remoteError = tabMatchesSession && tab ? tab.error : null
  const remoteErrorCode = tabMatchesSession && tab ? tab.errorCode : null
  const remoteSelectedPath = tabMatchesSession && tab ? tab.selectedPath : null
  const remoteSelectedPaths = tabMatchesSession && tab ? tab.selectedPaths : []
  const remoteOperation = tabMatchesSession && tab ? tab.operation : null
  const remotePathOrRoot = remotePath || '/'
  const remoteReady = Boolean(
    sessionConnected && tabMatchesSession && tab && tab.status === 'ready',
  )

  const uploadTasks = transferTasks.filter(
    (task) => task.direction === 'upload' && task.sessionId === sessionId,
  )
  const activeUploadCount = uploadTasks.filter((task) => isActiveTransferStatus(task.status)).length

  const {
    openMkdir,
    openRename,
    openDelete,
    dialog: mutationDialog,
  } = useSftpMutationDialog({
    tabId: activeTabId,
    sessionId,
    path: remotePathOrRoot,
    canMutate,
  })

  const connectedCount = orderedSessions.filter(
    (candidate) => candidate.status === 'connected',
  ).length

  const sessionDescription = session
    ? `${session.username || '未知用户'}@${session.host || '未知主机'}:${session.port}`
    : '未选择 SSH 会话'

  const goToWorkbench = (): void => {
    if (session) activateTab(session.id)
    setActiveModule('workbench')
  }

  const navigate = (path: string): void => {
    if (!activeTabId || !sessionId || !sessionConnected) return
    void useSftpStore.getState().load(activeTabId, sessionId, path)
  }

  const retry = (): void => {
    if (!activeTabId || !sessionId || !sessionConnected) return
    void useSftpStore.getState().retry(activeTabId, sessionId)
  }

  const refresh = (): void => {
    if (!activeTabId || !sessionConnected) return
    void useSftpStore.getState().refresh(activeTabId)
  }

  const changeSelection = (paths: string[], anchor: string | null): void => {
    if (!activeTabId) return
    useSftpStore.getState().setSelection(activeTabId, paths, anchor)
  }

  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      pushToast({ tone: 'info', title: '已复制远程路径', description: path })
    } catch {
      pushToast({
        tone: 'warning',
        title: '无法复制路径',
        description: '系统剪贴板不可用，请手动选择路径文本。',
      })
    }
  }

  const editRemoteFile = (entry: RemoteFileEntry): void => {
    if (!sessionId || !sessionConnected || entry.kind !== 'file') return
    void useTextEditorStore.getState().openFile(sessionId, entry.path)
  }

  const enqueueUpload = async (): Promise<void> => {
    if (!sessionId) return
    if (!remoteReady) {
      pushToast({
        tone: 'warning',
        title: '远程目录尚未就绪',
        description: '请等待目录读取完成后再选择上传文件。',
      })
      return
    }
    const result = await useTransferStore.getState().enqueueUpload(sessionId, remotePathOrRoot)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法开始上传', description: result.error.message })
      return
    }
    if (result.value.length === 0) return
    pushToast({
      tone: 'info',
      title: `已加入 ${result.value.length} 个上传任务`,
      description:
        result.value.length === 1
          ? `目标：${result.value[0]!.destinationPath}`
          : `目标目录：${remotePathOrRoot}`,
    })
  }

  const enqueueDownload = async (files: RemoteFileEntry[]): Promise<void> => {
    if (!sessionId || !sessionConnected) return
    const paths = files.filter((entry) => entry.kind === 'file').map((entry) => entry.path)
    if (paths.length === 0) return
    const result = await useTransferStore.getState().enqueueDownload(sessionId, paths)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法开始下载', description: result.error.message })
      return
    }
    if (result.value.length === 0) return
    pushToast({
      tone: 'info',
      title: `已加入 ${result.value.length} 个下载任务`,
      description: '本地保存目录由系统对话框选择，写入操作在主进程完成。',
    })
  }

  const enqueueUploadPaths = async (paths: string[]): Promise<void> => {
    if (!sessionId || !sessionConnected) return
    if (!remoteReady) {
      pushToast({
        tone: 'warning',
        title: '远程目录尚未就绪',
        description: '请等待目录读取完成后再上传。',
      })
      return
    }
    const result = await useTransferStore
      .getState()
      .enqueueUploadPaths(sessionId, remotePathOrRoot, paths)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法开始上传', description: result.error.message })
      return
    }
    const ack = result.value
    const notes: string[] = []
    if (ack.skippedSymlinks > 0) notes.push(`${ack.skippedSymlinks} 个符号链接已跳过`)
    if (ack.skippedUnsupported > 0) notes.push(`${ack.skippedUnsupported} 个条目类型不支持已跳过`)
    if (ack.truncated) notes.push('目录过大，超出上限的部分未加入')
    if (ack.tasks.length === 0) {
      pushToast({
        tone: 'warning',
        title: '没有可上传的文件',
        description:
          notes.length > 0
            ? notes.join('；')
            : '所选条目中没有可上传的普通文件；符号链接不会被跟随。',
      })
      return
    }
    pushToast({
      tone: notes.length > 0 ? 'warning' : 'info',
      title: `已加入 ${ack.tasks.length} 个上传任务`,
      description: `目标目录：${ack.remoteDirectory}${notes.length > 0 ? ` · ${notes.join('；')}` : ''}`,
    })
  }

  const downloadDroppedRemoteFiles = async (
    payload: { sessionId: string; paths: string[] },
    localDirectory: string,
  ): Promise<void> => {
    if (!sessionId || !sessionConnected) return
    if (payload.sessionId !== sessionId) {
      pushToast({
        tone: 'warning',
        title: '拖拽内容属于其他会话',
        description: '请在同一条 SSH 会话的两个面板之间拖拽，避免跨会话传输。',
      })
      return
    }
    if (isLocalPathAtRoot(localDirectory)) {
      pushToast({
        tone: 'warning',
        title: '不能下载到磁盘根目录',
        description: '请先在左侧进入根目录下的一个文件夹，再拖入文件。',
      })
      return
    }
    const result = await useTransferStore
      .getState()
      .enqueueDownloadPaths(sessionId, payload.paths, localDirectory)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法开始下载', description: result.error.message })
      return
    }
    if (result.value.length === 0) return
    pushToast({
      tone: 'info',
      title: `已加入 ${result.value.length} 个下载任务`,
      description: `保存到：${localDirectory}`,
    })
  }

  if (orderedSessions.length === 0) {
    return (
      <div className="module-view sftp-view">
        <header className="module-header">
          <div className="module-header__main">
            <div className="module-header__eyebrow">
              <span>SFTP</span>
              <Badge tone="success">真实远程通道</Badge>
            </div>
            <h1 className="module-header__title">SFTP 文件</h1>
            <p className="module-header__description">
              SFTP 复用工作台中已建立的 SSH 会话；不会自行新建连接，也不会在渲染进程持有 SSH Client
              或 SFTP 通道。
            </p>
          </div>
        </header>
        <div className="sftp-state">
          <EmptyState
            icon={Server}
            title="还没有 SSH 会话"
            description="请先在服务器模块打开一个 SSH 会话，再回到这里浏览真实远程目录。"
          >
            <Button variant="primary" onClick={() => setActiveModule('servers')}>
              管理服务器
            </Button>
            <Button variant="secondary" onClick={() => setActiveModule('workbench')}>
              打开工作台
            </Button>
          </EmptyState>
        </div>
      </div>
    )
  }

  return (
    <div className="module-view sftp-view">
      <header className="module-header">
        <div className="module-header__main">
          <div className="module-header__eyebrow">
            <span>SFTP</span>
            <Badge tone="success">真实远程通道</Badge>
          </div>
          <h1 className="module-header__title">SFTP 文件</h1>
          <p className="module-header__description">
            通过已连接的 SSH
            会话浏览远程目录，支持上传、下载、新建目录、重命名，以及删除文件或空目录。
            双击普通文件可用内置编辑器直接编辑并保存回服务器（UTF-8、上限 2 MiB）。
            左右双栏之间可直接拖拽：本地文件或目录拖到右侧上传（目录递归展开，符号链接不会被跟随），
            远程文件拖到左侧下载。文件流、临时文件与冲突检查均由主进程执行，渲染进程只接收任务快照。
          </p>
        </div>
        <div className="module-header__actions">
          <span className="sftp-summary">
            已连接 {connectedCount} / {orderedSessions.length}
          </span>
          <label className="sftp-session-picker" htmlFor={sessionSelectId}>
            <span className="sftp-session-picker__label">SSH 会话</span>
            <select
              id={sessionSelectId}
              className="select sftp-session-select"
              value={activeTabId ?? ''}
              onChange={(event) => setActiveTab(event.target.value || null)}
            >
              {activeTabId ? null : (
                <option value="" disabled>
                  选择 SSH 会话
                </option>
              )}
              {orderedSessions.map((candidate) => (
                <option value={candidate.id} key={candidate.id}>
                  {candidate.connectionName} · {SESSION_STATUS_LABELS[candidate.status]}
                  {candidate.host
                    ? ` · ${candidate.username}@${candidate.host}:${candidate.port}`
                    : ''}
                </option>
              ))}
            </select>
          </label>
          {!sessionConnected ? (
            <Button size="sm" variant="secondary" onClick={goToWorkbench}>
              前往工作台重连
            </Button>
          ) : null}
        </div>
      </header>

      {connectedCount === 0 ? (
        <div className="sftp-tip sftp-tip--warning">
          <Info size={11} aria-hidden="true" />
          当前没有已连接的 SSH 会话。SFTP 只复用现有连接，不会在后台自行建立 SSH 传输。
        </div>
      ) : null}

      <div className="sftp-panels">
        <LocalFilePanel
          tabId={activeTabId}
          sessionConnected={sessionConnected}
          remoteReady={remoteReady}
          remoteDirectory={remoteReady ? remotePathOrRoot : ''}
          uploadTaskCount={uploadTasks.length}
          activeUploadCount={activeUploadCount}
          onPickFiles={() => void enqueueUpload()}
          onUploadPaths={(paths) => void enqueueUploadPaths(paths)}
          onDownloadFiles={(payload, localDirectory) =>
            void downloadDroppedRemoteFiles(payload, localDirectory)
          }
          onOpenTransfers={() => setTransferPanelOpen(true)}
        />
        {session ? (
          <RemoteFilePanel
            sessionId={sessionId}
            sessionLabel={session.connectionName}
            sessionDescription={sessionDescription}
            path={remotePath}
            entries={remoteEntries}
            status={remoteStatus}
            error={remoteError}
            errorCode={remoteErrorCode}
            selectedPath={remoteSelectedPath}
            selectedPaths={remoteSelectedPaths}
            operation={remoteOperation}
            sessionConnected={sessionConnected}
            dropEnabled={remoteReady}
            onSelectionChange={changeSelection}
            onEnter={(entry) => {
              if (entry.kind === 'directory') navigate(entry.path)
            }}
            onEditFile={editRemoteFile}
            onNavigate={navigate}
            onUp={() => navigate(remoteParentPath(remotePathOrRoot))}
            onRefresh={refresh}
            onUpload={() => void enqueueUpload()}
            onDownload={(files) => void enqueueDownload(files)}
            onNewFolder={openMkdir}
            onRename={openRename}
            onDelete={openDelete}
            onRetry={retry}
            onDismissOperation={() => {
              if (activeTabId) useSftpStore.getState().clearOperation(activeTabId)
            }}
            onDropLocalSources={(paths) => void enqueueUploadPaths(paths)}
            onCopyPath={(path) => void copyPath(path)}
          />
        ) : (
          <section className="file-panel" aria-label="远程 SFTP 文件">
            <div className="file-panel__state" role="status">
              <span className="file-panel__state-icon">
                <WifiOff size={18} aria-hidden="true" />
              </span>
              <strong>尚未选择 SSH 会话</strong>
              <p>请在上方选择一个会话；SFTP 不会跨会话复用目录数据。</p>
            </div>
          </section>
        )}
      </div>

      <div className="sftp-tip">
        <Info size={11} aria-hidden="true" />
        删除仅限文件、符号链接或空目录；不会递归删除目录内容。传输会在目标同目录写入
        .termforge-part-* 临时文件，提交前重新检查冲突；不支持断点续传或暂停恢复。
      </div>

      {mutationDialog}
    </div>
  )
}
