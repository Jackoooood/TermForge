import { useEffect, useId, useState } from 'react'
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Copy,
  FileText,
  FilePenLine,
  Folder,
  FolderOpen,
  FolderPlus,
  Info,
  Link2,
  LoaderCircle,
  PencilLine,
  RefreshCw,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react'
import type { OperationErrorCode, RemoteFileEntry } from '@shared/types'
import { getRemotePathError, normalizeRemotePath, resolveRemotePath } from '@shared/sftp/remotePath'
import { Button } from '@renderer/components/common/Button'
import { IconButton } from '@renderer/components/common/IconButton'
import { Badge } from '@renderer/components/common/Badge'
import type { SftpOperationState, SftpViewStatus } from '@renderer/stores/sftpStore'
import { cn, formatBytes, formatDateTime } from '@renderer/lib/utils'
import { sftpErrorGuidance } from './errorGuidance'
import {
  collectOsFilePaths,
  hasLocalPaths,
  hasOsFiles,
  readLocalPaths,
  useDropZone,
  writeRemoteFiles,
} from './fileDrag'

interface RemoteFilePanelProps {
  sessionId: string | null
  sessionLabel: string
  sessionDescription: string
  path: string
  entries: RemoteFileEntry[]
  status: SftpViewStatus
  error: string | null
  errorCode: OperationErrorCode | null
  selectedPath: string | null
  selectedPaths: string[]
  operation: SftpOperationState | null
  sessionConnected: boolean
  /** Local sources (OS files or the local panel) can be dropped onto this panel. */
  dropEnabled: boolean
  onSelectionChange: (paths: string[], anchor: string | null) => void
  onEnter: (entry: RemoteFileEntry) => void
  onEditFile: (entry: RemoteFileEntry) => void
  onUpload: () => void
  onDownload: (entries: RemoteFileEntry[]) => void
  onNavigate: (path: string) => void
  onUp: () => void
  onRefresh: () => void
  onNewFolder: () => void
  onRename: (entry: RemoteFileEntry) => void
  onDelete: (entry: RemoteFileEntry) => void
  onRetry: () => void
  onDismissOperation: () => void
  onDropLocalSources: (paths: string[]) => void
  onCopyPath: (path: string) => void
}

function splitBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const normalized = normalizeRemotePath(path || '/')
  const crumbs = [{ label: '/', path: '/' }]
  let current = ''
  for (const segment of normalized.split('/').filter(Boolean)) {
    current += `/${segment}`
    crumbs.push({ label: segment, path: current })
  }
  return crumbs
}

function entryIcon(kind: RemoteFileEntry['kind']) {
  if (kind === 'directory') return Folder
  if (kind === 'symlink') return Link2
  return FileText
}

function entryKindLabel(kind: RemoteFileEntry['kind']): string {
  if (kind === 'directory') return '目录'
  if (kind === 'symlink') return '符号链接'
  return '文件'
}

function entrySize(entry: RemoteFileEntry): string {
  return entry.kind === 'file' && entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : '—'
}

