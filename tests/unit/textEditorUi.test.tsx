import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RemoteTextFile, SftpTextWriteInput } from '@shared/types'
import { RemoteTextEditor } from '@renderer/features/editor/RemoteTextEditor'
import { useTextEditorStore } from '@renderer/stores/textEditorStore'
import { createFakeBridge } from './helpers/fakeBridge'

vi.mock('../../src/renderer/src/features/editor/CodeMirrorSurface', async () => {
  const React = await import('react')
  interface MockSurfaceProps {
    content: string
    onChange: (content: string) => void
    onSave: () => void
  }
  const CodeMirrorSurface = React.forwardRef<
    { openSearch: () => void; focus: () => void },
    MockSurfaceProps
  >(function MockCodeMirrorSurface({ content, onChange, onSave }, ref) {
    React.useImperativeHandle(ref, () => ({ openSearch: () => undefined, focus: () => undefined }))
    return React.createElement('textarea', {
      'aria-label': '编辑器内容',
      value: content,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      onKeyDown: (event: {
        key: string
        ctrlKey: boolean
        metaKey: boolean
        preventDefault: () => void
      }) => {
        if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          onSave()
        }
      },
    })
  })
  return { CodeMirrorSurface }
})

const SESSION = 'ssh-session-a'
const PATH = '/srv/app/notes.txt'

function remoteFile(overrides: Partial<RemoteTextFile> = {}): RemoteTextFile {
  return {
    sessionId: SESSION,
    path: PATH,
    content: 'line one\nline two\n',
    encoding: 'utf-8',
    eol: 'lf',
    revision: '100:20',
    sizeBytes: 20,
    modifiedAt: '2026-10-22T08:00:00.000Z',
    permissions: '-rw-r--r--',
    ...overrides,
  }
}

function setupBridge(sftp: Parameters<typeof createFakeBridge>[3] = {}) {
  window.termforge = createFakeBridge({}, {}, {}, sftp)
}

async function openEditor(): Promise<HTMLTextAreaElement> {
  render(<RemoteTextEditor />)
  await act(async () => {
    await useTextEditorStore.getState().openFile(SESSION, PATH)
  })
  return screen.findByLabelText('编辑器内容')
}

describe('RemoteTextEditor', () => {
  beforeEach(() => {
    useTextEditorStore.getState().reset()
  })

  afterEach(() => {
    useTextEditorStore.getState().reset()
    delete window.termforge
  })

  it('edits and saves the active tab from the toolbar and Ctrl+S', async () => {
    const readTextFile = vi.fn(async () => ({ ok: true as const, value: remoteFile() }))
    const writeTextFile = vi.fn(async (input: SftpTextWriteInput) => ({
      ok: true as const,
      value: {
        sessionId: input.sessionId,
        path: input.path,
        revision: '200:8',
        sizeBytes: input.content.length,
        modifiedAt: '2026-10-22T08:05:00.000Z',
        backupCleanupFailed: false,
      },
    }))
    setupBridge({ readTextFile, writeTextFile })

    const textarea = await openEditor()
    expect(screen.getByRole('dialog', { name: '内置文本编辑器' })).toBeInTheDocument()
    expect(textarea).toHaveValue('line one\nline two\n')

    fireEvent.change(textarea, { target: { value: 'edited\n' } })
    expect(useTextEditorStore.getState().tabs[0]!.content).toBe('edited\n')
    expect(screen.getByText('未保存')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(writeTextFile).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'edited\n', expectedRevision: '100:20' }),
      ),
    )
    expect(await screen.findByText('已保存')).toBeInTheDocument()

    fireEvent.change(textarea, { target: { value: 'edited twice\n' } })
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true })
    await waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(2))
  })

  it('offers reload or forced overwrite after a revision conflict', async () => {
    const readTextFile = vi.fn(async () => ({ ok: true as const, value: remoteFile() }))
    const writeTextFile = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'conflict' as const, message: '远程文件已被其他程序修改，未覆盖。' },
      })
      .mockImplementationOnce(async (input: SftpTextWriteInput) => ({
        ok: true as const,
        value: {
          sessionId: input.sessionId,
          path: input.path,
          revision: '300:7',
          sizeBytes: input.content.length,
          modifiedAt: '2026-10-22T08:06:00.000Z',
          backupCleanupFailed: false,
        },
      }))
    setupBridge({ readTextFile, writeTextFile })

    const textarea = await openEditor()
    fireEvent.change(textarea, { target: { value: 'local\n' } })
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('远程文件已被其他程序修改')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '强制保存' }))

    await waitFor(() =>
      expect(writeTextFile).toHaveBeenLastCalledWith(expect.objectContaining({ force: true })),
    )
    expect(await screen.findByText('已保存')).toBeInTheDocument()
  })

  it('confirms before discarding dirty tabs when closing the overlay', async () => {
    const readTextFile = vi.fn(async () => ({ ok: true as const, value: remoteFile() }))
    setupBridge({ readTextFile })

    const textarea = await openEditor()
    fireEvent.change(textarea, { target: { value: 'unsaved\n' } })

    await userEvent.click(screen.getByRole('button', { name: '关闭编辑器' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: '放弃修改并关闭' }))

    expect(useTextEditorStore.getState()).toMatchObject({ open: false, tabs: [] })
    expect(screen.queryByRole('dialog', { name: '内置文本编辑器' })).not.toBeInTheDocument()
  })
})
