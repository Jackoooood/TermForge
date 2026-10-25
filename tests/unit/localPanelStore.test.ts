import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LocalDirectoryListing,
  LocalFileEntry,
  LocalRootEntry,
  OperationResult,
} from '@shared/types'
import { useLocalPanelStore } from '@renderer/stores/localPanelStore'
import { createFakeBridge } from './helpers/fakeBridge'

const TAB = 'sshtab-1'
const HOME = 'C:\\Users\\test'
const ROOTS: LocalRootEntry[] = [{ name: '主目录', path: HOME, kind: 'home' }]

function entry(name: string, kind: LocalFileEntry['kind'] = 'file'): LocalFileEntry {
  return {
    id: `${HOME}\\${name}`,
    name,
    path: `${HOME}\\${name}`,
    kind,
    sizeBytes: kind === 'file' ? 10 : null,
    modifiedAt: '2026-10-22T08:00:00.000Z',
    hidden: name.startsWith('.'),
  }
}

function listing(
  path: string,
  entries: LocalFileEntry[] = [],
  parentPath: string | null = 'C:\\Users',
): OperationResult<LocalDirectoryListing> {
  return {
    ok: true,
    value: { path, parentPath, entries, truncated: false, loadedAt: '2026-10-22T08:00:00.000Z' },
  }
}

function rootsResult(home = HOME, roots = ROOTS): OperationResult<{ home: string; roots: LocalRootEntry[] }> {
  return { ok: true, value: { home, roots } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn
  })
  return { promise, resolve }
}

function setupBridge(localFs: Parameters<typeof createFakeBridge>[9] = {}) {
  const bridge = createFakeBridge({}, {}, {}, {}, {}, {}, {}, {}, {}, localFs)
  window.termforge = bridge
  return bridge
}

describe('localPanelStore', () => {
  beforeEach(() => {
    useLocalPanelStore.getState().reset()
  })

  afterEach(() => {
    useLocalPanelStore.getState().reset()
    delete window.termforge
  })

  it('enters the home directory on first ensure', async () => {
    setupBridge({
      roots: async () => rootsResult(),
      list: async (path) => listing(path, [entry('docs', 'directory'), entry('notes.txt')]),
    })

    await useLocalPanelStore.getState().ensure(TAB)
    const tab = useLocalPanelStore.getState().tabs[TAB]

    expect(tab).toMatchObject({
      path: HOME,
      home: HOME,
      parentPath: 'C:\\Users',
      status: 'ready',
      truncated: false,
      error: null,
    })
    expect(tab?.entries.map((item) => item.name)).toEqual(['docs', 'notes.txt'])
    expect(tab?.roots).toEqual(ROOTS)
  })

  it('treats an empty path as the roots view and refresh re-enters home', async () => {
    setupBridge({
      roots: async () => rootsResult(),
      list: async (path) => listing(path, [entry('notes.txt')]),
    })
    const store = useLocalPanelStore.getState()

    await store.ensure(TAB)
    await store.load(TAB, '')
    let tab = useLocalPanelStore.getState().tabs[TAB]
    expect(tab).toMatchObject({ path: '', parentPath: null, status: 'ready' })
    expect(tab?.entries).toEqual([])
    expect(tab?.roots).toEqual(ROOTS)

    await useLocalPanelStore.getState().refresh(TAB)
    tab = useLocalPanelStore.getState().tabs[TAB]
    expect(tab?.path).toBe(HOME)
    expect(tab?.entries.map((item) => item.name)).toEqual(['notes.txt'])
  })

  it('drops stale listings that resolve after a newer navigation', async () => {
    const stale = deferred<OperationResult<LocalDirectoryListing>>()
    setupBridge({
      roots: async () => rootsResult(),
      list: (path: string) =>
        path === 'C:\\Users\\old'
          ? stale.promise
          : Promise.resolve(listing(path, [entry('fresh.txt')])),
    })
    const store = useLocalPanelStore.getState()

    const pending = store.load(TAB, 'C:\\Users\\old')
    await store.load(TAB, 'C:\\Users\\new')
    stale.resolve(listing('C:\\Users\\old', [entry('stale.txt')]))
    await pending

    const tab = useLocalPanelStore.getState().tabs[TAB]
    expect(tab?.path).toBe('C:\\Users\\new')
    expect(tab?.entries.map((item) => item.name)).toEqual(['fresh.txt'])
  })

  it('records invalid paths without touching the bridge', async () => {
    const list = vi.fn(async (path: string) => listing(path))
    setupBridge({ list })
    const store = useLocalPanelStore.getState()

    const ok = await store.load(TAB, '\\\\?\\C:\\device')
    expect(ok).toBe(false)
    const tab = useLocalPanelStore.getState().tabs[TAB]
    expect(tab).toMatchObject({ status: 'error', errorCode: 'invalid-input' })
    expect(list).not.toHaveBeenCalled()
  })

  it('reports a missing bridge as unavailable instead of pretending to browse', async () => {
    const store = useLocalPanelStore.getState()
    const ok = await store.load(TAB, HOME)
    expect(ok).toBe(false)
    const tab = useLocalPanelStore.getState().tabs[TAB]
    expect(tab).toMatchObject({ status: 'error', errorCode: 'unavailable' })
  })

  it('toggles sort direction per field and hidden-file visibility per tab', async () => {
    setupBridge()
    const store = useLocalPanelStore.getState()
    await store.load(TAB, HOME)

    store.setSort(TAB, 'name')
    let tab = useLocalPanelStore.getState().tabs[TAB]
    expect(tab).toMatchObject({ sortField: 'name', sortDirection: 'desc' })

    store.setSort(TAB, 'size')
    tab = useLocalPanelStore.getState().tabs[TAB]
    expect(tab).toMatchObject({ sortField: 'size', sortDirection: 'asc' })

    store.toggleHidden(TAB)
    expect(useLocalPanelStore.getState().tabs[TAB]?.showHidden).toBe(true)
    store.toggleHidden(TAB)
    expect(useLocalPanelStore.getState().tabs[TAB]?.showHidden).toBe(false)
  })

  it('dedupes selections and clamps the anchor to the surviving entries', async () => {
    setupBridge()
    const store = useLocalPanelStore.getState()
    await store.load(TAB, HOME)

    store.setSelection(TAB, ['a', 'a', 'b'], 'missing')
    let tab = useLocalPanelStore.getState().tabs[TAB]
    expect(tab?.selectedPaths).toEqual(['a', 'b'])
    expect(tab?.selectedPath).toBe('b')

    store.setSelection(TAB, ['x'], null)
    tab = useLocalPanelStore.getState().tabs[TAB]
    expect(tab?.selectedPath).toBe('x')
  })
})