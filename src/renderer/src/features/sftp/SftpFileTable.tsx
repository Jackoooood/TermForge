import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  FileText,
  Folder,
  Link2,
} from 'lucide-react'
import type { RemoteFileEntry } from '@shared/types'
import type { RemoteSortField, RemoteSortState } from '@shared/sftp/remotePath'
import { cn, formatBytes, formatDateTime } from '@renderer/lib/utils'

interface SftpFileTableProps {
  entries: RemoteFileEntry[]
  selectedPaths: string[]
  sort: RemoteSortState
  onSort: (field: RemoteSortField) => void
  onSelectionChange: (paths: string[], anchor: string | null) => void
  onOpen: (entry: RemoteFileEntry) => void
  onContextMenu: (entry: RemoteFileEntry, position: { x: number; y: number }) => void
}

function entryIcon(kind: RemoteFileEntry['kind']) {
  if (kind === 'directory') return Folder
  if (kind === 'symlink') return Link2
  return FileText
}

function SortHeader({
  field,
  label,
  sort,
  onSort,
  className,
}: {
  field: RemoteSortField
  label: string
  sort: RemoteSortState
  onSort: (field: RemoteSortField) => void
  className: string
}) {
  const active = sort.field === field
  const Icon = !active ? ChevronsUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown
  return (
    <th
      scope="col"
      className={className}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={cn('sftp-dock__sort-btn', active && 'sftp-dock__sort-btn--active')}
        title={`按${label}排序${active ? (sort.direction === 'asc' ? '（当前升序）' : '（当前降序）') : ''}`}
        onClick={() => onSort(field)}
      >
        {label}
        <Icon size={10} aria-hidden="true" />
      </button>
    </th>
  )
}

