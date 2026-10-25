import { create } from 'zustand'
import {
  SPLIT_PANE_IDS,
  clampSplitRatio,
  createSplitLayout,
  createSplitPanes,
  otherPaneId,
  paneIdForTab,
} from '@renderer/features/terminal/splitLayout'
import type {
  SplitDirection,
  SplitPaneId,
  TerminalSplitLayout,
} from '@renderer/features/terminal/splitLayout'

export type WorkspaceModule = 'workbench' | 'servers' | 'sftp' | 'port-forwards' | 'settings'
export type PaletteMode = 'search' | 'commands'

export const SFTP_DOCK_MIN_WIDTH = 320
export const SFTP_DOCK_MAX_WIDTH = 640
export const SFTP_TREE_MIN_WIDTH = 140
export const SFTP_TREE_MAX_WIDTH = 280
export const SFTP_TREE_DEFAULT_WIDTH = 184

function clampWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

interface WorkspaceStoreState {
  activeModule: WorkspaceModule
  sidebarCollapsed: boolean
  paletteMode: PaletteMode | null
  /** Right-hand SFTP panel inside the workbench; runtime-only layout state. */
  sftpDockOpen: boolean
  /** null keeps the responsive CSS default until the user drags the divider. */
  sftpDockWidth: number | null
  sftpTreeWidth: number
  /** Ordered, stable workspace tab IDs; metadata lives in sessionStore. */
  tabOrder: string[]
  activeTabId: string | null
  /**
   * Runtime-only split state. It references tab IDs but never owns SSH
   * sessions, terminals or shells; layout changes never call the SSH bridge.
   */
  split: TerminalSplitLayout
  setActiveModule: (module: WorkspaceModule) => void
  toggleSidebar: () => void
  toggleSftpDock: () => void
  setSftpDockWidth: (width: number | null) => void
  setSftpTreeWidth: (width: number) => void
  openPalette: (mode: PaletteMode) => void
  closePalette: () => void
  addTab: (tabId: string) => void
  removeTab: (tabId: string) => void
  activateTab: (tabId: string) => void
  resetTabs: () => void
  enableSplit: (direction?: SplitDirection) => void
  disableSplit: () => void
  toggleSplit: (direction?: SplitDirection) => void
  setSplitDirection: (direction: SplitDirection) => void
  setSplitRatio: (ratio: number) => void
  focusPane: (paneId: SplitPaneId) => void
  assignPaneTab: (paneId: SplitPaneId, tabId: string | null) => void
}

function closedSplit(layout: TerminalSplitLayout): TerminalSplitLayout {
  return {
    ...layout,
    enabled: false,
    focusedPaneId: 'pane-a',
    panes: createSplitPanes(),
  }
}

