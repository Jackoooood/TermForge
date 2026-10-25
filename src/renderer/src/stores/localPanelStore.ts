import { create } from 'zustand'
import type {
  LocalDirectoryListing,
  LocalFileEntry,
  LocalRootEntry,
  OperationError,
  OperationErrorCode,
} from '@shared/types'
import { getLocalPathError, normalizeLocalPath } from '@shared/localFs/localPath'
import type { LocalSortDirection, LocalSortField } from '@shared/localFs/localPath'

export type LocalPanelStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface LocalPanelTabState {
  tabId: string
  /** Empty string renders the roots view (home + drives) instead of a listing. */
  path: string
  /** Null in the roots view and at volume roots; the UI shows roots then. */
  parentPath: string | null
  entries: LocalFileEntry[]
  roots: LocalRootEntry[]
  home: string | null
  truncated: boolean
  status: LocalPanelStatus
  error: string | null
  errorCode: OperationErrorCode | null
  sortField: LocalSortField
  sortDirection: LocalSortDirection
  showHidden: boolean
  /** Anchor entry used for Shift range selection. */
  selectedPath: string | null
  /** Multi-selection used for batch upload. */
  selectedPaths: string[]
  /** Monotonic guard; late responses from older paths are dropped. */
  requestId: number
}

interface LoadOptions {
  preserveEntries?: boolean
}

interface LocalPanelStoreState {
  tabs: Record<string, LocalPanelTabState>
  /** Loads the roots and enters the home directory on first use. */
  ensure: (tabId: string) => Promise<void>
  load: (tabId: string, path: string, options?: LoadOptions) => Promise<boolean>
  refresh: (tabId: string) => Promise<boolean>
  /** Same field toggles the direction; a new field starts ascending. */
  setSort: (tabId: string, field: LocalSortField) => void
  toggleHidden: (tabId: string) => void
  setSelection: (tabId: string, paths: string[], anchor: string | null) => void
  forgetTab: (tabId: string) => void
  reset: () => void
}

function emptyTab(tabId: string): LocalPanelTabState {
  return {
    tabId,
    path: '',
    parentPath: null,
    entries: [],
    roots: [],
    home: null,
    truncated: false,
    status: 'idle',
    error: null,
    errorCode: null,
    sortField: 'name',
    sortDirection: 'asc',
    showHidden: false,
    selectedPath: null,
    selectedPaths: [],
    requestId: 0,
  }
}

function unavailableError(message: string): OperationError {
  return { code: 'unavailable', message }
}

function nextRequestId(tab: LocalPanelTabState | undefined): number {
  return (tab?.requestId ?? 0) + 1
}

function stillCurrent(
  tabs: Record<string, LocalPanelTabState>,
  tabId: string,
  requestId: number,
): boolean {
  const tab = tabs[tabId]
  return Boolean(tab && tab.requestId === requestId)
}

function pruneSelection(
  tab: LocalPanelTabState,
  available: Set<string>,
): Pick<LocalPanelTabState, 'selectedPath' | 'selectedPaths'> {
  const selectedPaths = tab.selectedPaths.filter((path) => available.has(path))
  const selectedPath =
    tab.selectedPath && available.has(tab.selectedPath)
      ? tab.selectedPath
      : (selectedPaths[selectedPaths.length - 1] ?? null)
  return { selectedPath, selectedPaths }
}

