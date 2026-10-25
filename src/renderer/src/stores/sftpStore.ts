import { create } from 'zustand'
import type {
  OperationError,
  OperationErrorCode,
  OperationResult,
  RemoteFileEntry,
  SftpBridge,
  SftpMutationAck,
} from '@shared/types'
import { normalizeRemotePath, sortRemoteEntries } from '@shared/sftp/remotePath'
import type { RemoteSortDirection, RemoteSortField, RemoteSortState } from '@shared/sftp/remotePath'

export type SftpViewStatus = 'idle' | 'opening' | 'loading' | 'ready' | 'error' | 'disconnected'

export type SftpOperationKind = 'mkdir' | 'rename' | 'delete'

export interface SftpOperationState {
  kind: SftpOperationKind
  path: string
  status: 'running' | 'error'
  error: string | null
  errorCode: OperationErrorCode | null
}

export interface SftpTreeListing {
  status: 'loading' | 'ready' | 'error'
  directories: RemoteFileEntry[]
  error: string | null
  errorCode: OperationErrorCode | null
  loadedAt: string | null
  requestId: number
}

export interface SftpTreeState {
  expandedPaths: string[]
  listings: Record<string, SftpTreeListing>
}

export interface SftpTabState {
  tabId: string
  sessionId: string | null
  homePath: string | null
  path: string
  entries: RemoteFileEntry[]
  status: SftpViewStatus
  error: string | null
  errorCode: OperationErrorCode | null
  /** Anchor entry used for rename/delete and Shift range selection. */
  selectedPath: string | null
  /** Multi-selection used for batch download. */
  selectedPaths: string[]
  operation: SftpOperationState | null
  /** Monotonic guard; late responses from older paths/sessions are dropped. */
  requestId: number
  tree: SftpTreeState
  sort: RemoteSortState
}

interface LoadOptions {
  preserveEntries?: boolean
}

interface SftpStoreState {
  activeTabId: string | null
  tabs: Record<string, SftpTabState>
  setActiveTab: (tabId: string | null) => void
  open: (tabId: string, sessionId: string) => Promise<void>
  load: (tabId: string, sessionId: string, path: string, options?: LoadOptions) => Promise<boolean>
  refresh: (tabId: string) => Promise<boolean>
  retry: (tabId: string, sessionId: string) => Promise<void>
  select: (tabId: string, path: string | null) => void
  setSelection: (tabId: string, paths: string[], anchor: string | null) => void
  setSort: (tabId: string, field: RemoteSortField, direction?: RemoteSortDirection) => void
  setTreeExpanded: (tabId: string, path: string, expanded: boolean) => void
  loadTreeDirectory: (
    tabId: string,
    sessionId: string,
    path: string,
    options?: { force?: boolean },
  ) => Promise<void>
  refreshTree: (tabId: string, sessionId: string) => Promise<void>
  mkdir: (
    tabId: string,
    sessionId: string,
    parentPath: string,
    name: string,
  ) => Promise<OperationResult<SftpMutationAck>>
  renamePath: (
    tabId: string,
    sessionId: string,
    sourcePath: string,
    targetPath: string,
  ) => Promise<OperationResult<SftpMutationAck>>
  deleteEntry: (
    tabId: string,
    sessionId: string,
    entry: RemoteFileEntry,
  ) => Promise<OperationResult<SftpMutationAck>>
  clearOperation: (tabId: string) => void
  forgetTab: (tabId: string) => void
  reset: () => void
}

type SetSftpState = (
  partial:
    Partial<SftpStoreState> | ((state: SftpStoreState) => Partial<SftpStoreState> | SftpStoreState),
) => void

function emptyTree(): SftpTreeState {
  return { expandedPaths: [], listings: {} }
}

function emptyTab(tabId: string, sessionId: string | null): SftpTabState {
  return {
    tabId,
    sessionId,
    homePath: null,
    path: '',
    entries: [],
    status: sessionId ? 'opening' : 'idle',
    error: null,
    errorCode: null,
    selectedPath: null,
    selectedPaths: [],
    operation: null,
    requestId: 0,
    tree: emptyTree(),
    sort: { field: 'name', direction: 'asc' },
  }
}

function unavailableError(message: string): OperationError {
  return { code: 'unavailable', message }
}

function nextRequestId(tab: SftpTabState | undefined): number {
  return (tab?.requestId ?? 0) + 1
}

function stillCurrent(
  state: SftpStoreState,
  tabId: string,
  sessionId: string,
  requestId: number,
): boolean {
  const tab = state.tabs[tabId]
  return Boolean(tab && tab.sessionId === sessionId && tab.requestId === requestId)
}

let treeRequestIdSequence = 1