function activeTabForPane(layout: TerminalSplitLayout, paneId: SplitPaneId): string | null {
  return layout.panes[paneId].tabId
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  activeModule: 'workbench',
  sidebarCollapsed: false,
  paletteMode: null,
  sftpDockOpen: true,
  sftpDockWidth: null,
  sftpTreeWidth: SFTP_TREE_DEFAULT_WIDTH,
  tabOrder: [],
  activeTabId: null,
  split: createSplitLayout(),

  setActiveModule: (activeModule) => set({ activeModule }),

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  toggleSftpDock: () => set((state) => ({ sftpDockOpen: !state.sftpDockOpen })),

  setSftpDockWidth: (width) =>
    set({
      sftpDockWidth:
        width === null ? null : clampWidth(width, SFTP_DOCK_MIN_WIDTH, SFTP_DOCK_MAX_WIDTH),
    }),

  setSftpTreeWidth: (width) =>
    set({
      sftpTreeWidth: clampWidth(width, SFTP_TREE_MIN_WIDTH, SFTP_TREE_MAX_WIDTH),
    }),

  openPalette: (paletteMode) => set({ paletteMode }),

  closePalette: () => set({ paletteMode: null }),

  addTab: (tabId) =>
    set((state) => {
      const tabOrder = state.tabOrder.includes(tabId) ? state.tabOrder : [...state.tabOrder, tabId]
      if (!state.split.enabled) return { tabOrder, activeTabId: tabId }

      const existing = paneIdForTab(state.split, tabId)
      if (existing) {
        return {
          tabOrder,
          activeTabId: tabId,
          split: { ...state.split, focusedPaneId: existing },
        }
      }
      const emptyPane = SPLIT_PANE_IDS.find((paneId) => state.split.panes[paneId].tabId === null)
      const target = emptyPane ?? state.split.focusedPaneId
      return {
        tabOrder,
        activeTabId: tabId,
        split: {
          ...state.split,
          focusedPaneId: target,
          panes: {
            ...state.split.panes,
            [target]: { id: target, tabId },
          },
        },
      }
    }),

  removeTab: (tabId) =>
    set((state) => {
      const index = state.tabOrder.indexOf(tabId)
      if (index === -1) return state
      const tabOrder = state.tabOrder.filter((id) => id !== tabId)
      const neighbour = tabOrder[Math.min(index, tabOrder.length - 1)] ?? null
      if (tabOrder.length === 0) {
        return {
          tabOrder,
          activeTabId: null,
          split: closedSplit(state.split),
        }
      }

      if (!state.split.enabled) {
        return {
          tabOrder,
          activeTabId: state.activeTabId === tabId ? neighbour : state.activeTabId,
        }
      }

      let panes = state.split.panes
      for (const paneId of SPLIT_PANE_IDS) {
        if (panes[paneId].tabId === tabId) {
          panes = { ...panes, [paneId]: { id: paneId, tabId: null } }
        }
      }
      const focusedTab = panes[state.split.focusedPaneId].tabId
      const otherTab = panes[otherPaneId(state.split.focusedPaneId)].tabId
      if (!focusedTab && !otherTab) {
        return {
          tabOrder,
          activeTabId: neighbour,
          split: closedSplit(state.split),
        }
      }
      const focusedPaneId = focusedTab
        ? state.split.focusedPaneId
        : otherPaneId(state.split.focusedPaneId)
      return {
        tabOrder,
        activeTabId: activeTabForPane({ ...state.split, panes }, focusedPaneId),
        split: { ...state.split, focusedPaneId, panes },
      }
    }),

  activateTab: (tabId) =>
    set((state) => {
      if (!state.tabOrder.includes(tabId)) return state
      if (!state.split.enabled) return { activeTabId: tabId }

      const existing = paneIdForTab(state.split, tabId)
      if (existing) {
        return {
          activeTabId: tabId,
          split: { ...state.split, focusedPaneId: existing },
        }
      }
      const emptyPane = SPLIT_PANE_IDS.find((paneId) => state.split.panes[paneId].tabId === null)
      const target = emptyPane ?? state.split.focusedPaneId
      return {
        activeTabId: tabId,
        split: {
          ...state.split,
          focusedPaneId: target,
          panes: {
            ...state.split.panes,
            [target]: { id: target, tabId },
          },
        },
      }
    }),

  resetTabs: () =>
    set({
      tabOrder: [],
      activeTabId: null,
      split: createSplitLayout(),
    }),

  enableSplit: (direction) =>
    set((state) => {
      const current =
        state.activeTabId && state.tabOrder.includes(state.activeTabId)
          ? state.activeTabId
          : (state.tabOrder[0] ?? null)
      if (!current) return state
      const secondary = state.tabOrder.find((tabId) => tabId !== current) ?? null
      return {
        activeTabId: current,
        split: {
          ...state.split,
          enabled: true,
          direction: direction ?? state.split.direction,
          focusedPaneId: 'pane-a',
          panes: {
            'pane-a': { id: 'pane-a', tabId: current },
            'pane-b': { id: 'pane-b', tabId: secondary },
          },
        },
      }
    }),

  disableSplit: () =>
    set((state) => {
      if (!state.split.enabled) return state
      const focusedTab = state.split.panes[state.split.focusedPaneId].tabId
      const otherTab = state.split.panes[otherPaneId(state.split.focusedPaneId)].tabId
      const activeTabId =
        focusedTab ??
        otherTab ??
        (state.activeTabId && state.tabOrder.includes(state.activeTabId)
          ? state.activeTabId
          : (state.tabOrder[0] ?? null))
      return {
        activeTabId,
        split: closedSplit(state.split),
      }
    }),

  toggleSplit: (direction) => {
    const state = get()
    if (state.split.enabled) state.disableSplit()
    else state.enableSplit(direction)
  },

  setSplitDirection: (direction) => set((state) => ({ split: { ...state.split, direction } })),

  setSplitRatio: (ratio) =>
    set((state) => ({ split: { ...state.split, ratio: clampSplitRatio(ratio) } })),

  focusPane: (paneId) =>
    set((state) => {
      if (!state.split.enabled) return state
      const tabId = state.split.panes[paneId].tabId
      if (!tabId) return state
      return {
        activeTabId: tabId,
        split: { ...state.split, focusedPaneId: paneId },
      }
    }),

  assignPaneTab: (paneId, tabId) =>
    set((state) => {
      if (!state.split.enabled) return state
      if (tabId !== null && !state.tabOrder.includes(tabId)) return state
      const otherId = otherPaneId(paneId)
      if (tabId !== null && state.split.panes[otherId].tabId === tabId) {
        return {
          activeTabId: tabId,
          split: { ...state.split, focusedPaneId: otherId },
        }
      }

      const panes = { ...state.split.panes, [paneId]: { id: paneId, tabId } }
      if (tabId === null) {
        if (!panes['pane-a'].tabId && !panes['pane-b'].tabId) {
          return {
            activeTabId: state.tabOrder[0] ?? null,
            split: closedSplit(state.split),
          }
        }
        const focusedId = state.split.focusedPaneId === paneId ? otherId : state.split.focusedPaneId
        return {
          activeTabId: panes[focusedId].tabId,
          split: { ...state.split, focusedPaneId: focusedId, panes },
        }
      }

      return {
        activeTabId: tabId,
        split: { ...state.split, focusedPaneId: paneId, panes },
      }
    }),
}))