export function RemoteFilePanel({
  sessionId,
  sessionLabel,
  sessionDescription,
  path,
  entries,
  status,
  error,
  errorCode,
  selectedPath,
  selectedPaths,
  operation,
  sessionConnected,
  dropEnabled,
  onSelectionChange,
  onEnter,
  onEditFile,
  onUpload,
  onDownload,
  onNavigate,
  onUp,
  onRefresh,
  onNewFolder,
  onRename,
  onDelete,
  onRetry,
  onDismissOperation,
  onDropLocalSources,
  onCopyPath,
}: RemoteFilePanelProps) {
  const pathInputId = useId()
  const [editingPath, setEditingPath] = useState(false)
  const [pathDraft, setPathDraft] = useState(path)
  const [pathError, setPathError] = useState<string | null>(null)

  useEffect(() => {
    setEditingPath(false)
    setPathDraft(path)
    setPathError(null)
  }, [path])

  const selectedSet = new Set(selectedPaths)
  const selectedEntries = entries.filter((entry) => selectedSet.has(entry.path))
  const selectedFiles = selectedEntries.filter((entry) => entry.kind === 'file')
  const singleSelected = selectedEntries.length === 1 ? selectedEntries[0]! : null
  const busy =
    !sessionConnected ||
    status === 'opening' ||
    status === 'loading' ||
    operation?.status === 'running'
  const actionDisabled = !sessionConnected || status !== 'ready' || operation?.status === 'running'
  const crumbs = splitBreadcrumbs(path)
  const guidance = sftpErrorGuidance(errorCode)
  const normalizedPath = normalizeRemotePath(path || '/')
  const canGoUp = normalizedPath !== '/'
  const showDisconnected = !sessionConnected || status === 'disconnected'
  const showLoading = status === 'opening' || (status === 'loading' && entries.length === 0)
  const showErrorState = status === 'error' && entries.length === 0 && !showDisconnected

  const dropZone = useDropZone({
    canAccept: (event) =>
      Boolean(
        dropEnabled &&
          sessionId !== null &&
          (hasOsFiles(event.dataTransfer) || hasLocalPaths(event.dataTransfer)),
      ),
    onDrop: (dataTransfer) => {
      const custom = readLocalPaths(dataTransfer)
      const paths = custom.length > 0 ? custom : collectOsFilePaths(dataTransfer)
      if (paths.length === 0) return
      onDropLocalSources(paths)
    },
  })

  const openPathEditor = (): void => {
    setPathDraft(path)
    setPathError(null)
    setEditingPath(true)
  }

  const submitPath = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (pathDraft.trim().length === 0) {
      setPathError('请输入远程目录路径')
      return
    }
    const resolved = resolveRemotePath(path || '/', pathDraft)
    const validation = getRemotePathError(resolved)
    if (validation) {
      setPathError(validation)
      return
    }
    setEditingPath(false)
    setPathError(null)
    if (resolved !== normalizedPath) onNavigate(resolved)
  }

  const selectRow = (entry: RemoteFileEntry, event: ReactMouseEvent<HTMLButtonElement>): void => {
    const additive = event.ctrlKey || event.metaKey
    const range = event.shiftKey

    if (range) {
      const anchorPath =
        selectedPath && entries.some((candidate) => candidate.path === selectedPath)
          ? selectedPath
          : entry.path
      const anchorIndex = entries.findIndex((candidate) => candidate.path === anchorPath)
      const targetIndex = entries.findIndex((candidate) => candidate.path === entry.path)
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex)
        const end = Math.max(anchorIndex, targetIndex)
        const rangePaths = entries.slice(start, end + 1).map((candidate) => candidate.path)
        const nextPaths = additive
          ? entries
              .filter(
                (candidate) =>
                  selectedSet.has(candidate.path) || rangePaths.includes(candidate.path),
              )
              .map((candidate) => candidate.path)
          : rangePaths
        onSelectionChange(nextPaths, anchorPath)
        return
      }
    }

    if (additive) {
      const next = new Set(selectedPaths)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      const nextPaths = entries
        .filter((candidate) => next.has(candidate.path))
        .map((candidate) => candidate.path)
      onSelectionChange(
        nextPaths,
        next.has(entry.path) ? entry.path : (nextPaths[nextPaths.length - 1] ?? null),
      )
      return
    }

    onSelectionChange([entry.path], entry.path)
  }

  return (
    <section
      className={cn('file-panel', dropZone.isOver && 'file-panel--drop-target')}
      aria-label="远程 SFTP 文件"
      {...dropZone.dropZoneProps}
    >
      <header className="file-panel__header">
        <div className="file-panel__title-row">
          <FolderOpen className="file-panel__icon" size={14} aria-hidden="true" />
          <span className="file-panel__title">远程</span>
          <span className="file-panel__description" title={sessionDescription}>
            {sessionLabel}
          </span>
          {showDisconnected ? (
            <Badge tone="danger">SFTP 不可用</Badge>
          ) : status === 'ready' ? (
            <Badge tone="success">SFTP 已连接</Badge>
          ) : (
            <Badge tone="warning">读取中</Badge>
          )}
        </div>

        <div className="file-panel__toolbar">
          <IconButton
            label="返回上一级目录"
            size="sm"
            disabled={!canGoUp || !sessionConnected || busy}
            onClick={onUp}
          >
            <ArrowUp size={14} aria-hidden="true" />
          </IconButton>
          <nav className="breadcrumbs" aria-label="远程路径">
            {crumbs.map((crumb, index) => {
              const isLast = index === crumbs.length - 1
              return (
                <span className="breadcrumb-fragment" key={crumb.path}>
                  {index > 0 ? (
                    <span className="breadcrumb-separator" aria-hidden="true">
                      /
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
                      disabled={!sessionConnected || busy}
                      onClick={() => onNavigate(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  )}
                </span>
              )
            })}
          </nav>
          <div className="file-panel__actions">
            <IconButton
              label="复制当前文件夹路径"
              title={normalizedPath}
              size="sm"
              onClick={() => onCopyPath(normalizedPath)}
            >
              <Copy size={14} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="输入远程路径"
              size="sm"
              disabled={!sessionConnected}
              onClick={openPathEditor}
            >
              <PencilLine size={14} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="刷新远程目录"
              size="sm"
              disabled={!sessionConnected || busy}
              onClick={onRefresh}
            >
              <RefreshCw
                className={status === 'loading' ? 'spin' : undefined}
                size={14}
                aria-hidden="true"
              />
            </IconButton>
            <IconButton
              label="上传本地文件到当前目录"
              size="sm"
              disabled={actionDisabled}
              onClick={onUpload}
            >
              <ArrowUpFromLine size={14} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={
                selectedFiles.length > 0
                  ? `下载选中的 ${selectedFiles.length} 个远程文件`
                  : '下载选中的远程文件'
              }
              size="sm"
              disabled={selectedFiles.length === 0 || actionDisabled}
              onClick={() => onDownload(selectedFiles)}
            >
              <ArrowDownToLine size={14} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="新建远程目录"
              size="sm"
              disabled={actionDisabled}
              onClick={onNewFolder}
            >
              <FolderPlus size={14} aria-hidden="true" />
            </IconButton>
          </div>
        </div>

        {editingPath ? (
          <form className="sftp-path-form" onSubmit={submitPath} noValidate>
            <label className="sr-only" htmlFor={pathInputId}>
              远程路径
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
              <p className="field__hint">支持绝对路径与 ../ 解析；路径规范化不代表服务器授权。</p>
            )}
          </form>
        ) : null}
      </header>

      {operation?.status === 'error' ? (
        <div className="file-panel__banner file-panel__banner--warning" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{operation.error}</span>
          <button
            type="button"
            className="file-panel__banner-dismiss"
            aria-label="关闭文件操作错误"
            onClick={onDismissOperation}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {error && entries.length > 0 && !showDisconnected ? (
        <div className="file-panel__banner file-panel__banner--danger" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>
            {error}
            {guidance ? ` ${guidance}` : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            重试
          </Button>
        </div>
      ) : null}

      <div className="file-list" aria-label="远程文件列表">
        <div className="file-list__head" aria-hidden="true">
          <span>名称</span>
          <span>大小</span>
          <span>修改时间</span>
        </div>

        {showDisconnected ? (
          <div className="file-panel__state" role="status">
            <span className="file-panel__state-icon">
              <WifiOff size={18} aria-hidden="true" />
            </span>
            <strong>SSH 会话不可用</strong>
            <p>
              该 SFTP 会话已随 SSH 连接断开。请在工作台重新连接；本页不会复用其他会话的目录数据。
            </p>
            {error ? <p className="file-panel__state-error">{error}</p> : null}
            <Button size="sm" variant="secondary" disabled={!sessionConnected} onClick={onRetry}>
              重新打开 SFTP
            </Button>
          </div>
        ) : showLoading ? (
          <div className="file-panel__state" role="status">
            <div className="sftp-loading">
              <LoaderCircle className="spin" size={16} aria-hidden="true" />
              {status === 'opening' ? '正在打开 SFTP 通道…' : '正在读取远程目录…'}
            </div>
          </div>
        ) : showErrorState ? (
          <div className="file-panel__state" role="alert">
            <span className="file-panel__state-icon file-panel__state-icon--danger">
              <AlertTriangle size={18} aria-hidden="true" />
            </span>
            <strong>无法读取目录</strong>
            <p>{error ?? '服务器未返回目录内容。'}</p>
            {guidance ? <p className="file-panel__state-hint">{guidance}</p> : null}
            <Button size="sm" variant="secondary" onClick={onRetry}>
              重试
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="file-panel__state" role="status">
            <span className="file-panel__state-icon">
              <Folder size={18} aria-hidden="true" />
            </span>
            <strong>此目录为空</strong>
            <p>服务器返回了 0 个条目。空目录可以直接作为安全删除的目标。</p>
          </div>
        ) : (
          entries.map((entry) => {
            const Icon = entryIcon(entry.kind)
            const isSelected = selectedSet.has(entry.path)
            const draggable = entry.kind === 'file' && sessionConnected && sessionId !== null
            return (
              <button
                type="button"
                aria-pressed={isSelected}
                className={cn('file-row', isSelected && 'file-row--selected')}
                draggable={draggable}
                key={entry.path}
                title={`${entry.path}\n权限：${entry.permissions ?? '未知'}${
                  entry.kind === 'directory' ? '\n双击进入目录' : '\n双击用内置编辑器打开'
                }${draggable ? '\n拖拽到左侧本地面板可下载' : ''}`}
                onClick={(event) => selectRow(entry, event)}
                onDoubleClick={() => {
                  if (entry.kind === 'directory') onEnter(entry)
                  else if (entry.kind === 'file') onEditFile(entry)
                }}
                onDragStart={(event) => {
                  const sources = selectedSet.has(entry.path)
                    ? selectedEntries.filter((candidate) => candidate.kind === 'file')
                    : [entry]
                  const paths = sources.map((candidate) => candidate.path)
                  if (paths.length === 0 || sessionId === null) {
                    event.preventDefault()
                    return
                  }
                  writeRemoteFiles(event.dataTransfer, sessionId, paths)
                }}
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

      <div className="file-selection-detail">
        <div className="file-selection-detail__main">
          {singleSelected ? (
            <>
              <span className="file-selection-detail__name" title={singleSelected.name}>
                {singleSelected.name}
              </span>
              <span className="file-selection-detail__meta" title={singleSelected.path}>
                {entryKindLabel(singleSelected.kind)} · {singleSelected.permissions ?? '权限未知'} ·{' '}
                {singleSelected.path}
              </span>
            </>
          ) : selectedEntries.length > 1 ? (
            <>
              <span className="file-selection-detail__name">已选择 {selectedEntries.length} 项</span>
              <span className="file-selection-detail__meta">
                {selectedFiles.length} 个文件 ·{' '}
                {selectedEntries.length - selectedFiles.length} 个目录 / 链接 · 下载只会包含文件
              </span>
            </>
          ) : (
            <span className="file-selection-detail__meta">
              {status === 'loading'
                ? '正在刷新目录…'
                : '点击选择；Ctrl/⌘ 多选，Shift 连选'}
            </span>
          )}
        </div>
        <div className="file-selection-detail__actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={!singleSelected}
            onClick={() => {
              if (singleSelected) onCopyPath(singleSelected.path)
            }}
          >
            <Copy size={13} aria-hidden="true" />
            复制路径
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedFiles.length === 0 || actionDisabled}
            onClick={() => onDownload(selectedFiles)}
          >
            <ArrowDownToLine size={13} aria-hidden="true" />
            下载{selectedFiles.length > 1 ? ` (${selectedFiles.length})` : ''}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!singleSelected || singleSelected.kind !== 'file' || actionDisabled}
            onClick={() => {
              if (singleSelected) onEditFile(singleSelected)
            }}
          >
            <FilePenLine size={13} aria-hidden="true" />
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!singleSelected || actionDisabled}
            onClick={() => {
              if (singleSelected) onRename(singleSelected)
            }}
          >
            <PencilLine size={13} aria-hidden="true" />
            重命名
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="file-action--danger"
            disabled={!singleSelected || actionDisabled}
            onClick={() => {
              if (singleSelected) onDelete(singleSelected)
            }}
          >
            <Trash2 size={13} aria-hidden="true" />
            删除
          </Button>
        </div>
      </div>

      <footer className="file-panel__footer">
        <span>
          {entries.length} 个条目 · 已选 {selectedEntries.length} ·{' '}
          {status === 'loading' ? '正在读取' : '真实远程数据'}
        </span>
        <span className="file-selection-bar">
          <Info size={11} aria-hidden="true" />
          {sessionDescription}
        </span>
      </footer>
    </section>
  )
}
