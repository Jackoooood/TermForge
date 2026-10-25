import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TermForgeBridge } from '@shared/types'
import {
  LOCAL_PATHS_MIME,
  REMOTE_FILES_MIME,
  collectOsFilePaths,
  hasLocalPaths,
  hasOsFiles,
  hasRemoteFiles,
  readLocalPaths,
  readRemoteFiles,
  useDropZone,
  writeLocalPaths,
  writeRemoteFiles,
} from '@renderer/features/sftp/fileDrag'

class FakeDataTransfer {
  private readonly store = new Map<string, string>()
  files: File[] = []
  effectAllowed = 'uninitialized'
  dropEffect = 'none'

  setData(type: string, value: string): void {
    this.store.set(type, value)
  }

  getData(type: string): string {
    return this.store.get(type) ?? ''
  }

  get types(): string[] {
    const types = [...this.store.keys()]
    if (this.files.length > 0) types.push('Files')
    return types
  }
}

function asDataTransfer(transfer: FakeDataTransfer): DataTransfer {
  return transfer as unknown as DataTransfer
}

function setupBridge(map: Record<string, string>): ReturnType<typeof vi.fn> {
  const getPathForFile = vi.fn((file: File) => map[file.name] ?? '')
  window.termforge = { getPathForFile } as unknown as TermForgeBridge
  return getPathForFile
}

afterEach(() => {
  delete window.termforge
})

describe('fileDrag payloads', () => {
  it('roundtrips local path lists and refuses to write empty ones', () => {
    const transfer = new FakeDataTransfer()
    writeLocalPaths(asDataTransfer(transfer), ['C:\\drop\\a.txt', 'C:\\drop\\folder'])

    expect(transfer.effectAllowed).toBe('copy')
    expect(hasLocalPaths(asDataTransfer(transfer))).toBe(true)
    expect(hasRemoteFiles(asDataTransfer(transfer))).toBe(false)
    expect(readLocalPaths(asDataTransfer(transfer))).toEqual([
      'C:\\drop\\a.txt',
      'C:\\drop\\folder',
    ])

    const empty = new FakeDataTransfer()
    writeLocalPaths(asDataTransfer(empty), [])
    expect(empty.types).toEqual([])
    expect(readLocalPaths(asDataTransfer(empty))).toEqual([])
  })

  it('roundtrips the remote payload with its session binding', () => {
    const transfer = new FakeDataTransfer()
    writeRemoteFiles(asDataTransfer(transfer), 'ssh-session-1', ['/srv/a.txt'])
    expect(hasRemoteFiles(asDataTransfer(transfer))).toBe(true)
    expect(readRemoteFiles(asDataTransfer(transfer))).toEqual({
      sessionId: 'ssh-session-1',
      paths: ['/srv/a.txt'],
    })

    const unbound = new FakeDataTransfer()
    writeRemoteFiles(asDataTransfer(unbound), '', ['/srv/a.txt'])
    expect(unbound.types).toEqual([])
    expect(readRemoteFiles(asDataTransfer(unbound))).toBeNull()
  })

  it('discards malformed payloads instead of guessing', () => {
    const transfer = new FakeDataTransfer()
    transfer.setData(REMOTE_FILES_MIME, '{oops')
    expect(readRemoteFiles(asDataTransfer(transfer))).toBeNull()

    const nonObject = new FakeDataTransfer()
    nonObject.setData(REMOTE_FILES_MIME, '"just a string"')
    expect(readRemoteFiles(asDataTransfer(nonObject))).toBeNull()

    const missingSession = new FakeDataTransfer()
    missingSession.setData(REMOTE_FILES_MIME, JSON.stringify({ paths: ['/srv/a.txt'] }))
    expect(readRemoteFiles(asDataTransfer(missingSession))).toBeNull()

    const filtered = new FakeDataTransfer()
    filtered.setData(
      REMOTE_FILES_MIME,
      JSON.stringify({ sessionId: 'ssh-1', paths: ['/srv/a.txt', 5, '', null] }),
    )
    expect(readRemoteFiles(asDataTransfer(filtered))).toEqual({
      sessionId: 'ssh-1',
      paths: ['/srv/a.txt'],
    })

    const badPaths = new FakeDataTransfer()
    badPaths.setData(LOCAL_PATHS_MIME, JSON.stringify({ paths: [42] }))
    expect(readLocalPaths(asDataTransfer(badPaths))).toEqual([])
  })

  it('resolves OS files through the preload bridge and drops pathless ones', () => {
    const getPathForFile = setupBridge({ 'notes.txt': 'C:\\drop\\notes.txt' })
    const transfer = new FakeDataTransfer()
    transfer.files = [
      new File(['a'], 'notes.txt'),
      new File(['b'], 'copy-of-notes.txt'),
      new File(['c'], 'in-memory.txt'),
    ]
    getPathForFile.mockImplementation((file: File) =>
      file.name === 'in-memory.txt' ? '' : 'C:\\drop\\notes.txt',
    )

    expect(hasOsFiles(asDataTransfer(transfer))).toBe(true)
    expect(collectOsFilePaths(asDataTransfer(transfer))).toEqual(['C:\\drop\\notes.txt'])
    expect(getPathForFile).toHaveBeenCalledTimes(3)

    delete window.termforge
    expect(collectOsFilePaths(asDataTransfer(transfer))).toEqual([])
  })
})

