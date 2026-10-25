import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpFromLine,
  ArrowUpRight,
  Copy,
  ExternalLink,
  FilePenLine,
  Folder,
  FolderOpen,
  FolderPlus,
  ListTree,
  LoaderCircle,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  SearchX,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react'
import type { RemoteFileEntry } from '@shared/types'
import { isActiveTransferStatus } from '@shared/types'
import type { RemoteSortField, RemoteSortState } from '@shared/sftp/remotePath'
import { normalizeRemotePath, remoteParentPath, sortRemoteEntriesBy } from '@shared/sftp/remotePath'
import { FloatingMenu, MenuItem, MenuLabel, MenuSeparator } from '@renderer/components/common/Menu'
import { Button } from '@renderer/components/common/Button'
import { IconButton } from '@renderer/components/common/IconButton'
import { SearchInput } from '@renderer/components/common/SearchInput'
import { StatusDot } from '@renderer/components/common/StatusDot'
import { useAppStore } from '@renderer/stores/appStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSftpStore } from '@renderer/stores/sftpStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import {
  SFTP_TREE_DEFAULT_WIDTH,
  SFTP_TREE_MAX_WIDTH,
  SFTP_TREE_MIN_WIDTH,
  useWorkspaceStore,
} from '@renderer/stores/workspaceStore'
import { useSftpMutationDialog } from '@renderer/features/sftp/useSftpMutationDialog'
import { SftpDirectoryTree } from '@renderer/features/sftp/SftpDirectoryTree'
import { SftpFileTable } from '@renderer/features/sftp/SftpFileTable'
import { PaneResizer } from '@renderer/features/workbench/PaneResizer'
import { cn } from '@renderer/lib/utils'
import { useTextEditorStore } from '@renderer/stores/textEditorStore'

const DEFAULT_SORT: RemoteSortState = { field: 'name', direction: 'asc' }
const EMPTY_ENTRIES: RemoteFileEntry[] = []
const EMPTY_PATHS: string[] = []

interface Crumb {
  label: string
  path: string
}

function splitBreadcrumbs(path: string): Crumb[] {
  const normalized = normalizeRemotePath(path || '/')
  const crumbs: Crumb[] = [{ label: '/', path: '/' }]
  let current = ''
  for (const segment of normalized.split('/').filter(Boolean)) {
    current += `/${segment}`
    crumbs.push({ label: segment, path: current })
  }
  return crumbs
}

function sortFieldLabel(field: RemoteSortField): string {
  if (field === 'size') return '大小'
  if (field === 'modified') return '修改时间'
  return '名称'
}