export const useSftpStore = create<SftpStoreState>((set, get) => ({
  activeTabId: null,
  tabs: {},

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  open: async (tabId, sessionId) => {
    const current = get().tabs[tabId]
    if (
      current?.sessionId === sessionId &&
      (current.status === 'opening' || current.status === 'loading' || current.status === 'ready')
    ) {
      return
    }

    const bridge = window.termforge
    if (!bridge) {
      set((state) => {
        const tab = state.tabs[tabId] ?? emptyTab(tabId, sessionId)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              sessionId,
              status: 'error',
              error: '未加载 Electron preload bridge，无法使用真实 SFTP。',
              errorCode: 'unavailable',
              requestId: nextRequestId(tab),
            },
          },
        }
      })
      return
    }

    const sameSession = current?.sessionId === sessionId
    const requestId = nextRequestId(current)
    set((state) => {
      const base = state.tabs[tabId] ?? emptyTab(tabId, sessionId)
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...base,
            sessionId,
            homePath: sameSession ? base.homePath : null,
            path: sameSession ? base.path : '',
            entries: sameSession ? base.entries : [],
            selectedPath: sameSession ? base.selectedPath : null,
            selectedPaths: sameSession ? base.selectedPaths : [],
            tree: sameSession ? base.tree : emptyTree(),
            status: 'opening',
            error: null,
            errorCode: null,
            requestId,
          },
        },
      }
    })

    try {
      const result = await bridge.sftp.open(sessionId)
      if (!stillCurrent(get(), tabId, sessionId, requestId)) return
      if (!result.ok) {
        applyFailure(set, tabId, sessionId, result.error)
        return
      }

      const { homePath } = result.value
      set((state) => {
        const tab = state.tabs[tabId]
        if (!tab || tab.sessionId !== sessionId) return state
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              homePath,
              status: 'loading',
              error: null,
              errorCode: null,
              requestId: tab.requestId + 1,
            },
          },
        }
      })
      await get().load(tabId, sessionId, homePath)
    } catch {
      if (get().tabs[tabId]?.sessionId !== sessionId) return
      applyFailure(set, tabId, sessionId, {
        code: 'internal',
        message: 'SFTP 打开请求失败，请稍后重试。',
      })
    }
  },

  load: async (tabId, sessionId, rawPath, options) => {
    const bridge = window.termforge
    let path: string
    try {
      path = normalizeRemotePath(rawPath)
    } catch {
      applyFailure(set, tabId, sessionId, {
        code: 'invalid-input',
        message: '远程路径格式无效。',
      })
      return false
    }

    if (!bridge) {
      applyFailure(
        set,
        tabId,
        sessionId,
        unavailableError('未加载 Electron preload bridge，无法读取远程目录。'),
      )
      return false
    }

    const current = get().tabs[tabId]
    if (current?.sessionId !== sessionId) {
      // A response from a superseded SSH session must never seed the new one.
      applyFailure(set, tabId, sessionId, {
        code: 'unavailable',
        message: 'SFTP 会话尚未打开，请重新打开后再试。',
      })
      return false
    }

    const samePath = current.path === path
    const preserveEntries = Boolean(options?.preserveEntries && samePath)
    const requestId = nextRequestId(current)
    set((state) => {
      const tab = state.tabs[tabId]
      if (!tab || tab.sessionId !== sessionId) return state
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            path,
            entries: preserveEntries ? tab.entries : [],
            selectedPath: preserveEntries ? tab.selectedPath : null,
            selectedPaths: preserveEntries ? tab.selectedPaths : [],
            status: 'loading',
            error: null,
            errorCode: null,
            operation: null,
            requestId,
          },
        },
      }
    })

    try {
      const result = await bridge.sftp.list(sessionId, path)
      if (!stillCurrent(get(), tabId, sessionId, requestId)) return false
      if (!result.ok) {
        applyFailure(set, tabId, sessionId, result.error)
        return false
      }

      const listing = result.value
      if (listing.sessionId !== sessionId || listing.path !== path) {
        applyFailure(set, tabId, sessionId, {
          code: 'internal',
          message: '主进程返回的目录与请求不匹配，已丢弃该结果。',
        })
        return false
      }

      set((state) => {
        const tab = state.tabs[tabId]
        if (!tab || tab.sessionId !== sessionId || tab.requestId !== requestId) return state
        const available = new Set(listing.entries.map((entry) => entry.path))
        const selectedPaths = tab.selectedPaths.filter((path) => available.has(path))
        const selectedPath =
          tab.selectedPath && available.has(tab.selectedPath)
            ? tab.selectedPath
            : (selectedPaths[selectedPaths.length - 1] ?? null)
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...tab,
              path: listing.path,
              entries: listing.entries,
              status: 'ready',
              error: null,
              errorCode: null,
              selectedPath,
              selectedPaths,
            },
          },
        }
      })
      return true
    } catch {
      if (!stillCurrent(get(), tabId, sessionId, requestId)) return false
      applyFailure(set, tabId, sessionId, {
        code: 'internal',
        message: '读取远程目录失败，请稍后重试。',
      })
      return false
    }
  },

  refresh: async (tabId) => {
    const tab = get().tabs[tabId]
    if (!tab?.sessionId || !tab.path) return false
    return get().load(tabId, tab.sessionId, tab.path, { preserveEntries: true })
  },

  retry: async (tabId, sessionId) => {
    const tab = get().tabs[tabId]
    if (tab?.sessionId === sessionId && tab.path) {
      await get().load(tabId, sessionId, tab.path, {
        preserveEntries: tab.entries.length > 0,
      })
      return
    }
    await get().open(tabId, sessionId)
  },

  select: (tabId, path) =>
    set((state) => {
      const tab = state.tabs[tabId]
      if (!tab) return state
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, selectedPath: path, selectedPaths: path ? [path] : [] },
        },
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

  setSort: (tabId, field, direction) =>
    set((state) => {
      const tab = state.tabs[tabId]
      if (!tab) return state
      const nextDirection =
        direction ??
        (tab.sort.field === field ? (tab.sort.direction === 'asc' ? 'desc' : 'asc') : 'asc')
      if (tab.sort.field === field && tab.sort.direction === nextDirection) return state
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...tab, sort: { field, direction: nextDirection } },
        },
      }
    }),

  setTreeExpanded: (tabId, rawPath, expanded) =>
    set((state) => {
      const tab = state.tabs[tabId]
      if (!tab) return state
      let path: string
      try {
        path = normalizeRemotePath(rawPath)
      } catch {
        return state
      }
      const hasPath = tab.tree.expandedPaths.includes(path)
      if (expanded === hasPath) return state
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            tree: {
              ...tab.tree,
              expandedPaths: expanded
                ? [...tab.tree.expandedPaths, path]
                : tab.tree.expandedPaths.filter((candidate) => candidate !== path),
            },
          },
        },
      }
    }),

  loadTreeDirectory: async (tabId, sessionId, rawPath, options) => {
    let path: string
    try {
      path = normalizeRemotePath(rawPath)
    } catch {
      return
    }

    const tab = get().tabs[tabId]
    if (!tab || tab.sessionId !== sessionId) return
    const existing = tab.tree.listings[path]
    if (!options?.force && (existing?.status === 'loading' || existing?.status === 'ready')) {
      return
    }

    const requestId = treeRequestIdSequence++
    set((state) => {
      const current = state.tabs[tabId]
      if (!current || current.sessionId !== sessionId) return state
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...current,
            tree: {
              ...current.tree,
              listings: {
                ...current.tree.listings,
                [path]: {
                  status: 'loading',
                  directories: existing?.directories ?? [],
                  error: null,
                  errorCode: null,
                  loadedAt: existing?.loadedAt ?? null,
                  requestId,
                },
              },
            },
          },
        },
      }
    })

    const applyTreeFailure = (code: OperationErrorCode, message: string): void => {
      set((state) => {
        const current = state.tabs[tabId]
        if (
          !current ||
          current.sessionId !== sessionId ||
          current.tree.listings[path]?.requestId !== requestId
        ) {
          return state
        }
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...current,
              tree: {
                ...current.tree,
                listings: {
                  ...current.tree.listings,
                  [path]: {
                    status: 'error',
                    directories: existing?.directories ?? [],
                    error: message,
                    errorCode: code,
                    loadedAt: existing?.loadedAt ?? null,
                    requestId,
                  },
                },
              },
            },
          },
        }
      })
    }

    const bridge = window.termforge
    if (!bridge) {
      applyTreeFailure('unavailable', '未加载 Electron preload bridge，无法读取远程目录。')
      return
    }

    try {
      const result = await bridge.sftp.list(sessionId, path)
      const current = get().tabs[tabId]
      if (
        !current ||
        current.sessionId !== sessionId ||
        current.tree.listings[path]?.requestId !== requestId
      ) {
        return
      }
      if (!result.ok) {
        applyTreeFailure(result.error.code, result.error.message)
        return
      }
      const listing = result.value
      if (listing.sessionId !== sessionId || listing.path !== path) {
        applyTreeFailure('internal', '主进程返回的目录与树节点不匹配，已丢弃该结果。')
        return
      }
      set((state) => {
        const latest = state.tabs[tabId]
        if (
          !latest ||
          latest.sessionId !== sessionId ||
          latest.tree.listings[path]?.requestId !== requestId
        ) {
          return state
        }
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...latest,
              tree: {
                ...latest.tree,
                listings: {
                  ...latest.tree.listings,
                  [path]: {
                    status: 'ready',
                    directories: sortRemoteEntries(
                      listing.entries.filter((entry) => entry.kind === 'directory'),
                    ),
                    error: null,
                    errorCode: null,
                    loadedAt: listing.loadedAt,
                    requestId,
                  },
                },
              },
            },
          },
        }
      })
    } catch {
      applyTreeFailure('internal', '读取远程目录树失败，请稍后重试。')
    }
  },

  refreshTree: async (tabId, sessionId) => {
    const tab = get().tabs[tabId]
    if (!tab || tab.sessionId !== sessionId) return
    const paths = new Set(tab.tree.expandedPaths)
    if (tab.path) paths.add(tab.path)
    for (const path of paths) {
      if (get().tabs[tabId]?.sessionId !== sessionId) return
      await get().loadTreeDirectory(tabId, sessionId, path, { force: true })
    }
  },

  mkdir: (tabId, sessionId, parentPath, name) =>
    performMutation(get, set, tabId, sessionId, 'mkdir', parentPath, (sftp) =>
      sftp.mkdir(sessionId, parentPath, name),
    ),

  renamePath: (tabId, sessionId, sourcePath, targetPath) =>
    performMutation(get, set, tabId, sessionId, 'rename', sourcePath, (sftp) =>
      sftp.rename(sessionId, sourcePath, targetPath),
    ),

  deleteEntry: (tabId, sessionId, entry) =>
    performMutation(get, set, tabId, sessionId, 'delete', entry.path, (sftp) =>
      entry.kind === 'directory'
        ? sftp.removeDirectory(sessionId, entry.path)
        : sftp.deleteFile(sessionId, entry.path),
    ),

  clearOperation: (tabId) =>
    set((state) => {
      const tab = state.tabs[tabId]
      if (!tab?.operation) return state
      return { tabs: { ...state.tabs, [tabId]: { ...tab, operation: null } } }
    }),

  forgetTab: (tabId) =>
    set((state) => {
      if (!(tabId in state.tabs) && state.activeTabId !== tabId) return state
      const tabs = { ...state.tabs }
      delete tabs[tabId]
      return {
        tabs,
        activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
      }
    }),

  reset: () => set({ activeTabId: null, tabs: {} }),
}))

