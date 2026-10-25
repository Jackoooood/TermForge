export const SPLIT_PANE_IDS = ['pane-a', 'pane-b'] as const

export type SplitPaneId = (typeof SPLIT_PANE_IDS)[number]
export type SplitDirection = 'row' | 'column'

export const SPLIT_RATIO_MIN = 0.2
export const SPLIT_RATIO_MAX = 0.8
export const SPLIT_RATIO_DEFAULT = 0.5

export interface SplitPane {
  id: SplitPaneId
  tabId: string | null
}

export interface TerminalSplitLayout {
  enabled: boolean
  direction: SplitDirection
  ratio: number
  focusedPaneId: SplitPaneId
  panes: Record<SplitPaneId, SplitPane>
}

export function createSplitPanes(): Record<SplitPaneId, SplitPane> {
  return {
    'pane-a': { id: 'pane-a', tabId: null },
    'pane-b': { id: 'pane-b', tabId: null },
  }
}

export function createSplitLayout(): TerminalSplitLayout {
  return {
    enabled: false,
    direction: 'row',
    ratio: SPLIT_RATIO_DEFAULT,
    focusedPaneId: 'pane-a',
    panes: createSplitPanes(),
  }
}

export function otherPaneId(paneId: SplitPaneId): SplitPaneId {
  return paneId === 'pane-a' ? 'pane-b' : 'pane-a'
}

export function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_RATIO_DEFAULT
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, value))
}

export function paneIdForTab(layout: TerminalSplitLayout, tabId: string): SplitPaneId | null {
  for (const paneId of SPLIT_PANE_IDS) {
    if (layout.panes[paneId].tabId === tabId) return paneId
  }
  return null
}

export function visiblePaneEntries(
  layout: TerminalSplitLayout,
): Array<{ paneId: SplitPaneId; tabId: string | null }> {
  return SPLIT_PANE_IDS.map((paneId) => ({
    paneId,
    tabId: layout.panes[paneId].tabId,
  }))
}
