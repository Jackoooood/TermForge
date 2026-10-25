import { useEffect, useId, useMemo, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react'
import {
  AlertTriangle,
  ArrowUp,
  ArrowUpDown,
  ArrowUpFromLine,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Info,
  Laptop,
  Link2,
  LoaderCircle,
  PencilLine,
  RefreshCw,
  X,
} from 'lucide-react'
import type { LocalFileEntry, LocalRootEntry } from '@shared/types'
import {
  getLocalPathError,
  isLocalPathAtRoot,
  isWindowsStyleLocalPath,
  resolveLocalPath,
  sortLocalEntries,
  splitLocalBreadcrumbs,
} from '@shared/localFs/localPath'
import type { LocalSortField } from '@shared/localFs/localPath'
import { Badge } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { IconButton } from '@renderer/components/common/IconButton'
import { useLocalPanelStore } from '@renderer/stores/localPanelStore'
import { cn, formatBytes, formatDateTime } from '@renderer/lib/utils'
import { hasRemoteFiles, readRemoteFiles, useDropZone, writeLocalPaths } from './fileDrag'

interface LocalFilePanelProps {
  tabId: string | null
  sessionConnected: boolean
  remoteReady: boolean
  remoteDirectory: string
  uploadTaskCount: number
  activeUploadCount: number
  onPickFiles: () => void
  onUploadPaths: (paths: string[]) => void
  onDownloadFiles: (payload: { sessionId: string; paths: string[] }, localDirectory: string) => void
  onOpenTransfers: () => void
}

const SORT_LABELS: Record<LocalSortField, string> = {
  name: '名称',
  size: '大小',
  time: '时间',
}

function entryIcon(kind: LocalFileEntry['kind']) {
  if (kind === 'directory') return Folder
  if (kind === 'symlink') return Link2
  return FileText
}

function rootIcon(kind: LocalRootEntry['kind']) {
  return kind === 'home' ? Home : HardDrive
}

function rootKindLabel(kind: LocalRootEntry['kind']): string {
  if (kind === 'home') return '主目录'
  if (kind === 'drive') return '驱动器'
  return '文件系统根'
}

function entrySize(entry: LocalFileEntry): string {
  return entry.kind === 'file' && entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : '—'
}

export function LocalFilePanel({
  tabId,
  sessionConnected,
  remoteReady,
  remoteDirectory,
  uploadTaskCount,
  activeUploadCount,
  onPickFiles,
  onUploadPaths,
  onDownloadFiles,
  onOpenTransfers,
}: LocalFilePanelProps) {
  const pathInputId = useId()
  const tab = useLocalPanelStore((state) => (tabId ? state.tabs[tabId] : undefined))
  const ensure = useLocalPanelStore((state) => state.ensure)
  const load = useLocalPanelStore((state) => state.load)
  const refresh = useLocalPanelStore((state) => state.refresh)
  const setSort = useLocalPanelStore((state) => state.setSort)
  const toggleHidden = useLocalPanelStore((state) => state.toggleHidden)
  const setSelection = useLocalPanelStore((state) => state.setSelection)
  const [editingPath, setEditingPath] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const [pathError, setPathError] = useState<string | null>(null)

  useEffect(() => {
    if (tabId) void ensure(tabId)
  }, [tabId, ensure])

  useEffect(() => {
    setEditingPath(false)
    setPathError(null)
  }, [tab?.path])

  const path = tab?.path ?? ''
  const selectedPaths = tab?.selectedPaths ?? []
  const selectedSet = useMemo(() => new Set(tab?.selectedPaths ?? []), [tab])
  const visibleEntries = useMemo(() => {
    if (!tab) return []
    const filtered = tab.showHidden ? tab.entries : tab.entries.filter((entry) => !entry.hidden)
    return sortLocalEntries(filtered, tab.sortField, tab.sortDirection)
  }, [tab])

  const selectedEntries = visibleEntries.filter((entry) => selectedSet.has(entry.path))
  const uploadableSelection = selectedEntries
    .filter((entry) => entry.kind !== 'symlink')
    .map((entry) => entry.path)

  const rooting = Boolean(tab && tab.path === '' && tab.status === 'ready')
  const showLoading = Boolean(
    !tab || tab.status === 'loading' || (tab.status === 'idle' && tab.entries.length === 0),
  )
  const showErrorState = Boolean(tab && tab.status === 'error' && tab.entries.length === 0)
  const showErrorBanner = Boolean(tab && tab.status === 'error' && tab.entries.length > 0)
  const busy = !tab || tab.status === 'loading'
  const canUpload = sessionConnected && remoteReady
  const localReady = Boolean(tab && tab.status === 'ready')

  const dropZone = useDropZone({
    canAccept: (event) =>
      Boolean(
        tabId &&
        tab &&
        tab.status !== 'loading' &&
        tab.path !== '' &&
        !isLocalPathAtRoot(tab.path) &&
        hasRemoteFiles(event.dataTransfer),
      ),
    onDrop: (dataTransfer) => {
      const payload = readRemoteFiles(dataTransfer)
      if (!payload || !tab || tab.path === '') return
      onDownloadFiles(payload, tab.path)
    },
  })

  const navigate = (nextPath: string): void => {
    if (!tabId) return
    void load(tabId, nextPath)
  }

  const openPathEditor = (): void => {
    setPathDraft(path)
    setPathError(null)
    setEditingPath(true)
  }

  const submitPath = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (pathDraft.trim().length === 0) {
      setPathError('请输入本地目录路径')
      return
    }
    const resolved = resolveLocalPath(path, pathDraft)
    const validation = getLocalPathError(resolved)
    if (validation) {
      setPathError(validation)
      return
    }
    setEditingPath(false)
    setPathError(null)
    if (resolved !== path) navigate(resolved)
  }

  const selectRow = (entry: LocalFileEntry, event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (!tabId) return
    const additive = event.ctrlKey || event.metaKey
    const range = event.shiftKey

    if (range) {
      const anchor = tab?.selectedPath
      const anchorPath =
        anchor && visibleEntries.some((candidate) => candidate.path === anchor)
          ? anchor
          : entry.path
      const anchorIndex = visibleEntries.findIndex((candidate) => candidate.path === anchorPath)
      const targetIndex = visibleEntries.findIndex((candidate) => candidate.path === entry.path)
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex)
        const end = Math.max(anchorIndex, targetIndex)
        const rangePaths = visibleEntries.slice(start, end + 1).map((candidate) => candidate.path)
        const nextPaths = additive
          ? visibleEntries
              .filter(
                (candidate) =>
                  selectedSet.has(candidate.path) || rangePaths.includes(candidate.path),
              )
              .map((candidate) => candidate.path)
          : rangePaths
        setSelection(tabId, nextPaths, anchorPath)
        return
      }
    }

    if (additive) {
      const next = new Set(selectedPaths)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      const nextPaths = visibleEntries
        .filter((candidate) => next.has(candidate.path))
        .map((candidate) => candidate.path)
      setSelection(
        tabId,
        nextPaths,
        next.has(entry.path) ? entry.path : (nextPaths[nextPaths.length - 1] ?? null),
      )
      return
    }

    setSelection(tabId, [entry.path], entry.path)
  }

  const startDrag = (entry: LocalFileEntry, event: ReactDragEvent<HTMLButtonElement>): void => {
    // Symlinks are never followed by the transfer pipeline; dragging one would
    // only produce a skipped-source report, so the drag is refused up front.
    const sources = selectedSet.has(entry.path)
      ? visibleEntries.filter((candidate) => selectedSet.has(candidate.path))
      : [entry]
    const paths = sources
      .filter((candidate) => candidate.kind !== 'symlink')
      .map((candidate) => candidate.path)
    if (paths.length === 0) {
      event.preventDefault()
      return
    }
    writeLocalPaths(event.dataTransfer, paths)
  }

  const crumbs = [
    { label: '此电脑', path: '' },
    ...(rooting || path === '' ? [] : splitLocalBreadcrumbs(path)),
  ]
  const crumbSeparator = isWindowsStyleLocalPath(path) ? '\\' : '/'

  const renderRoots = (roots: LocalRootEntry[]): ReactElement => (
    <div className="file-list" aria-label="本地文件系统根目录">
      <div className="file-list__head" aria-hidden="true">
        <span>名称</span>
        <span>类型</span>
        <span>路径</span>
      </div>
      {roots.map((root) => {
        const Icon = rootIcon(root.kind)
        return (
          <button
            type="button"
            className="file-row file-row--root"
            key={root.path}
            title={root.path}
            onClick={() => navigate(root.path)}
          >
            <span className="file-row__name">
              <Icon
                className="file-row__icon file-row__icon--directory"
                size={14}
                aria-hidden="true"
              />
              <span>{root.name}</span>
            </span>
            <span className="file-row__size">{rootKindLabel(root.kind)}</span>
            <span className="file-row__time">{root.path}</span>
          </button>
        )
      })}
    </div>
  )

  return (
    <section
      className={cn(
        'file-panel',
        'file-panel--local',
        dropZone.isOver && 'file-panel--drop-target',
      )}
      aria-label="本地文件"
      {...dropZone.dropZoneProps}
    >
      <header className="file-panel__header">
        <div className="file-panel__title-row">
          <Laptop className="file-panel__icon" size={14} aria-hidden="true" />
          <span className="file-panel__title">本地</span>
          <span className="file-panel__description" title={path || '此电脑'}>
            {rooting ? '此电脑' : path || '尚未读取'}
          </span>
          {!sessionConnected ? (
            <Badge tone="danger">会话未连接</Badge>
          ) : remoteReady ? (
            <Badge tone="success">可上传</Badge>
          ) : (
            <Badge tone="warning">目录未就绪</Badge>
          )}
        </div>

        <div className="file-panel__toolbar">
          <IconButton
            label="返回上一级目录"
            size="sm"
            disabled={busy || !tab}
            onClick={() => {
              if (!tab) return
              navigate(tab.parentPath ?? '')
            }}
          >
            <ArrowUp size={14} aria-hidden="true" />
          </IconButton>
          <nav className="breadcrumbs" aria-label="本地路径">
            {crumbs.map((crumb, index) => {
              const isLast = index === crumbs.length - 1
              return (
                <span className="breadcrumb-fragment" key={crumb.path || '__roots'}>
                  {index > 0 ? (
                    <span className="breadcrumb-separator" aria-hidden="true">
                      {crumbSeparator}
                    </span>
                  ) : null}
                  {isLast ? (
                    <span className="breadcrumb breadcrumb--current" title={crumb.path}>
                      {crumb.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="breadcrumb-button"
                      disabled={busy}
                      onClick={() => navigate(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  )}
                </span>
              )
            })}
          </nav>
          <div className="file-panel__actions">
            <IconButton label="输入本地路径" size="sm" disabled={busy} onClick={openPathEditor}>
              <PencilLine size={14} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="刷新本地目录"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (tabId) void refresh(tabId)
              }}
            >
              <RefreshCw
                className={tab?.status === 'loading' ? 'spin' : undefined}
                size={14}
                aria-hidden="true"
              />
            </IconButton>
            <IconButton
              label="通过系统对话框选择文件上传"
              size="sm"
              disabled={!canUpload}
              onClick={onPickFiles}
            >
              <ArrowUpFromLine size={14} aria-hidden="true" />
            </IconButton>
          </div>
        </div>

        <div className="file-panel__sortbar">
          <div className="local-sort" role="group" aria-label="排序方式">
            {(Object.keys(SORT_LABELS) as LocalSortField[]).map((field) => (
              <button
                type="button"
                key={field}
                className={cn(
                  'local-sort__button',
                  tab?.sortField === field && 'local-sort__button--active',
                )}
                disabled={!tab}
                onClick={() => {
                  if (tabId) setSort(tabId, field)
                }}
              >
                {SORT_LABELS[field]}
                {tab?.sortField === field ? (tab.sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="local-sort__button local-sort__hidden-toggle"
            aria-pressed={tab?.showHidden ?? false}
            disabled={!tab}
            onClick={() => {
              if (tabId) toggleHidden(tabId)
            }}
          >
            {tab?.showHidden ? (
              <Eye size={11} aria-hidden="true" />
            ) : (
              <EyeOff size={11} aria-hidden="true" />
            )}
            隐藏文件
          </button>
        </div>

        {editingPath ? (
          <form className="sftp-path-form" onSubmit={submitPath} noValidate>
            <label className="sr-only" htmlFor={pathInputId}>
              本地路径
            </label>
            <input
              id={pathInputId}
              className="text-input"
              autoFocus
              value={pathDraft}
              aria-invalid={Boolean(pathError)}
              placeholder="绝对路径，或相对于当前目录的路径"
              onChange={(event) => {
                setPathDraft(event.target.value)
                setPathError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setEditingPath(false)
                  setPathError(null)
                }
              }}
            />
            <Button size="sm" variant="secondary" type="submit">
              前往
            </Button>
            <IconButton
              label="取消路径输入"
              size="sm"
              onClick={() => {
                setEditingPath(false)
                setPathError(null)
              }}
            >
              <X size={13} aria-hidden="true" />
            </IconButton>
            {pathError ? (
              <p className="field__error" role="alert">
                {pathError}
              </p>
            ) : (
              <p className="field__hint">支持绝对路径与 .. 解析；本地面板只读取元数据。</p>
            )}
          </form>
        ) : null}
      </header>

      {tab?.truncated && !rooting ? (
        <div className="file-panel__banner file-panel__banner--warning" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>目录条目超过 5000 项，仅显示前 5000 个；请缩小目录范围后重试。</span>
        </div>
      ) : null}

      {showErrorBanner && tab ? (
        <div className="file-panel__banner file-panel__banner--danger" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{tab.error ?? '本地目录刷新失败。'}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (tabId) void refresh(tabId)
            }}
          >
            重试
          </Button>
        </div>
      ) : null}

      {showErrorState && tab ? (
        <div className="file-list">
          <div className="file-panel__state" role="alert">
            <span className="file-panel__state-icon file-panel__state-icon--danger">
              <AlertTriangle size={18} aria-hidden="true" />
            </span>
            <strong>无法读取本地目录</strong>
            <p>{tab.error ?? '本地文件系统未返回目录内容。'}</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (tabId) void refresh(tabId)
              }}
            >
              重试
            </Button>
          </div>
        </div>
      ) : showLoading ? (
        <div className="file-list">
          <div className="file-panel__state" role="status">
            <div className="sftp-loading">
              <LoaderCircle className="spin" size={16} aria-hidden="true" />
              正在读取本地目录…
            </div>
          </div>
        </div>
      ) : rooting ? (
        tab ? (
          renderRoots(tab.roots)
        ) : null
      ) : (
        <div className="file-list" aria-label="本地文件列表">
          <div className="file-list__head" aria-hidden="true">
            <span>名称</span>
            <span>大小</span>
            <span>修改时间</span>
          </div>
          {visibleEntries.length === 0 ? (
            <div className="file-panel__state" role="status">
              <span className="file-panel__state-icon">
                <FolderOpen size={18} aria-hidden="true" />
              </span>
              <strong>此目录为空</strong>
              <p>可以把右侧的远程文件拖到这里，下载到当前目录。</p>
            </div>
          ) : (
            visibleEntries.map((entry) => {
              const Icon = entryIcon(entry.kind)
              const isSelected = selectedSet.has(entry.path)
              const draggable = entry.kind !== 'symlink'
              return (
                <button
                  type="button"
                  aria-pressed={isSelected}
                  className={cn('file-row', isSelected && 'file-row--selected')}
                  draggable={draggable}
                  key={entry.path}
                  title={`${entry.path}${
                    entry.kind === 'directory' ? '\n双击进入目录' : ''
                  }${draggable ? '\n拖拽到右侧远程面板可上传' : '\n符号链接不会被上传流程跟随'}`}
                  onClick={(event) => selectRow(entry, event)}
                  onDoubleClick={() => {
                    if (entry.kind === 'directory') navigate(entry.path)
                  }}
                  onDragStart={(event) => startDrag(entry, event)}
                >
                  <span className="file-row__name">
                    <Icon
                      className={cn('file-row__icon', `file-row__icon--${entry.kind}`)}
                      size={14}
                      aria-hidden="true"
                    />
                    <span>{entry.name}</span>
                  </span>
                  <span className="file-row__size">{entrySize(entry)}</span>
                  <span className="file-row__time">
                    {entry.modifiedAt ? formatDateTime(entry.modifiedAt) : '—'}
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}

      <div className="file-selection-detail">
        <div className="file-selection-detail__main">
          {selectedEntries.length === 1 ? (
            <>
              <span className="file-selection-detail__name" title={selectedEntries[0]!.name}>
                {selectedEntries[0]!.name}
              </span>
              <span className="file-selection-detail__meta" title={selectedEntries[0]!.path}>
                {selectedEntries[0]!.path}
              </span>
            </>
          ) : selectedEntries.length > 1 ? (
            <>
              <span className="file-selection-detail__name">
                已选择 {selectedEntries.length} 项
              </span>
              <span className="file-selection-detail__meta">
                {uploadableSelection.length} 项可上传 ·{' '}
                {selectedEntries.length - uploadableSelection.length} 个链接会被跳过
              </span>
            </>
          ) : (
            <span className="file-selection-detail__meta">
              {rooting
                ? '选择一个位置后即可浏览并拖拽文件'
                : '点击选择；Ctrl/⌘ 多选，Shift 连选；拖拽到右侧上传'}
            </span>
          )}
        </div>
        <div className="file-selection-detail__actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={uploadableSelection.length === 0 || !canUpload || !localReady}
            onClick={() => onUploadPaths(uploadableSelection)}
          >
            <ArrowUpFromLine size={13} aria-hidden="true" />
            上传到远程{uploadableSelection.length > 1 ? ` (${uploadableSelection.length})` : ''}
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenTransfers}>
            <ArrowUpDown size={13} aria-hidden="true" />
            传输队列
          </Button>
        </div>
      </div>

      <footer className="file-panel__footer">
        <span>
          {rooting
            ? `根位置 ${tab?.roots.length ?? 0} 个`
            : `已显示 ${visibleEntries.length} / 共 ${tab?.entries.length ?? 0} 项 · 已选 ${selectedEntries.length}`}
          {uploadTaskCount > 0
            ? ` · 上传任务 ${uploadTaskCount} 个（进行中 ${activeUploadCount}）`
            : ''}
        </span>
        <span className="file-selection-bar">
          <Info size={11} aria-hidden="true" />
          {remoteDirectory ? `拖拽上传目标：${remoteDirectory}` : '远程目录未就绪，暂不能上传'}
        </span>
      </footer>
    </section>
  )
}
