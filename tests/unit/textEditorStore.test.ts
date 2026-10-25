import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteTextFile, SftpTextWriteAck, SftpTextWriteInput } from '@shared/types'
import {
  isTextEditorTabDirty,
  textEditorTabId,
  useTextEditorStore,
} from '@renderer/stores/textEditorStore'
import { createFakeBridge } from './helpers/fakeBridge'

const SESSION = 'ssh-session-a'
const PATH = '/srv/app/notes.txt'
const OTHER_PATH = '/srv/app/run.sh'

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

function writeAck(input: SftpTextWriteInput): SftpTextWriteAck {
  return {
    sessionId: input.sessionId,
    path: input.path,
    revision: '200:30',
    sizeBytes: input.content.length,
    modifiedAt: '2026-10-22T08:05:00.000Z',
    backupCleanupFailed: false,
  }
}

function setupBridge(sftp: Parameters<typeof createFakeBridge>[3] = {}) {
  const bridge = createFakeBridge({}, {}, {}, sftp)
  window.termforge = bridge
  return bridge
}

describe('textEditorStore', () => {
  beforeEach(() => {
    useTextEditorStore.getState().reset()
  })

  afterEach(() => {
    useTextEditorStore.getState().reset()
    delete window.termforge
  })

  it('opens a remote file in a tab and reuses the tab on repeat opens', async () => {
    const readTextFile = vi.fn(async () => ({ ok: true as const, value: remoteFile() }))
    setupBridge({ readTextFile })

    await useTextEditorStore.getState().openFile(SESSION, PATH)

    const state = useTextEditorStore.getState()
    const tabId = textEditorTabId(SESSION, PATH)
    expect(state.open).toBe(true)
    expect(state.activeTabId).toBe(tabId)
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({
      id: tabId,
      sessionId: SESSION,
      path: PATH,
      name: 'notes.txt',
      content: 'line one\nline two\n',
      savedContent: 'line one\nline two\n',
      encoding: 'utf-8',
      eol: 'lf',
      revision: '100:20',
      loaded: true,
      status: 'ready',
      conflict: false,
    })
    expect(isTextEditorTabDirty(state.tabs[0]!)).toBe(false)

    await useTextEditorStore.getState().openFile(SESSION, PATH)
    expect(readTextFile).toHaveBeenCalledTimes(1)
  })

  it('surfaces read failures without opening an editable tab', async () => {
    const readTextFile = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'unsupported' as const, message: '该文件包含二进制内容，未作为文本打开。' },
    }))
    setupBridge({ readTextFile })

    await useTextEditorStore.getState().openFile(SESSION, PATH)

    const tab = useTextEditorStore.getState().tabs[0]!
    expect(tab).toMatchObject({
      loaded: false,
      status: 'error',
      error: '该文件包含二进制内容，未作为文本打开。',
      errorCode: 'unsupported',
    })
  })

  it('reports an unavailable bridge instead of fabricating content', async () => {
    await useTextEditorStore.getState().openFile(SESSION, PATH)

    const tab = useTextEditorStore.getState().tabs[0]!
    expect(tab).toMatchObject({ loaded: false, status: 'error', errorCode: 'unavailable' })
    expect(tab.error).toContain('preload bridge')
  })

  it('saves edited content with the loaded revision and clears the dirty state', async () => {
    const readTextFile = vi.fn(async () => ({ ok: true as const, value: remoteFile() }))
    const writeTextFile = vi.fn(async (input: SftpTextWriteInput) => ({
      ok: true as const,
      value: writeAck(input),
    }))
    setupBridge({ readTextFile, writeTextFile })
    const tabId = textEditorTabId(SESSION, PATH)

    await useTextEditorStore.getState().openFile(SESSION, PATH)
    useTextEditorStore.getState().updateContent(tabId, 'changed\n')
    expect(isTextEditorTabDirty(useTextEditorStore.getState().tabs[0]!)).toBe(true)

    await expect(useTextEditorStore.getState().save(tabId)).resolves.toBe(true)

    expect(writeTextFile).toHaveBeenCalledWith({
      sessionId: SESSION,
      path: PATH,
      content: 'changed\n',
      encoding: 'utf-8',
      eol: 'lf',
      expectedRevision: '100:20',
      force: false,
    })
    const tab = useTextEditorStore.getState().tabs[0]!
    expect(tab).toMatchObject({
      content: 'changed\n',
      savedContent: 'changed\n',
      revision: '200:30',
      status: 'ready',
      conflict: false,
    })
    expect(isTextEditorTabDirty(tab)).toBe(false)
  })

  it('skips the write when the tab has no edits', async () => {
    const readTextFile = vi.fn(async () => ({ ok: true as const, value: remoteFile() }))
    const writeTextFile = vi.fn()
    setupBridge({ readTextFile, writeTextFile })

    await useTextEditorStore.getState().openFile(SESSION, PATH)

    await expect(useTextEditorStore.getState().save(textEditorTabId(SESSION, PATH))).resolves.toBe(
      true,
    )
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('marks a revision conflict and only overwrites when forced', async () => {
    const readTextFile = vi.fn(async () => ({ ok: true as const, value: remoteFile() }))
    const writeTextFile = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'conflict' as const, message: '远程文件已被其他程序修改，未覆盖。' },
      })
      .mockImplementationOnce(async (input: SftpTextWriteInput) => ({
        ok: true as const,
        value: writeAck(input),
      }))
    setupBridge({ readTextFile, writeTextFile })
    const tabId = textEditorTabId(SESSION, PATH)

    await useTextEditorStore.getState().openFile(SESSION, PATH)
    useTextEditorStore.getState().updateContent(tabId, 'local edit\n')

    await expect(useTextEditorStore.getState().save(tabId)).resolves.toBe(false)
    let tab = useTextEditorStore.getState().tabs[0]!
    expect(tab).toMatchObject({ status: 'error', errorCode: 'conflict', conflict: true })

    await expect(useTextEditorStore.getState().save(tabId, { force: true })).resolves.toBe(true)
    expect(writeTextFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true, expectedRevision: '100:20' }),
    )
    tab = useTextEditorStore.getState().tabs[0]!
    expect(tab).toMatchObject({ status: 'ready', conflict: false, revision: '200:30' })
  })

  it('reloads the server copy and clears local edits', async () => {
    const readTextFile = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: remoteFile() })
      .mockResolvedValueOnce({
        ok: true as const,
        value: remoteFile({
          content: 'server side\n',
          revision: '300:12',
          sizeBytes: 12,
          permissions: '-rwxr-xr-x',
        }),
      })
    setupBridge({ readTextFile })
    const tabId = textEditorTabId(SESSION, PATH)

    await useTextEditorStore.getState().openFile(SESSION, PATH)
    useTextEditorStore.getState().updateContent(tabId, 'local only\n')

    await expect(useTextEditorStore.getState().reload(tabId)).resolves.toBe(true)

    const tab = useTextEditorStore.getState().tabs[0]!
    expect(tab).toMatchObject({
      content: 'server side\n',
      savedContent: 'server side\n',
      revision: '300:12',
      status: 'ready',
      error: null,
      conflict: false,
    })
    expect(isTextEditorTabDirty(tab)).toBe(false)
  })

  it('closes tabs, activates a neighbour and closes the overlay with the last tab', async () => {
    const readTextFile = vi.fn(async (_sessionId: string, path: string) => ({
      ok: true as const,
      value: remoteFile({ path, content: `${path}\n` }),
    }))
    setupBridge({ readTextFile })
    const store = useTextEditorStore.getState()
    const firstId = textEditorTabId(SESSION, PATH)
    const secondId = textEditorTabId(SESSION, OTHER_PATH)

    await store.openFile(SESSION, PATH)
    await useTextEditorStore.getState().openFile(SESSION, OTHER_PATH)
    expect(useTextEditorStore.getState().activeTabId).toBe(secondId)

    useTextEditorStore.getState().closeFile(firstId)
    expect(useTextEditorStore.getState().activeTabId).toBe(secondId)
    expect(useTextEditorStore.getState().tabs).toHaveLength(1)

    useTextEditorStore.getState().closeFile(secondId)
    expect(useTextEditorStore.getState()).toMatchObject({
      open: false,
      tabs: [],
      activeTabId: null,
    })
  })

  it('reset clears every open tab', async () => {
    const readTextFile = vi.fn(async () => ({ ok: true as const, value: remoteFile() }))
    setupBridge({ readTextFile })

    await useTextEditorStore.getState().openFile(SESSION, PATH)
    useTextEditorStore.getState().reset()

    expect(useTextEditorStore.getState()).toMatchObject({
      open: false,
      tabs: [],
      activeTabId: null,
    })
  })
})
