import { create } from 'zustand'
import type {
  OperationErrorCode,
  RemoteTextEncoding,
  RemoteTextEol,
  RemoteTextFile,
} from '@shared/types'

export type TextEditorTabStatus = 'loading' | 'ready' | 'saving' | 'error'

export interface TextEditorTab {
  id: string
  sessionId: string
  path: string
  name: string
  content: string
  savedContent: string
  encoding: RemoteTextEncoding
  eol: RemoteTextEol
  revision: string | null
  loaded: boolean
  status: TextEditorTabStatus
  error: string | null
  errorCode: OperationErrorCode | null
  conflict: boolean
}

interface TextEditorState {
  open: boolean
  tabs: TextEditorTab[]
  activeTabId: string | null
  openFile: (sessionId: string, path: string) => Promise<void>
  reveal: (tabId?: string | null) => void
  closeOverlay: () => void
  closeFile: (tabId: string) => void
  setActive: (tabId: string) => void
  updateContent: (tabId: string, content: string) => void
  save: (tabId: string, options?: { force?: boolean }) => Promise<boolean>
  reload: (tabId: string) => Promise<boolean>
  reset: () => void
}

export function textEditorTabId(sessionId: string, path: string): string {
  return `${sessionId}::${path}`
}

export function isTextEditorTabDirty(tab: TextEditorTab): boolean {
  return tab.loaded && tab.content !== tab.savedContent
}