function applyFailure(
  set: SetSftpState,
  tabId: string,
  sessionId: string,
  error: OperationError,
): void {
  set((state) => {
    const tab = state.tabs[tabId] ?? emptyTab(tabId, sessionId)
    if (tab.sessionId !== sessionId && tab.sessionId !== null) return state
    const disconnected = error.code === 'unavailable'
    return {
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...tab,
          sessionId,
          status: disconnected ? 'disconnected' : 'error',
          error: error.message,
          errorCode: error.code,
          requestId: nextRequestId(tab),
        },
      },
    }
  })
}

async function performMutation(
  get: () => SftpStoreState,
  set: SetSftpState,
  tabId: string,
  sessionId: string,
  kind: SftpOperationKind,
  path: string,
  run: (sftp: SftpBridge) => Promise<OperationResult<SftpMutationAck>>,
): Promise<OperationResult<SftpMutationAck>> {
  const fail = (code: OperationErrorCode, message: string): OperationResult<SftpMutationAck> => {
    const tab = get().tabs[tabId]
    if (tab?.sessionId === sessionId) {
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...state.tabs[tabId],
            operation: { kind, path, status: 'error', error: message, errorCode: code },
          },
        },
      }))
    }
    return { ok: false, error: { code, message } }
  }

  const tab = get().tabs[tabId]
  if (!tab || tab.sessionId !== sessionId) {
    return {
      ok: false,
      error: { code: 'unavailable', message: 'SFTP 会话与标签不匹配，操作已取消。' },
    }
  }
  if (tab.status !== 'ready') {
    return {
      ok: false,
      error: { code: 'conflict', message: '目录尚未就绪，操作已取消，请刷新后重试。' },
    }
  }
  const bridge = window.termforge
  if (!bridge) {
    return fail('unavailable', '未加载 Electron preload bridge，无法执行文件操作。')
  }

  set((state) => {
    const current = state.tabs[tabId]
    if (!current || current.sessionId !== sessionId) return state
    return {
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...current,
          operation: { kind, path, status: 'running', error: null, errorCode: null },
        },
      },
    }
  })

  let result: OperationResult<SftpMutationAck>
  try {
    result = await run(bridge.sftp)
  } catch {
    result = {
      ok: false,
      error: { code: 'internal', message: '文件操作请求失败，请稍后刷新目录确认。' },
    }
  }

  if (get().tabs[tabId]?.sessionId === sessionId) {
    set((state) => {
      const current = state.tabs[tabId]
      if (!current || current.sessionId !== sessionId) return state
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...current,
            operation: result.ok
              ? null
              : {
                  kind,
                  path,
                  status: 'error',
                  error: result.error.message,
                  errorCode: result.error.code,
                },
          },
        },
      }
    })
  }
  return result
}