function DropHarness({
  accept,
  onDrop,
}: {
  accept: boolean
  onDrop: (dataTransfer: DataTransfer) => void
}) {
  const zone = useDropZone({ canAccept: () => accept, onDrop })
  return (
    <div data-testid="zone" data-over={String(zone.isOver)} {...zone.dropZoneProps}>
      <span data-testid="child">child</span>
    </div>
  )
}

describe('useDropZone', () => {
  it('highlights only acceptable payloads and survives nested dragenter cycles', () => {
    render(<DropHarness accept onDrop={() => {}} />)
    const zone = screen.getByTestId('zone')
    const child = screen.getByTestId('child')
    const transfer = asDataTransfer(new FakeDataTransfer())

    fireEvent.dragEnter(child, { dataTransfer: transfer })
    fireEvent.dragEnter(zone, { dataTransfer: transfer })
    expect(zone).toHaveAttribute('data-over', 'true')

    fireEvent.dragLeave(child, { dataTransfer: transfer })
    expect(zone).toHaveAttribute('data-over', 'true')
    fireEvent.dragLeave(zone, { dataTransfer: transfer })
    expect(zone).toHaveAttribute('data-over', 'false')
  })

  it('ignores drops of unacceptable payloads', () => {
    const onDrop = vi.fn()
    render(<DropHarness accept={false} onDrop={onDrop} />)
    const zone = screen.getByTestId('zone')
    const transfer = asDataTransfer(new FakeDataTransfer())

    fireEvent.dragEnter(zone, { dataTransfer: transfer })
    expect(zone).toHaveAttribute('data-over', 'false')
    fireEvent.drop(zone, { dataTransfer: transfer })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('delivers the payload once and clears the highlight on drop', () => {
    const onDrop = vi.fn()
    render(<DropHarness accept onDrop={onDrop} />)
    const zone = screen.getByTestId('zone')
    const transfer = new FakeDataTransfer()
    writeLocalPaths(asDataTransfer(transfer), ['C:\\drop\\a.txt'])

    fireEvent.dragEnter(zone, { dataTransfer: asDataTransfer(transfer) })
    fireEvent.drop(zone, { dataTransfer: asDataTransfer(transfer) })

    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop.mock.calls[0]?.[0]).toBe(asDataTransfer(transfer))
    expect(zone).toHaveAttribute('data-over', 'false')
  })
})