export const useLocalPanelStore = create<LocalPanelStoreState>((set, get) => ({
  tabs: {},

  ensure: async (tabId) => {
    const existing = get().tabs[tabId]
    if (existing && existing.status !== 'idle') return

    const bridge = window.termforge
    if (!bridge) {
      applyFailure(set, tabId, unavailableError('未加载 Electron preload bridge，无法浏览本地文件。'))
      return
    }

    const requestId = nextRequestId(existing)
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...(state.tabs[tabId] ?? emptyTab(tabId)),
          status: 'loading',
          error: null,
          errorCode: null,
          requestId,
        },
      },
    }))

    try {
      const result = await bridge.localFs.roots()
      if (!stillCurrent(get().tabs, tabId, requestId)) return
      if (!result.ok) {
        applyFailure(set, tabId, result.error)
        return
      }
      const { home, roots } = result.value
      set((state) => {
        const tab = state.tabs[tabId]
        if (!tab || tab.requestId !== requestId) return state
        return { tabs: { ...state.tabs, [tabId]: { ...tab, home, roots } } }
      })
      if (!home) {
        await get().load(tabId, '')
        return
      }
      await get().load(tabId, home)
    } catch {
      if (!stillCurrent(get().tabs, tabId, requestId)) return
      applyFailure(set, tabId, {
        code: 'internal',
        message: '读取本地文件系统根目录失败，请稍后重试。',
      })
    }
  },

  load: async (tabId, rawPath, options) => {
    const bridge = window.termforge
    if (!bridge) {
      applyFailure(set, tabId, unavailableError('未加载 Electron preload bridge，无法浏览本地文件。'))
      return false
    }

    if (rawPath === '') {
      const current = get().tabs[tabId]
      const requestId = nextRequestId(current)
      set((state) => {
        const tab = state.tabs[tabId] ?? emptyTab(tabId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              path: '',
              parentPath: null,
              entries: [],
              truncated: false,
              selectedPath: null,
              selectedPaths: [],
              status: 'loading',
              error: null,
              errorCode: null,
              requestId,
            },
          },
        }
      })
      try {
        const result = await bridge.localFs.roots()
        if (!stillCurrent(get().tabs, tabId, requestId)) return false
        if (!result.ok) {
          applyFailure(set, tabId, result.error)
          return false
        }
        const { home, roots } = result.value
        set((state) => {
          const tab = state.tabs[tabId]
          if (!tab || tab.requestId !== requestId) return state
          return { tabs: { ...state.tabs, [tabId]: { ...tab, home, roots, status: 'ready' } } }
        })
        return true
      } catch {
        if (!stillCurrent(get().tabs, tabId, requestId)) return false
        applyFailure(set, tabId, {
          code: 'internal',
          message: '读取本地文件系统根目录失败，请稍后重试。',
        })
        return false
      }
    }

    const pathError = getLocalPathError(rawPath)
    if (pathError) {
      applyFailure(set, tabId, { code: 'invalid-input', message: pathError })
      return false
    }

    const path = normalizeLocalPath(rawPath)
    const current = get().tabs[tabId]
    const samePath = current?.path === path
    const preserveEntries = Boolean(options?.preserveEntries && samePath)
    const requestId = nextRequestId(current)
    set((state) => {
      const tab = state.tabs[tabId] ?? emptyTab(tabId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            path,
            parentPath: preserveEntries ? tab.parentPath : null,
            entries: preserveEntries ? tab.entries : [],
            truncated: preserveEntries ? tab.truncated : false,
            selectedPath: preserveEntries ? tab.selectedPath : null,
            selectedPaths: preserveEntries ? tab.selectedPaths : [],
            status: 'loading',
            error: null,
            errorCode: null,
            requestId,
          },
        },
      }
    })

    try {
      const result = await bridge.localFs.list(path)
      if (!stillCurrent(get().tabs, tabId, requestId)) return false
      if (!result.ok) {
        applyFailure(set, tabId, result.error)
        return false
      }

      const listing: LocalDirectoryListing = result.value
      if (listing.path !== path) {
        applyFailure(set, tabId, {
          code: 'internal',
          message: '主进程返回的目录与请求不匹配，已丢弃该结果。',
        })
        return false
      }

      set((state) => {
        const tab = state.tabs[tabId]
        if (!tab || tab.requestId !== requestId) return state
        const available = new Set(listing.entries.map((entry) => entry.path))
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              path: listing.path,
              parentPath: listing.parentPath,
              entries: listing.entries,
              truncated: listing.truncated,
              status: 'ready',
              error: null,
              errorCode: null,
              ...pruneSelection(tab, available),
            },
          },
        }
      })
      return true
    } catch {
      if (!stillCurrent(get().tabs, tabId, requestId)) return false
      applyFailure(set, tabId, {
        code: 'internal',
        message: '读取本地目录失败，请稍后重试。',
      })
      return false
    }
  },

  refresh: async (tabId) => {
    const tab = get().tabs[tabId]
    if (!tab || tab.status === 'idle' || tab.status === 'loading') return false
    if (tab.path === '') {
      const refreshed = await get().load(tabId, '')
      if (!refreshed) return false
      const home = get().tabs[tabId]?.home
      if (!home) return true
      return get().load(tabId, home)
    }
    return get().load(tabId, tab.path, { preserveEntries: true })
  },

  setSort: (tabId, field) =>
    set((state) => {
      const tab = state.tabs[tabId]
      if (!tab) return state
      const sameField = tab.sortField === field
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            sortField: field,
            sortDirection: sameField && tab.sortDirection === 'asc' ? 'desc' : 'asc',
          },
        },
      }
    }),

  toggleHidden: (tabId) =>
    set((state) => {
      const tab = state.tabs[tabId]
      if (!tab) return state
      return {
        tabs: { ...state.tabs, [tabId]: { ...tab, showHidden: !tab.showHidden } },
      }
    }),

  setSelection: (tabId, paths, anchor) =>
    set((state) => {
      const tab = state.tabs[tabId]
      if (!tab) return state
      const unique = [...new Set(paths)]
      const selectedPath =
        anchor && unique.includes(anchor) ? anchor : (unique[unique.length - 1] ?? null)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, selectedPath, selectedPaths: unique },
        },
      }
    }),

  forgetTab: (tabId) =>
    set((state) => {
      if (!(tabId in state.tabs)) return state
      const tabs = { ...state.tabs }
      delete tabs[tabId]
      return { tabs }
    }),

  reset: () => set({ tabs: {} }),
}))

function applyFailure(
  set: (
    partial:
      | Partial<LocalPanelStoreState>
      | ((state: LocalPanelStoreState) => Partial<LocalPanelStoreState>),
  ) => void,
  tabId: string,
  error: OperationError,
): void {
  set((state) => {
    const tab = state.tabs[tabId] ?? emptyTab(tabId)
    return {
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...tab,
          status: 'error',
          error: error.message,
          errorCode: error.code,
          requestId: nextRequestId(tab),
        },
      },
    }
  })
}