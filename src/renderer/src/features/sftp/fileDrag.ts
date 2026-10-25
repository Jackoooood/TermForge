import { useCallback, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'

/**
 * Cross-panel drag & drop contract. Custom MIME types keep the payload opaque
 * to other applications, and every drop re-validates in the main process:
 * the renderer only ever transports absolute path strings resolved from a
 * trusted drag source (`webUtils.getPathForFile` for OS files, store listings
 * for panel rows).
 */
export const LOCAL_PATHS_MIME = 'application/x-termforge-local-paths'
export const REMOTE_FILES_MIME = 'application/x-termforge-remote-files'

interface RemoteFilesPayload {
  sessionId: string
  paths: string[]
}

export function writeLocalPaths(dataTransfer: DataTransfer, paths: string[]): void {
  if (paths.length === 0) return
  dataTransfer.setData(LOCAL_PATHS_MIME, JSON.stringify({ paths }))
  dataTransfer.effectAllowed = 'copy'
}

export function writeRemoteFiles(
  dataTransfer: DataTransfer,
  sessionId: string,
  paths: string[],
): void {
  if (sessionId.length === 0 || paths.length === 0) return
  dataTransfer.setData(REMOTE_FILES_MIME, JSON.stringify({ sessionId, paths }))
  dataTransfer.effectAllowed = 'copy'
}

function safePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((path): path is string => typeof path === 'string' && path.length > 0)
}

export function readLocalPaths(dataTransfer: DataTransfer): string[] {
  try {
    const raw = dataTransfer.getData(LOCAL_PATHS_MIME)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return []
    return safePathList((parsed as { paths?: unknown }).paths)
  } catch {
    return []
  }
}

export function readRemoteFiles(dataTransfer: DataTransfer): RemoteFilesPayload | null {
  try {
    const raw = dataTransfer.getData(REMOTE_FILES_MIME)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { sessionId, paths } = parsed as { sessionId?: unknown; paths?: unknown }
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    const safePaths = safePathList(paths)
    if (safePaths.length === 0) return null
    return { sessionId, paths: safePaths }
  } catch {
    return null
  }
}

export function hasLocalPaths(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(LOCAL_PATHS_MIME)
}

export function hasRemoteFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(REMOTE_FILES_MIME)
}

export function hasOsFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files')
}

/**
 * OS file drags expose no custom data; each `File` is resolved to an on-disk
 * path through the preload bridge. Files without a path (in-memory drags) are
 * dropped rather than guessed.
 */
export function collectOsFilePaths(dataTransfer: DataTransfer): string[] {
  const bridge = window.termforge
  if (!bridge) return []
  const paths: string[] = []
  for (const file of Array.from(dataTransfer.files)) {
    const path = bridge.getPathForFile(file)
    if (path) paths.push(path)
  }
  return [...new Set(paths)]
}

interface DropZoneOptions {
  canAccept: (event: ReactDragEvent<HTMLElement>) => boolean
  onDrop: (dataTransfer: DataTransfer) => void
}

/**
 * Drop-zone state with a dragenter/dragleave depth counter so highlight does
 * not flicker when the pointer crosses child elements. `dragover` only calls
 * `preventDefault` when the payload is acceptable, so a drop never fires for
 * content this zone must not take.
 */
export function useDropZone({ canAccept, onDrop }: DropZoneOptions): {
  isOver: boolean
  dropZoneProps: {
    onDragEnter: (event: ReactDragEvent<HTMLElement>) => void
    onDragOver: (event: ReactDragEvent<HTMLElement>) => void
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => void
    onDrop: (event: ReactDragEvent<HTMLElement>) => void
  }
} {
  const depth = useRef(0)
  const [isOver, setIsOver] = useState(false)

  const reset = useCallback((): void => {
    depth.current = 0
    setIsOver(false)
  }, [])

  return {
    isOver,
    dropZoneProps: {
      onDragEnter: (event) => {
        if (!canAccept(event)) return
        event.preventDefault()
        depth.current += 1
        setIsOver(true)
      },
      onDragOver: (event) => {
        if (!canAccept(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: () => {
        if (depth.current === 0) return
        depth.current -= 1
        if (depth.current === 0) setIsOver(false)
      },
      onDrop: (event) => {
        if (!canAccept(event)) return
        event.preventDefault()
        reset()
        onDrop(event.dataTransfer)
      },
    },
  }
}