function fileNameFromPath(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

function tabFromRemoteFile(file: RemoteTextFile): TextEditorTab {
  return {
    id: textEditorTabId(file.sessionId, file.path),
    sessionId: file.sessionId,
    path: file.path,
    name: fileNameFromPath(file.path),
    content: file.content,
    savedContent: file.content,
    encoding: file.encoding,
    eol: file.eol,
    revision: file.revision,
    loaded: true,
    status: 'ready',
    error: null,
    errorCode: null,
    conflict: false,
  }
}

function failedTab(sessionId: string, path: string, message: string, code: OperationErrorCode): TextEditorTab {
  return {
    id: textEditorTabId(sessionId, path),
    sessionId,
    path,
    name: fileNameFromPath(path),
    content: '',
    savedContent: '',
    encoding: 'utf-8',
    eol: 'lf',
    revision: null,
    loaded: false,
    status: 'error',
    error: message,
    errorCode: code,
    conflict: false,
  }
}

const UNAVAILABLE_MESSAGE = '未加载 Electron preload bridge，无法读写远程文件。'

export const useTextEditorStore = create<TextEditorState>((set, get) => ({
  open: false,
  tabs: [],
  activeTabId: null,

  openFile: async (sessionId, path) => {
    const id = textEditorTabId(sessionId, path)
    const existing = get().tabs.find((tab) => tab.id === id)
    set({ open: true, activeTabId: id })
    if (existing) return

    const bridge = window.termforge
    const placeholder = failedTab(sessionId, path, '', 'unavailable')
    set((state) => ({
      tabs: [
        ...state.tabs,
        { ...placeholder, loaded: false, status: 'loading', error: null, errorCode: null },
      ],
    }))
    if (!bridge) {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                status: 'error',
                error: UNAVAILABLE_MESSAGE,
                errorCode: 'unavailable',
              }
            : tab,
        ),
      }))
      return
    }

    try {
      const result = await bridge.sftp.readTextFile(sessionId, path)
      const current = get().tabs.find((tab) => tab.id === id)
      if (!current) return
      if (!result.ok) {
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === id
              ? {
                  ...tab,
                  status: 'error',
                  error: result.error.message,
                  errorCode: result.error.code,
                  loaded: false,
                }
              : tab,
          ),
        }))
        return
      }
      const loadedTab = tabFromRemoteFile(result.value)
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? loadedTab : tab)),
      }))
    } catch {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                status: 'error',
                error: '读取远程文件失败，请稍后重试。',
                errorCode: 'internal',
              }
            : tab,
        ),
      }))
    }
  },

  reveal: (tabId) =>
    set((state) => {
      if (tabId && state.tabs.some((tab) => tab.id === tabId)) {
        return { open: true, activeTabId: tabId }
      }
      return { open: true }
    }),

  closeOverlay: () => set({ open: false }),

  closeFile: (tabId) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) return state
      const tabs = state.tabs.filter((tab) => tab.id !== tabId)
      const activeTabId =
        state.activeTabId === tabId
          ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
          : state.activeTabId
      return { tabs, activeTabId, open: tabs.length > 0 ? state.open : false }
    }),

  setActive: (tabId) =>
    set((state) => (state.tabs.some((tab) => tab.id === tabId) ? { activeTabId: tabId } : state)),

  updateContent: (tabId, content) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId && tab.content !== content ? { ...tab, content } : tab,
      ),
    })),

  save: async (tabId, options) => {
    const tab = get().tabs.find((candidate) => candidate.id === tabId)
    if (!tab || !tab.loaded || tab.status === 'loading') return false
    if (!options?.force && !isTextEditorTabDirty(tab)) return true
    const bridge = window.termforge
    if (!bridge) {
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId
            ? { ...candidate, status: 'error', error: UNAVAILABLE_MESSAGE, errorCode: 'unavailable' }
            : candidate,
        ),
      }))
      return false
    }

    const contentToSave = tab.content
    set((state) => ({
      tabs: state.tabs.map((candidate) =>
        candidate.id === tabId
          ? { ...candidate, status: 'saving', error: null, errorCode: null }
          : candidate,
      ),
    }))

    try {
      const result = await bridge.sftp.writeTextFile({
        sessionId: tab.sessionId,
        path: tab.path,
        content: contentToSave,
        encoding: tab.encoding,
        eol: tab.eol,
        expectedRevision: tab.revision,
        force: options?.force ?? false,
      })
      if (!get().tabs.some((candidate) => candidate.id === tabId)) return false
      if (!result.ok) {
        set((state) => ({
          tabs: state.tabs.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  status: 'error',
                  error: result.error.message,
                  errorCode: result.error.code,
                  conflict: result.error.code === 'conflict',
                }
              : candidate,
          ),
        }))
        return false
      }
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId
            ? {
                ...candidate,
                savedContent: contentToSave,
                revision: result.value.revision,
                status: 'ready',
                error: null,
                errorCode: null,
                conflict: false,
              }
            : candidate,
        ),
      }))
      return true
    } catch {
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId
            ? {
                ...candidate,
                status: 'error',
                error: '保存远程文件失败，请稍后重试。',
                errorCode: 'internal',
              }
            : candidate,
        ),
      }))
      return false
    }
  },

  reload: async (tabId) => {
    const tab = get().tabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.status === 'saving') return false
    const bridge = window.termforge
    if (!bridge) {
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId
            ? { ...candidate, status: 'error', error: UNAVAILABLE_MESSAGE, errorCode: 'unavailable' }
            : candidate,
        ),
      }))
      return false
    }
    set((state) => ({
      tabs: state.tabs.map((candidate) =>
        candidate.id === tabId
          ? { ...candidate, status: 'loading', error: null, errorCode: null }
          : candidate,
      ),
    }))
    try {
      const result = await bridge.sftp.readTextFile(tab.sessionId, tab.path)
      if (!get().tabs.some((candidate) => candidate.id === tabId)) return false
      if (!result.ok) {
        set((state) => ({
          tabs: state.tabs.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  status: 'error',
                  error: result.error.message,
                  errorCode: result.error.code,
                }
              : candidate,
          ),
        }))
        return false
      }
      const loadedTab = tabFromRemoteFile(result.value)
      set((state) => ({
        tabs: state.tabs.map((candidate) => (candidate.id === tabId ? loadedTab : candidate)),
      }))
      return true
    } catch {
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId
            ? { ...candidate, status: 'error', error: '读取远程文件失败，请稍后重试。', errorCode: 'internal' }
            : candidate,
        ),
      }))
      return false
    }
  },

  reset: () => set({ open: false, tabs: [], activeTabId: null }),
}))
