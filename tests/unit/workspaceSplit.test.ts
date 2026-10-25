import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  createSplitLayout,
  paneIdForTab,
} from '@renderer/features/terminal/splitLayout'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge } from './helpers/fakeBridge'

function workspace() {
  return useWorkspaceStore.getState()
}

function seedTabs(...tabIds: string[]): void {
  for (const tabId of tabIds) workspace().addTab(tabId)
}

describe('workspace split layout', () => {
  beforeEach(() => {
    workspace().resetTabs()
  })

  afterEach(() => {
    delete window.termforge
  })

  it('binds the active tab to pane A and another open tab to pane B', () => {
    seedTabs('tab-1', 'tab-2', 'tab-3')
    workspace().activateTab('tab-2')

    workspace().enableSplit('column')

    const { split, activeTabId } = workspace()
    expect(split.enabled).toBe(true)
    expect(split.direction).toBe('column')
    expect(split.ratio).toBe(0.5)
    expect(split.focusedPaneId).toBe('pane-a')
    expect(split.panes['pane-a'].tabId).toBe('tab-2')
    expect(split.panes['pane-b'].tabId).toBe('tab-1')
    expect(activeTabId).toBe('tab-2')
  })

  it('leaves an empty workspace unsplit and uses the first tab when nothing is active', () => {
    workspace().enableSplit()
    expect(workspace().split.enabled).toBe(false)

    seedTabs('tab-1')
    expect(workspace().activeTabId).toBe('tab-1')
    workspace().enableSplit('row')
    expect(workspace().split.panes['pane-a'].tabId).toBe('tab-1')
    expect(workspace().split.panes['pane-b'].tabId).toBeNull()
  })

  it('focuses an already bound tab instead of duplicating it across panes', () => {
    seedTabs('tab-1', 'tab-2')
    workspace().enableSplit()

    workspace().activateTab('tab-1')
    expect(workspace().split.focusedPaneId).toBe('pane-b')
    expect(workspace().activeTabId).toBe('tab-1')

    workspace().activateTab('tab-2')
    expect(workspace().split.focusedPaneId).toBe('pane-a')
    expect(workspace().activeTabId).toBe('tab-2')
    expect(paneIdForTab(workspace().split, 'tab-1')).toBe('pane-b')
    expect(paneIdForTab(workspace().split, 'tab-2')).toBe('pane-a')
  })

  it('fills an empty pane before replacing the focused pane', () => {
    seedTabs('tab-1', 'tab-2', 'tab-3', 'tab-4')
    workspace().enableSplit()
    workspace().assignPaneTab('pane-b', null)
    expect(workspace().split.focusedPaneId).toBe('pane-a')

    workspace().activateTab('tab-3')
    expect(workspace().split.panes['pane-b'].tabId).toBe('tab-3')
    expect(workspace().split.focusedPaneId).toBe('pane-b')
    expect(workspace().activeTabId).toBe('tab-3')

    workspace().activateTab('tab-2')
    expect(workspace().split.panes['pane-b'].tabId).toBe('tab-2')
    expect(paneIdForTab(workspace().split, 'tab-3')).toBeNull()
    expect(workspace().tabOrder).toEqual(['tab-1', 'tab-2', 'tab-3', 'tab-4'])
  })

  it('moves focus when assigning the tab already bound to the other pane', () => {
    seedTabs('tab-1', 'tab-2')
    workspace().enableSplit()

    workspace().assignPaneTab('pane-a', 'tab-1')

    expect(workspace().split.panes['pane-a'].tabId).toBe('tab-2')
    expect(workspace().split.panes['pane-b'].tabId).toBe('tab-1')
    expect(workspace().split.focusedPaneId).toBe('pane-b')
    expect(workspace().activeTabId).toBe('tab-1')
  })

  it('unbinds one pane without closing anything and exits split when both are empty', () => {
    seedTabs('tab-1', 'tab-2')
    workspace().enableSplit()

    workspace().assignPaneTab('pane-a', null)
    expect(workspace().split.enabled).toBe(true)
    expect(workspace().split.focusedPaneId).toBe('pane-b')
    expect(workspace().activeTabId).toBe('tab-1')
    expect(workspace().tabOrder).toEqual(['tab-1', 'tab-2'])

    workspace().assignPaneTab('pane-b', null)
    expect(workspace().split.enabled).toBe(false)
    expect(workspace().split.panes['pane-a'].tabId).toBeNull()
    expect(workspace().split.panes['pane-b'].tabId).toBeNull()
    expect(workspace().activeTabId).toBe('tab-1')
    expect(workspace().tabOrder).toEqual(['tab-1', 'tab-2'])
  })

  it('removes a bound tab from its pane only and keeps the remaining pane focused', () => {
    seedTabs('tab-1', 'tab-2')
    workspace().enableSplit()

    workspace().removeTab('tab-1')

    expect(workspace().tabOrder).toEqual(['tab-2'])
    expect(workspace().split.enabled).toBe(true)
    expect(workspace().split.panes['pane-a'].tabId).toBe('tab-2')
    expect(workspace().split.panes['pane-b'].tabId).toBeNull()
    expect(workspace().split.focusedPaneId).toBe('pane-a')
    expect(workspace().activeTabId).toBe('tab-2')
  })

  it('removes an unbound tab without disturbing pane bindings or focus', () => {
    seedTabs('tab-1', 'tab-2', 'tab-3')
    workspace().enableSplit()
    expect(workspace().split.focusedPaneId).toBe('pane-a')

    workspace().removeTab('tab-2')

    expect(workspace().tabOrder).toEqual(['tab-1', 'tab-3'])
    expect(workspace().split.enabled).toBe(true)
    expect(workspace().split.panes['pane-a'].tabId).toBe('tab-3')
    expect(workspace().split.panes['pane-b'].tabId).toBe('tab-1')
    expect(workspace().split.focusedPaneId).toBe('pane-a')
    expect(workspace().activeTabId).toBe('tab-3')
  })

  it('exits split when the workspace has no tabs left', () => {
    seedTabs('tab-1')
    workspace().enableSplit()
    workspace().removeTab('tab-1')

    expect(workspace().tabOrder).toEqual([])
    expect(workspace().activeTabId).toBeNull()
    expect(workspace().split).toEqual(createSplitLayout())
  })

  it('adds new tabs into the empty pane first and otherwise replaces the focused pane', () => {
    seedTabs('tab-1', 'tab-2')
    workspace().enableSplit()
    workspace().addTab('tab-3')
    expect(workspace().split.panes['pane-a'].tabId).toBe('tab-3')
    expect(workspace().split.panes['pane-b'].tabId).toBe('tab-1')
    expect(workspace().activeTabId).toBe('tab-3')

    workspace().assignPaneTab('pane-b', null)
    workspace().addTab('tab-4')
    expect(workspace().split.panes['pane-a'].tabId).toBe('tab-3')
    expect(workspace().split.panes['pane-b'].tabId).toBe('tab-4')
    expect(workspace().activeTabId).toBe('tab-4')
    expect(workspace().split.focusedPaneId).toBe('pane-b')
  })

  it('clamps the ratio and switches the split direction', () => {
    seedTabs('tab-1', 'tab-2')
    workspace().enableSplit()

    workspace().setSplitRatio(0.1)
    expect(workspace().split.ratio).toBe(SPLIT_RATIO_MIN)
    workspace().setSplitRatio(0.95)
    expect(workspace().split.ratio).toBe(SPLIT_RATIO_MAX)
    workspace().setSplitRatio(Number.NaN)
    expect(workspace().split.ratio).toBe(0.5)

    workspace().setSplitDirection('column')
    expect(workspace().split.direction).toBe('column')

    workspace().toggleSplit()
    expect(workspace().split.enabled).toBe(false)
    workspace().toggleSplit()
    expect(workspace().split.enabled).toBe(true)
    expect(workspace().split.direction).toBe('column')
  })

  it('keeps focus on a bound pane while split is enabled', () => {
    seedTabs('tab-1', 'tab-2', 'tab-3')
    workspace().enableSplit()
    workspace().focusPane('pane-b')
    expect(workspace().activeTabId).toBe('tab-1')

    workspace().focusPane('pane-b')
    expect(workspace().split.focusedPaneId).toBe('pane-b')
    expect(workspace().split.panes['pane-b'].tabId).toBe('tab-1')

    workspace().assignPaneTab('pane-b', null)
    expect(workspace().split.focusedPaneId).toBe('pane-a')
    expect(workspace().activeTabId).toBe('tab-3')
  })

  it('never calls the SSH bridge for layout operations', () => {
    const bridge = createFakeBridge()
    window.termforge = bridge
    const connect = vi.spyOn(bridge.ssh, 'connect')
    const disconnect = vi.spyOn(bridge.ssh, 'disconnect')

    seedTabs('tab-1', 'tab-2', 'tab-3')
    workspace().enableSplit('row')
    workspace().activateTab('tab-1')
    workspace().assignPaneTab('pane-b', 'tab-3')
    workspace().assignPaneTab('pane-b', null)
    workspace().focusPane('pane-a')
    workspace().setSplitDirection('column')
    workspace().setSplitRatio(0.6)
    workspace().removeTab('tab-2')
    workspace().disableSplit()

    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })
})