export function SftpDock() {
  const activeTabId = useWorkspaceStore((state) => state.activeTabId)
  const setActiveModule = useWorkspaceStore((state) => state.setActiveModule)
  const toggleSftpDock = useWorkspaceStore((state) => state.toggleSftpDock)
  const activateTab = useWorkspaceStore((state) => state.activateTab)
  const sftpTreeWidth = useWorkspaceStore((state) => state.sftpTreeWidth)
  const setSftpTreeWidth = useWorkspaceStore((state) => state.setSftpTreeWidth)
  const session = useSessionStore((state) =>
    activeTabId ? (state.sessions[activeTabId] ?? null) : null,
  )
  const tab = useSftpStore((state) => (activeTabId ? state.tabs[activeTabId] : undefined))
  const transferTasks = useTransferStore((state) => state.tasks)
  const pushToast = useAppStore((state) => state.pushToast)

  const sessionId = session?.sessionId ?? null
  const sessionConnected = session?.status === 'connected' && sessionId !== null
  const tabMatchesSession = Boolean(tab && tab.sessionId === sessionId)
  const remoteStatus = !sessionConnected
    ? 'disconnected'
    : tabMatchesSession && tab
      ? tab.status === 'idle'
        ? 'opening'
        : tab.status
      : 'opening'
  const remotePath = tabMatchesSession && tab ? tab.path : ''
  const remoteEntries = tabMatchesSession && tab ? tab.entries : EMPTY_ENTRIES
  const remoteSelectedPaths = tabMatchesSession && tab ? tab.selectedPaths : EMPTY_PATHS
  const remoteSelectedPath = tabMatchesSession && tab ? tab.selectedPath : null
  const remoteOperation = tabMatchesSession && tab ? tab.operation : null
  const remoteError = tabMatchesSession && tab ? tab.error : null
  const tree = tabMatchesSession && tab ? tab.tree : null
  const homePath = tabMatchesSession && tab ? tab.homePath : null
  const sort = tabMatchesSession && tab ? tab.sort : DEFAULT_SORT
  const pathOrRoot = remotePath || '/'
  const ready = Boolean(sessionConnected && tabMatchesSession && tab?.status === 'ready')
  const rootListing = tree?.listings['/']
  const rootRestricted =
    rootListing?.status === 'error' && rootListing.errorCode === 'permission-denied'
  const treeRootPath = rootRestricted && homePath && homePath !== '/' ? homePath : '/'
  const treeRootLabel =
    treeRootPath === '/' ? '/' : (treeRootPath.split('/').filter(Boolean).pop() ?? treeRootPath)

  const [search, setSearch] = useState('')
  const [treeOverlayOpen, setTreeOverlayOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<{ entry: RemoteFileEntry; x: number; y: number } | null>(
    null,
  )
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null)
  const [crumbMenu, setCrumbMenu] = useState<{ x: number; y: number; items: Crumb[] } | null>(null)
  const [dockWidth, setDockWidth] = useState<number | null>(null)
  const dockRef = useRef<HTMLElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!activeTabId || !sessionId || !sessionConnected) return
    if (tabMatchesSession && tab && tab.status !== 'idle') return
    void useSftpStore.getState().open(activeTabId, sessionId)
  }, [activeTabId, sessionConnected, sessionId, tab, tabMatchesSession])

  useEffect(() => {
    setSearch('')
    setTreeOverlayOpen(false)
    setRowMenu(null)
    setSortMenu(null)
    setCrumbMenu(null)
  }, [activeTabId, sessionId])

  useEffect(() => {
    const node = dockRef.current
    if (!node) return
    if (typeof ResizeObserver === 'undefined') {
      setDockWidth(window.innerWidth)
      return
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number' && width > 0) setDockWidth(width)
    })
    observer.observe(node)
    const initial = node.getBoundingClientRect().width
    if (initial > 0) setDockWidth(initial)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!activeTabId || !sessionId || !ready) return
    const currentPath = normalizeRemotePath(pathOrRoot)
    const paths = new Set<string>([treeRootPath])
    let current = ''
    for (const segment of currentPath.split('/').filter(Boolean).slice(0, -1)) {
      current += `/${segment}`
      paths.add(current)
    }
    paths.delete(currentPath)
    const store = useSftpStore.getState()
    for (const path of paths) {
      store.setTreeExpanded(activeTabId, path, true)
      void store.loadTreeDirectory(activeTabId, sessionId, path)
    }
  }, [activeTabId, ready, sessionId, pathOrRoot, treeRootPath])

  const canMutate = ready && remoteOperation?.status !== 'running'
  const {
    openMkdir,
    openRename,
    openDelete,
    dialog: mutationDialog,
  } = useSftpMutationDialog({
    tabId: activeTabId,
    sessionId,
    path: pathOrRoot,
    canMutate,
  })

  const normalizedQuery = search.trim().toLocaleLowerCase()
  const visibleEntries = useMemo(() => {
    const matched = normalizedQuery
      ? remoteEntries.filter((entry) => entry.name.toLocaleLowerCase().includes(normalizedQuery))
      : remoteEntries
    return sortRemoteEntriesBy(matched, sort)
  }, [remoteEntries, normalizedQuery, sort])

  const selectedSet = useMemo(() => new Set(remoteSelectedPaths), [remoteSelectedPaths])
  const selectedEntries = remoteEntries.filter((entry) => selectedSet.has(entry.path))
  const selectedFiles = selectedEntries.filter((entry) => entry.kind === 'file')
  const sessionTaskCount = useMemo(
    () => transferTasks.filter((task) => task.sessionId === sessionId).length,
    [transferTasks, sessionId],
  )
  const activeTransferCount = useMemo(
    () =>
      transferTasks.filter(
        (task) => task.sessionId === sessionId && isActiveTransferStatus(task.status),
      ).length,
    [transferTasks, sessionId],
  )

  if (!activeTabId || !session) return null

  const crumbs = splitBreadcrumbs(pathOrRoot)
  const narrowDock = dockWidth !== null && dockWidth < 380
  const collapseCrumbs = crumbs.length > (narrowDock ? 2 : 4)
  const crumbTailCount = narrowDock ? 1 : 2
  const hiddenCrumbs = collapseCrumbs ? crumbs.slice(1, crumbs.length - crumbTailCount) : []
  const crumbItems: Array<Crumb | { ellipsis: true }> = collapseCrumbs
    ? [crumbs[0]!, { ellipsis: true }, ...crumbs.slice(crumbs.length - crumbTailCount)]
    : crumbs

  const showDisconnected = !sessionConnected
  const showLoading =
    (remoteStatus === 'opening' || remoteStatus === 'loading') && remoteEntries.length === 0
  const showError = remoteStatus === 'error' && remoteEntries.length === 0 && !showDisconnected
  const busy =
    !sessionConnected ||
    remoteStatus === 'opening' ||
    remoteStatus === 'loading' ||
    remoteOperation?.status === 'running'
  const actionDisabled = !ready || remoteOperation?.status === 'running'
  const canGoUp = normalizeRemotePath(pathOrRoot) !== '/'
  const remoteStatusLabel = showDisconnected
    ? 'SSH 已断开'
    : remoteStatus === 'opening'
      ? '正在打开 SFTP'
      : remoteStatus === 'loading'
        ? '正在读取目录'
        : remoteStatus === 'error'
          ? remoteEntries.length > 0
            ? '目录刷新失败'
            : 'SFTP 读取失败'
          : `SFTP 已连接${remoteEntries.length > 0 ? ` · ${remoteEntries.length} 项` : ''}`
  const statusTone = showDisconnected
    ? session.status
    : remoteStatus === 'error'
      ? 'error'
      : currentStatusTone(remoteStatus)

  const navigate = (path: string): void => {
    if (!activeTabId || !sessionId || !sessionConnected) return
    setTreeOverlayOpen(false)
    setSearch('')
    void useSftpStore.getState().load(activeTabId, sessionId, path)
  }

  const refresh = (): void => {
    if (!activeTabId || !sessionConnected) return
    void useSftpStore.getState().refresh(activeTabId)
    if (sessionId) void useSftpStore.getState().refreshTree(activeTabId, sessionId)
  }

  const retry = (): void => {
    if (!activeTabId || !sessionId || !sessionConnected) return
    void useSftpStore.getState().retry(activeTabId, sessionId)
  }

  const handleSelectionChange = (paths: string[], anchor: string | null): void => {
    if (!activeTabId) return
    useSftpStore.getState().setSelection(activeTabId, paths, anchor)
  }

  const handleTreeToggle = (path: string, expanded: boolean): void => {
    if (!activeTabId || !sessionId) return
    const store = useSftpStore.getState()
    store.setTreeExpanded(activeTabId, path, expanded)
    if (expanded) void store.loadTreeDirectory(activeTabId, sessionId, path)
  }

  const handleTreeRetry = (path: string): void => {
    if (!activeTabId || !sessionId) return
    void useSftpStore.getState().loadTreeDirectory(activeTabId, sessionId, path, { force: true })
  }

  const applySort = (field: RemoteSortField): void => {
    if (!activeTabId) return
    useSftpStore.getState().setSort(activeTabId, field)
  }

  const enqueueUpload = async (): Promise<void> => {
    if (!sessionId) return
    if (!ready) {
      pushToast({
        tone: 'warning',
        title: '远程目录尚未就绪',
        description: '请等待目录读取完成后再选择上传文件。',
      })
      return
    }
    const result = await useTransferStore.getState().enqueueUpload(sessionId, pathOrRoot)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法开始上传', description: result.error.message })
      return
    }
    if (result.value.length === 0) return
    pushToast({
      tone: 'info',
      title: `已加入 ${result.value.length} 个上传任务`,
      description: `目标目录：${pathOrRoot}`,
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

  const copyRemotePath = async (path: string): Promise<void> => {
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

  const openEditor = (entry: RemoteFileEntry): void => {
    if (!sessionId || !sessionConnected) return
    if (entry.kind !== 'file') {
      pushToast({
        tone: 'warning',
        title: '无法用编辑器打开',
        description: '内置文本编辑器只支持普通远程文件，不支持目录或符号链接。',
      })
      return
    }
    void useTextEditorStore.getState().openFile(sessionId, entry.path)
  }

  const openFullSftpView = (): void => {
    activateTab(session.id)
    setActiveModule('sftp')
  }

  return (
    <aside className="sftp-dock" ref={dockRef} aria-label="SFTP 文件面板">
      <header className="sftp-dock__header">
        <span className="sftp-dock__mark" aria-hidden="true">
          <FolderOpen size={15} />
        </span>
        <div className="sftp-dock__identity">
          <div className="sftp-dock__title-row">
            <span className="sftp-dock__title">SFTP</span>
            <span
              className="sftp-dock__session"
              title={`${session.connectionName} · ${session.username}@${session.host}`}
            >
              {session.connectionName}
            </span>
          </div>
          <div className="sftp-dock__status" title={remoteStatusLabel}>
            <StatusDot status={statusTone} />
            <span className="sftp-dock__status-text">{remoteStatusLabel}</span>
          </div>
        </div>
        <div className="sftp-dock__header-actions">
          <IconButton
            label="在 SFTP 页打开完整双栏视图"
            size="sm"
            title="在 SFTP 页打开（上传/下载/新建目录/重命名/删除）"
            onClick={openFullSftpView}
          >
            <ExternalLink size={13} aria-hidden="true" />
          </IconButton>
          <IconButton
            label="刷新远程目录"
            size="sm"
            disabled={!sessionConnected || busy}
            onClick={refresh}
          >
            <RefreshCw
              className={remoteStatus === 'loading' ? 'spin' : undefined}
              size={13}
              aria-hidden="true"
            />
          </IconButton>
          <IconButton
            label="隐藏 SFTP 面板"
            size="sm"
            title="隐藏 SFTP 面板（可在终端工具栏重新打开）"
            onClick={toggleSftpDock}
          >
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      </header>

      <div className="sftp-dock__pathbar">
        <IconButton
          label="返回上一级目录"
          size="sm"
          disabled={!canGoUp || busy}
          onClick={() => navigate(remoteParentPath(pathOrRoot))}
        >
          <ArrowUp size={13} aria-hidden="true" />
        </IconButton>
        <nav className="sftp-dock__crumbs" aria-label="远程路径">
          {crumbItems.map((item, index) => {
            const isLast = index === crumbItems.length - 1
            const key = 'ellipsis' in item ? 'ellipsis' : item.path
            return (
              <span className="sftp-dock__crumb-fragment" key={key}>
                {index > 1 ? (
                  <span className="sftp-dock__crumb-separator" aria-hidden="true">
                    /
                  </span>
                ) : null}
                {'ellipsis' in item ? (
                  <button
                    type="button"
                    className="sftp-dock__crumb sftp-dock__crumb--more"
                    aria-label={`显示 ${hiddenCrumbs.length} 个隐藏路径层级`}
                    title="显示隐藏的路径层级"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setCrumbMenu({ x: rect.left, y: rect.bottom + 4, items: hiddenCrumbs })
                    }}
                  >
                    <MoreHorizontal size={12} aria-hidden="true" />
                  </button>
                ) : isLast ? (
                  <span className="sftp-dock__crumb sftp-dock__crumb--current" title={item.path}>
                    {item.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="sftp-dock__crumb"
                    disabled={busy}
                    title={item.path}
                    onClick={() => navigate(item.path)}
                  >
                    {item.label}
                  </button>
                )}
              </span>
            )
          })}
        </nav>
        <IconButton
          label="复制当前文件夹路径"
          title={pathOrRoot}
          size="sm"
          onClick={() => void copyRemotePath(pathOrRoot)}
        >
          <Copy size={13} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="sftp-dock__searchbar">
        <IconButton
          className="sftp-dock__tree-toggle"
          label={treeOverlayOpen ? '关闭远程目录树' : '打开远程目录树'}
          size="sm"
          active={treeOverlayOpen}
          onClick={() => setTreeOverlayOpen((open) => !open)}
        >
          <ListTree size={13} aria-hidden="true" />
        </IconButton>
        <SearchInput
          className="sftp-dock__search"
          value={search}
          onChange={setSearch}
          placeholder="筛选当前目录"
          label="筛选当前远程目录的文件名"
        />
        <IconButton label="新建远程目录" size="sm" disabled={!canMutate} onClick={openMkdir}>
          <FolderPlus size={13} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="排序方式"
          size="sm"
          active={sortMenu !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setSortMenu({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <ArrowUpDown size={13} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="sftp-dock__body">
        {!showDisconnected ? (
          <>
            {treeOverlayOpen ? (
              <button
                type="button"
                className="sftp-dock__scrim"
                aria-label="关闭远程目录树"
                onClick={() => setTreeOverlayOpen(false)}
              />
            ) : null}
            <div
              className={cn('sftp-dock__tree', treeOverlayOpen && 'sftp-dock__tree--open')}
              ref={treeRef}
              aria-hidden={narrowDock && !treeOverlayOpen ? true : undefined}
              inert={narrowDock && !treeOverlayOpen ? true : undefined}
              style={{ '--sftp-tree-width': `${sftpTreeWidth}px` } as CSSProperties}
            >
              {tree ? (
                <SftpDirectoryTree
                  tree={tree}
                  currentPath={pathOrRoot}
                  rootPath={treeRootPath}
                  rootLabel={treeRootLabel}
                  onNavigate={navigate}
                  onToggle={handleTreeToggle}
                  onRetry={handleTreeRetry}
                />
              ) : null}
            </div>
            <PaneResizer
              className="sftp-dock__tree-resizer"
              edge="left"
              label="调整远程目录树宽度"
              width={sftpTreeWidth}
              min={SFTP_TREE_MIN_WIDTH}
              max={SFTP_TREE_MAX_WIDTH}
              fallbackWidth={SFTP_TREE_DEFAULT_WIDTH}
              getTargetWidth={() => treeRef.current?.getBoundingClientRect().width ?? null}
              onChange={setSftpTreeWidth}
              onReset={() => setSftpTreeWidth(SFTP_TREE_DEFAULT_WIDTH)}
            />
          </>
        ) : null}

        <div className="sftp-dock__browser">
          {remoteOperation?.status === 'error' ? (
            <div className="sftp-dock__banner" role="alert">
              <AlertTriangle size={12} aria-hidden="true" />
              <span title={remoteOperation.error ?? undefined}>{remoteOperation.error}</span>
              <button
                type="button"
                className="sftp-dock__banner-dismiss"
                aria-label="关闭文件操作错误"
                onClick={() => {
                  if (activeTabId) useSftpStore.getState().clearOperation(activeTabId)
                }}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {remoteError && remoteEntries.length > 0 && !showDisconnected ? (
            <div className="sftp-dock__banner sftp-dock__banner--danger" role="alert">
              <AlertTriangle size={12} aria-hidden="true" />
              <span>{remoteError}</span>
              <Button size="sm" variant="ghost" onClick={retry}>
                重试
              </Button>
            </div>
          ) : null}

          <div className="sftp-dock__list">
            {showDisconnected ? (
              <div className="sftp-dock__state" role="status">
                <WifiOff size={16} aria-hidden="true" />
                <strong>SSH 会话不可用</strong>
                <p>在工作台重新连接该标签后，SFTP 面板会重新打开目录。</p>
              </div>
            ) : showLoading ? (
              <div className="sftp-dock__state" role="status">
                <LoaderCircle className="spin" size={15} aria-hidden="true" />
                <span>
                  {remoteStatus === 'opening' ? '正在打开 SFTP 通道…' : '正在读取远程目录…'}
                </span>
              </div>
            ) : showError ? (
              <div className="sftp-dock__state sftp-dock__state--danger" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <strong>无法读取目录</strong>
                <p>{remoteError ?? '服务器未返回目录内容。'}</p>
                <Button size="sm" variant="secondary" onClick={retry}>
                  重试
                </Button>
              </div>
            ) : remoteEntries.length === 0 ? (
              <div className="sftp-dock__state" role="status">
                <Folder size={16} aria-hidden="true" />
                <span>此目录为空</span>
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="sftp-dock__state" role="status">
                <SearchX size={16} aria-hidden="true" />
                <strong>没有匹配的条目</strong>
                <p>当前筛选「{search.trim()}」未命中此目录中的名称。</p>
                <Button size="sm" variant="ghost" onClick={() => setSearch('')}>
                  清除筛选
                </Button>
              </div>
            ) : (
              <SftpFileTable
                entries={visibleEntries}
                selectedPaths={remoteSelectedPaths}
                sort={sort}
                onSort={applySort}
                onSelectionChange={handleSelectionChange}
                onOpen={(entry) => {
                  if (entry.kind === 'directory') navigate(entry.path)
                  else openEditor(entry)
                }}
                onContextMenu={(entry, position) =>
                  setRowMenu({ entry, x: position.x, y: position.y })
                }
              />
            )}
          </div>
        </div>
      </div>

      <footer className="sftp-dock__footer">
        <div className="sftp-dock__footer-meta" title={remoteSelectedPath ?? undefined}>
          <span>
            {normalizedQuery
              ? `筛选 ${visibleEntries.length} / ${remoteEntries.length}`
              : `${remoteEntries.length} 个条目`}
            {selectedEntries.length > 0 ? ` · 已选 ${selectedEntries.length}` : ''}
          </span>
          {sessionTaskCount > 0 ? (
            <button
              type="button"
              className="sftp-dock__transfer"
              title="打开传输中心"
              onClick={() => useTransferStore.getState().setPanelOpen(true)}
            >
              <ArrowLeftRight size={11} aria-hidden="true" />
              <span className="sftp-dock__transfer-label">
                {activeTransferCount > 0
                  ? `${activeTransferCount} 个传输中`
                  : `${sessionTaskCount} 个传输`}
              </span>
              {activeTransferCount > 0 ? (
                <span className="sftp-dock__transfer-count" aria-hidden="true">
                  {activeTransferCount}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
        <div className="sftp-dock__footer-actions">
          <Button
            size="sm"
            variant="secondary"
            disabled={actionDisabled}
            onClick={() => void enqueueUpload()}
          >
            <ArrowUpFromLine size={12} aria-hidden="true" />
            上传
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedFiles.length === 0 || actionDisabled}
            onClick={() => void enqueueDownload(selectedFiles)}
          >
            <ArrowDownToLine size={12} aria-hidden="true" />
            下载{selectedFiles.length > 1 ? ` (${selectedFiles.length})` : ''}
          </Button>
        </div>
      </footer>

      {sortMenu ? (
        <FloatingMenu position={sortMenu} ariaLabel="排序方式" onClose={() => setSortMenu(null)}>
          <MenuLabel>排序方式</MenuLabel>
          {(['name', 'size', 'modified'] as const).map((field) => {
            const active = sort.field === field
            const DirectionIcon =
              active && sort.direction === 'desc' ? ArrowDown : active ? ArrowUp : undefined
            return (
              <MenuItem
                key={field}
                icon={DirectionIcon}
                label={
                  active
                    ? `${sortFieldLabel(field)}（${sort.direction === 'asc' ? '升序' : '降序'}）`
                    : sortFieldLabel(field)
                }
                description={
                  field === 'name'
                    ? '目录始终优先，其次按自然名称排序'
                    : field === 'size'
                      ? '未知大小始终排在末尾'
                      : '未知时间始终排在末尾'
                }
                onSelect={() => {
                  applySort(field)
                  setSortMenu(null)
                }}
              />
            )
          })}
        </FloatingMenu>
      ) : null}

      {crumbMenu ? (
        <FloatingMenu
          position={crumbMenu}
          ariaLabel="隐藏的路径层级"
          onClose={() => setCrumbMenu(null)}
        >
          <MenuLabel>跳转到层级</MenuLabel>
          {crumbMenu.items.map((crumb) => (
            <MenuItem
              key={crumb.path}
              icon={Folder}
              label={crumb.label}
              description={crumb.path}
              onSelect={() => {
                navigate(crumb.path)
                setCrumbMenu(null)
              }}
            />
          ))}
        </FloatingMenu>
      ) : null}

      {rowMenu ? (
        <FloatingMenu
          position={rowMenu}
          ariaLabel={`${rowMenu.entry.name} 的文件操作`}
          onClose={() => setRowMenu(null)}
        >
          <MenuLabel>{rowMenu.entry.name}</MenuLabel>
          {rowMenu.entry.kind === 'directory' ? (
            <MenuItem
              icon={ArrowUpRight}
              label="打开目录"
              onSelect={() => {
                navigate(rowMenu.entry.path)
                setRowMenu(null)
              }}
            />
          ) : (
            <>
              {rowMenu.entry.kind === 'file' ? (
                <MenuItem
                  icon={FilePenLine}
                  label="用内置编辑器打开"
                  description="在覆盖层中编辑并保存回服务器"
                  disabled={!sessionConnected}
                  onSelect={() => {
                    openEditor(rowMenu.entry)
                    setRowMenu(null)
                  }}
                />
              ) : null}
              <MenuItem
                icon={ArrowDownToLine}
                label="下载此文件"
                description="在系统对话框中确认本地保存位置"
                disabled={actionDisabled}
                onSelect={() => {
                  void enqueueDownload([rowMenu.entry])
                  setRowMenu(null)
                }}
              />
            </>
          )}
          <MenuSeparator />
          <MenuItem
            icon={PencilLine}
            label="重命名…"
            disabled={!canMutate}
            onSelect={() => {
              openRename(rowMenu.entry)
              setRowMenu(null)
            }}
          />
          <MenuItem
            icon={Trash2}
            label="删除…"
            danger
            disabled={!canMutate}
            onSelect={() => {
              openDelete(rowMenu.entry)
              setRowMenu(null)
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={Copy}
            label="复制远程路径"
            onSelect={() => {
              void copyRemotePath(rowMenu.entry.path)
              setRowMenu(null)
            }}
          />
        </FloatingMenu>
      ) : null}

      {mutationDialog}
    </aside>
  )
}

function currentStatusTone(remoteStatus: string): 'connected' | 'connecting' {
  return remoteStatus === 'opening' || remoteStatus === 'loading' ? 'connecting' : 'connected'
}
