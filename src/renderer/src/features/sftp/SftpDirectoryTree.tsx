import type { KeyboardEvent, ReactNode } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { remoteParentPath } from '@shared/sftp/remotePath'
import type { SftpTreeState } from '@renderer/stores/sftpStore'
import { cn } from '@renderer/lib/utils'

interface SftpDirectoryTreeProps {
  tree: SftpTreeState
  currentPath: string
  rootPath?: string
  rootLabel?: string
  onNavigate: (path: string) => void
  onToggle: (path: string, expanded: boolean) => void
  onRetry: (path: string) => void
}

export function SftpDirectoryTree({
  tree,
  currentPath,
  rootPath = '/',
  rootLabel = '/',
  onNavigate,
  onToggle,
  onRetry,
}: SftpDirectoryTreeProps) {
  const expandedPaths = new Set(tree.expandedPaths)

  const renderNode = (path: string, label: string, depth: number, key: string): ReactNode => {
    const isExpanded = expandedPaths.has(path)
    const listing = tree.listings[path]
    const isCurrent = currentPath === path
    const isAncestor =
      path === rootPath ? currentPath !== rootPath : currentPath.startsWith(`${path}/`)
    const isLoading = listing?.status === 'loading'
    const hasError = listing?.status === 'error'
    const directories = listing?.directories ?? []
    const indent = 6 + depth * 13

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (!isExpanded) onToggle(path, true)
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (isExpanded) {
          onToggle(path, false)
        } else if (path !== rootPath) {
          onNavigate(remoteParentPath(path))
        }
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onNavigate(path)
      }
    }

    return (
      <li key={key} role="none">
        <div
          role="treeitem"
          aria-expanded={isExpanded}
          aria-selected={isCurrent}
          aria-level={depth + 1}
          tabIndex={0}
          className={cn(
            'sftp-tree__row',
            isCurrent && 'sftp-tree__row--current',
            isAncestor && !isCurrent && 'sftp-tree__row--ancestor',
            hasError && 'sftp-tree__row--error',
          )}
          style={{ paddingLeft: `${indent}px` }}
          title={`${path}${isExpanded ? '' : '\n双击或按 → 展开'}`}
          onClick={() => onNavigate(path)}
          onDoubleClick={() => {
            if (!isExpanded) onToggle(path, true)
          }}
          onKeyDown={handleKeyDown}
        >
          <span
            className={cn('sftp-tree__chevron', isExpanded && 'sftp-tree__chevron--open')}
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation()
              onToggle(path, !isExpanded)
            }}
          >
            <ChevronRight size={12} />
          </span>
          {isExpanded ? (
            <FolderOpen className="sftp-tree__icon" size={13} aria-hidden="true" />
          ) : (
            <Folder className="sftp-tree__icon" size={13} aria-hidden="true" />
          )}
          <span className="sftp-tree__label">{label}</span>
          {isLoading ? (
            <LoaderCircle className="sftp-tree__spinner spin" size={11} aria-label="正在读取" />
          ) : null}
          {hasError ? (
            <AlertTriangle className="sftp-tree__error-icon" size={11} aria-label="读取失败" />
          ) : null}
        </div>

        {isExpanded && hasError && directories.length === 0 ? (
          <div className="sftp-tree__notice" style={{ paddingLeft: `${indent + 17}px` }}>
            <span title={listing?.error ?? undefined}>{listing?.error ?? '无法读取该目录。'}</span>
            <button
              type="button"
              className="sftp-tree__retry"
              onClick={(event) => {
                event.stopPropagation()
                onRetry(path)
              }}
            >
              <RefreshCw size={10} aria-hidden="true" />
              重试
            </button>
          </div>
        ) : null}

        {isExpanded && listing?.status === 'ready' && directories.length === 0 ? (
          <div
            className="sftp-tree__notice sftp-tree__notice--muted"
            style={{ paddingLeft: `${indent + 17}px` }}
          >
            空目录
          </div>
        ) : null}

        {isExpanded && directories.length > 0 ? (
          <ul role="group" className="sftp-tree__group">
            {directories.map((directory) =>
              renderNode(directory.path, directory.name, depth + 1, directory.path),
            )}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <div className="sftp-tree" role="tree" aria-label="远程目录树">
      {renderNode(rootPath, rootLabel, 0, rootPath)}
    </div>
  )
}