export function SftpFileTable({
  entries,
  selectedPaths,
  sort,
  onSort,
  onSelectionChange,
  onOpen,
  onContextMenu,
}: SftpFileTableProps) {
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const anchorRef = useRef<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>())

  useEffect(() => {
    setFocusPath((current) => {
      if (current && entries.some((entry) => entry.path === current)) return current
      return (
        entries.find((entry) => selectedPaths.includes(entry.path))?.path ??
        entries[0]?.path ??
        null
      )
    })
  }, [entries, selectedPaths])

  const selectedSet = new Set(selectedPaths)
  const activeFocusPath =
    focusPath && entries.some((entry) => entry.path === focusPath)
      ? focusPath
      : (entries[0]?.path ?? null)

  const selectRange = (fromPath: string, toPath: string): void => {
    const fromIndex = entries.findIndex((entry) => entry.path === fromPath)
    const toIndex = entries.findIndex((entry) => entry.path === toPath)
    if (fromIndex === -1 || toIndex === -1) {
      onSelectionChange([toPath], toPath)
      return
    }
    const start = Math.min(fromIndex, toIndex)
    const end = Math.max(fromIndex, toIndex)
    onSelectionChange(
      entries.slice(start, end + 1).map((entry) => entry.path),
      fromPath,
    )
  }

  const toggleEntry = (entry: RemoteFileEntry): void => {
    const next = new Set(selectedPaths)
    if (next.has(entry.path)) next.delete(entry.path)
    else next.add(entry.path)
    anchorRef.current = entry.path
    onSelectionChange(
      entries.filter((candidate) => next.has(candidate.path)).map((candidate) => candidate.path),
      entry.path,
    )
  }

  const handleRowClick = (entry: RemoteFileEntry, event: MouseEvent<HTMLTableRowElement>): void => {
    setFocusPath(entry.path)
    if (event.shiftKey) {
      selectRange(anchorRef.current ?? entry.path, entry.path)
      return
    }
    if (event.ctrlKey || event.metaKey) {
      toggleEntry(entry)
      return
    }
    anchorRef.current = entry.path
    onSelectionChange([entry.path], entry.path)
  }

  const focusRow = (path: string): void => {
    setFocusPath(path)
    rowRefs.current.get(path)?.focus()
  }

  const moveFocus = (entry: RemoteFileEntry, offset: number, extend: boolean): void => {
    const index = entries.findIndex((candidate) => candidate.path === entry.path)
    if (index === -1) return
    const next = entries[Math.min(entries.length - 1, Math.max(0, index + offset))]
    if (!next || next.path === entry.path) return
    if (extend) {
      const anchor = anchorRef.current ?? entry.path
      anchorRef.current = anchor
      selectRange(anchor, next.path)
    } else {
      anchorRef.current = next.path
      onSelectionChange([next.path], next.path)
    }
    focusRow(next.path)
  }

  const handleRowKeyDown = (
    entry: RemoteFileEntry,
    event: KeyboardEvent<HTMLTableRowElement>,
  ): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(entry, event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const target = event.key === 'Home' ? entries[0] : entries[entries.length - 1]
      if (!target) return
      if (event.shiftKey) {
        selectRange(anchorRef.current ?? entry.path, target.path)
      } else {
        anchorRef.current = target.path
        onSelectionChange([target.path], target.path)
      }
      focusRow(target.path)
      return
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      toggleEntry(entry)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (entry.kind !== 'symlink') onOpen(entry)
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      anchorRef.current = entries[0]?.path ?? null
      onSelectionChange(
        entries.map((candidate) => candidate.path),
        entries[0]?.path ?? null,
      )
    }
  }

  return (
    <div className="sftp-dock__table-wrap">
      <table className="sftp-dock__table" aria-label="远程文件列表">
        <thead>
          <tr>
            <SortHeader
              field="name"
              label="名称"
              sort={sort}
              onSort={onSort}
              className="sftp-dock__col-name"
            />
            <SortHeader
              field="size"
              label="大小"
              sort={sort}
              onSort={onSort}
              className="sftp-dock__col-size"
            />
            <SortHeader
              field="modified"
              label="修改时间"
              sort={sort}
              onSort={onSort}
              className="sftp-dock__col-modified"
            />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const Icon = entryIcon(entry.kind)
            const isSelected = selectedSet.has(entry.path)
            const isFocused = activeFocusPath === entry.path
            return (
              <tr
                key={entry.path}
                ref={(node) => {
                  if (node) rowRefs.current.set(entry.path, node)
                  else rowRefs.current.delete(entry.path)
                }}
                tabIndex={isFocused ? 0 : -1}
                aria-selected={isSelected}
                className={cn(
                  'sftp-dock__row',
                  isSelected && 'sftp-dock__row--selected',
                  isFocused && 'sftp-dock__row--focused',
                )}
                title={`${entry.name}\n${entry.path}${
                  entry.kind === 'directory'
                    ? '\n双击进入目录'
                    : entry.kind === 'file'
                      ? '\n双击用内置编辑器打开'
                      : ''
                }`}
                onClick={(event) => handleRowClick(entry, event)}
                onDoubleClick={() => {
                  if (entry.kind !== 'symlink') onOpen(entry)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setFocusPath(entry.path)
                  if (!selectedSet.has(entry.path)) {
                    anchorRef.current = entry.path
                    onSelectionChange([entry.path], entry.path)
                  }
                  onContextMenu(entry, { x: event.clientX, y: event.clientY })
                }}
                onKeyDown={(event) => handleRowKeyDown(entry, event)}
              >
                <td className="sftp-dock__cell sftp-dock__cell--name">
                  <div className="sftp-dock__cell-inner">
                    <Icon
                      className={cn('sftp-dock__row-icon', `sftp-dock__row-icon--${entry.kind}`)}
                      size={13}
                      aria-hidden="true"
                    />
                    <span className="sftp-dock__row-name">{entry.name}</span>
                  </div>
                </td>
                <td className="sftp-dock__cell sftp-dock__cell--size">
                  {entry.kind === 'file' && entry.sizeBytes !== null
                    ? formatBytes(entry.sizeBytes)
                    : '—'}
                </td>
                <td
                  className="sftp-dock__cell sftp-dock__cell--modified"
                  title={entry.modifiedAt ?? undefined}
                >
                  {entry.modifiedAt ? formatDateTime(entry.modifiedAt) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
