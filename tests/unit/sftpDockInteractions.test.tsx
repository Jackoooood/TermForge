import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  OperationResult,
  RemoteDirectoryListing,
  RemoteFileEntry,
  RemoteTextFile,
  SftpMutationAck,
} from '@shared/types'
import { SftpDock } from '@renderer/features/workbench/SftpDock'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSftpStore } from '@renderer/stores/sftpStore'
import { useTextEditorStore } from '@renderer/stores/textEditorStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { createFakeBridge, fakeSessionInfo } from './helpers/fakeBridge'

const TAB_ID = 'sshtab-prod-web'
const SESSION_ID = 'ssh-prod-web'
const HOME = '/home/deploy'

function entry(
  directory: string,
  name: string,
  kind: RemoteFileEntry['kind'] = 'file',
  overrides: Partial<RemoteFileEntry> = {},
): RemoteFileEntry {
  return {
    id: `${directory}/${name}`,
    name,
    path: `${directory}/${name}`,
    kind,
    sizeBytes: kind === 'file' ? 100 : null,
    modifiedAt: '2026-10-22T08:00:00.000Z',
    permissions: kind === 'directory' ? 'drwxr-xr-x' : '-rw-r--r--',
    ...overrides,
  }
}

function listing(
  path: string,
  entries: RemoteFileEntry[],
): OperationResult<RemoteDirectoryListing> {
  return {
    ok: true,
    value: { sessionId: SESSION_ID, path, entries, loadedAt: '2026-10-22T08:00:00.000Z' },
  }
}

function resetFixtures(): void {
  useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
  useSftpStore.getState().reset()
  useTextEditorStore.getState().reset()
  useWorkspaceStore.setState({
    tabOrder: [],
    activeTabId: null,
    activeModule: 'workbench',
    sftpDockOpen: true,
    sftpDockWidth: null,
    sftpTreeWidth: 184,
  })
}

function seedSession(): void {
  const session = fakeSessionInfo({
    id: TAB_ID,
    sessionId: SESSION_ID,
    connectionName: 'prod-web-01',
    title: 'prod-web-01',
    username: 'deploy',
    status: 'connected',
  })
  useSessionStore.setState({ sessions: { [TAB_ID]: session } })
  useWorkspaceStore.getState().addTab(TAB_ID)
  useWorkspaceStore.getState().activateTab(TAB_ID)
}

function pathMap(
  entries: Record<string, RemoteFileEntry[]>,
): (sessionId: string, path: string) => Promise<OperationResult<RemoteDirectoryListing>> {
  return async (_sessionId, path) => listing(path, entries[path] ?? [])
}

function installBridge(
  entries: Record<string, RemoteFileEntry[]>,
  extraSftp: Record<string, unknown> = {},
): void {
  window.termforge = createFakeBridge(
    {},
    {},
    {},
    {
      list: pathMap(entries),
      ...extraSftp,
    },
  )
}

async function waitForTable(): Promise<HTMLElement> {
  return screen.findByRole('table', { name: '远程文件列表' })
}

function rowNames(table: HTMLElement): string[] {
  return Array.from(table.querySelectorAll('tbody tr')).map(
    (row) => row.querySelector('.sftp-dock__row-name')?.textContent ?? '',
  )
}

function dataRows(table: HTMLElement): HTMLElement[] {
  return Array.from(table.querySelectorAll<HTMLElement>('tbody tr'))
}

describe('SftpDock interactions', () => {
  beforeEach(() => {
    resetFixtures()
    seedSession()
  })

  afterEach(() => {
    useTextEditorStore.getState().reset()
    delete window.termforge
  })

  it('sorts by real size and modified columns while keeping directories first', async () => {
    installBridge({
      '/': [],
      '/home': [],
      [HOME]: [
        entry(HOME, 'logs', 'directory'),
        entry(HOME, 'small.txt', 'file', { sizeBytes: 100 }),
        entry(HOME, 'large.bin', 'file', { sizeBytes: 5000 }),
      ],
    })
    const user = userEvent.setup()
    render(<SftpDock />)
    const table = await waitForTable()

    await waitFor(() => expect(rowNames(table)).toEqual(['logs', 'large.bin', 'small.txt']))

    const sizeHeader = within(table).getByRole('columnheader', { name: /大小/ })
    await user.click(within(sizeHeader).getByRole('button'))
    await waitFor(() => expect(rowNames(table)).toEqual(['logs', 'small.txt', 'large.bin']))
    expect(sizeHeader).toHaveAttribute('aria-sort', 'ascending')

    await user.click(within(sizeHeader).getByRole('button'))
    await waitFor(() => expect(rowNames(table)).toEqual(['logs', 'large.bin', 'small.txt']))
    expect(sizeHeader).toHaveAttribute('aria-sort', 'descending')

    const modifiedHeader = within(table).getByRole('columnheader', { name: /修改时间/ })
    await user.click(within(modifiedHeader).getByRole('button'))
    expect(modifiedHeader).toHaveAttribute('aria-sort', 'ascending')
    expect(useSftpStore.getState().tabs[TAB_ID]?.sort).toEqual({
      field: 'modified',
      direction: 'asc',
    })
  })

  it('filters by name, reports no matches and clears the filter', async () => {
    installBridge({
      '/': [],
      '/home': [],
      [HOME]: [
        entry(HOME, 'alpha.txt'),
        entry(HOME, 'beta.txt'),
        entry(HOME, 'release notes.md'),
      ],
    })
    const user = userEvent.setup()
    render(<SftpDock />)
    const table = await waitForTable()
    const search = screen.getByRole('searchbox', { name: '筛选当前远程目录的文件名' })

    await user.type(search, 'ALPHA')
    await waitFor(() => expect(rowNames(table)).toEqual(['alpha.txt']))
    expect(screen.getByText(/筛选 1 \/ 3/)).toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'missing')
    expect(screen.queryByRole('table', { name: '远程文件列表' })).not.toBeInTheDocument()
    expect(screen.getByText('没有匹配的条目')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(screen.getByRole('searchbox')).toHaveValue('')
    const restoredTable = await waitForTable()
    await waitFor(() => expect(rowNames(restoredTable)).toHaveLength(3))
  })

  it('supports roving keyboard focus, Shift ranges and Ctrl+A selection', async () => {
    installBridge({
      '/': [],
      '/home': [],
      [HOME]: [entry(HOME, 'a.txt'), entry(HOME, 'b.txt'), entry(HOME, 'c.txt')],
    })
    const user = userEvent.setup()
    render(<SftpDock />)
    const table = await waitForTable()
    await waitFor(() => expect(rowNames(table)).toEqual(['a.txt', 'b.txt', 'c.txt']))
    const rows = dataRows(table)

    rows[0]!.focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(useSftpStore.getState().tabs[TAB_ID]?.selectedPaths).toEqual([
      `${HOME}/a.txt`,
      `${HOME}/b.txt`,
    ])
    expect(rows[0]).toHaveAttribute('aria-selected', 'true')
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowDown}')
    expect(useSftpStore.getState().tabs[TAB_ID]?.selectedPaths).toEqual([`${HOME}/c.txt`])

    await user.keyboard('{Control>}a{/Control}')
    expect(useSftpStore.getState().tabs[TAB_ID]?.selectedPaths).toEqual([
      `${HOME}/a.txt`,
      `${HOME}/b.txt`,
      `${HOME}/c.txt`,
    ])
  })

  it('opens directories with Enter and loads ancestors in the lazy tree', async () => {
    installBridge({
      '/': [entry('', 'home', 'directory')],
      '/home': [entry('/home', 'deploy', 'directory')],
      [HOME]: [entry(HOME, 'alpha.txt')],
      [`${HOME}/sub`]: [entry(`${HOME}/sub`, 'inside.txt')],
    })
    const user = userEvent.setup()
    render(<SftpDock />)
    const table = await waitForTable()
    await waitFor(() => expect(rowNames(table)).toEqual(['alpha.txt']))

    const tree = screen.getByRole('tree', { name: '远程目录树' })
    await waitFor(() => {
      expect(within(tree).getByRole('treeitem', { name: 'home' })).toBeInTheDocument()
      expect(within(tree).getByRole('treeitem', { name: 'deploy' })).toBeInTheDocument()
    })

    const homeItem = within(tree).getByRole('treeitem', { name: 'home' })
    homeItem.focus()
    await user.keyboard('{ArrowLeft}')
    expect(within(tree).queryByRole('treeitem', { name: 'deploy' })).not.toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(within(tree).getByRole('treeitem', { name: 'deploy' })).toBeInTheDocument()

    await user.click(within(tree).getByRole('treeitem', { name: 'home' }))
    const crumbs = screen.getByRole('navigation', { name: '远程路径' })
    await waitFor(() => expect(crumbs).toHaveTextContent('home'))
    await waitFor(() => {
      const homeTable = screen.getByRole('table', { name: '远程文件列表' })
      expect(rowNames(homeTable)).toEqual(['deploy'])
    })

    await user.click(within(tree).getByRole('treeitem', { name: 'deploy' }))
    await waitFor(() => {
      const homeTable = screen.getByRole('table', { name: '远程文件列表' })
      expect(rowNames(homeTable)).toEqual(['alpha.txt'])
    })
    expect(crumbs).toHaveTextContent('deploy')
  })

  it('exposes real rename and delete actions in the row context menu', async () => {
    const rename = vi.fn(
      async (sessionId: string, _sourcePath: string, targetPath: string) =>
        ({
          ok: true,
          value: { sessionId, path: targetPath, operation: 'rename' },
        }) as OperationResult<SftpMutationAck>,
    )
    const deleteFile = vi.fn(
      async (sessionId: string, path: string) =>
        ({
          ok: true,
          value: { sessionId, path, operation: 'delete-file' },
        }) as OperationResult<SftpMutationAck>,
    )
    installBridge(
      {
        '/': [],
        '/home': [],
        [HOME]: [entry(HOME, 'alpha.txt')],
      },
      { rename, deleteFile },
    )
    const user = userEvent.setup()
    render(<SftpDock />)
    const table = await waitForTable()
    const row = () => dataRows(table)[0]!

    fireEvent.contextMenu(row())
    expect(screen.getByRole('menuitem', { name: /重命名/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /下载此文件/ })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: /重命名/ }))

    const dialog = screen.getByRole('dialog', { name: '重命名远程条目' })
    const nameInput = within(dialog).getByLabelText(/新名称/)
    await user.clear(nameInput)
    await user.type(nameInput, 'renamed.txt')
    await user.click(within(dialog).getByRole('button', { name: '重命名' }))

    await waitFor(() =>
      expect(rename).toHaveBeenCalledWith(SESSION_ID, `${HOME}/alpha.txt`, `${HOME}/renamed.txt`),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.contextMenu(row())
    await user.click(screen.getByRole('menuitem', { name: /删除/ }))
    const deleteDialog = screen.getByRole('dialog', { name: '删除远程条目？' })
    await user.click(within(deleteDialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith(SESSION_ID, `${HOME}/alpha.txt`))
  })

  it('opens regular files in the built-in editor from double-click, Enter and the context menu', async () => {
    const readTextFile = vi.fn(
      async (sessionId: string, path: string) =>
        ({
          ok: true,
          value: {
            sessionId,
            path,
            content: 'server file\n',
            encoding: 'utf-8',
            eol: 'lf',
            revision: '1:12',
            sizeBytes: 12,
            modifiedAt: '2026-10-22T08:00:00.000Z',
            permissions: '-rw-r--r--',
          },
        }) as OperationResult<RemoteTextFile>,
    )
    installBridge(
      {
        '/': [],
        '/home': [],
        [HOME]: [entry(HOME, 'alpha.txt'), entry(HOME, 'current', 'symlink')],
      },
      { readTextFile },
    )
    const user = userEvent.setup()
    render(<SftpDock />)
    const table = await waitForTable()
    await waitFor(() => expect(rowNames(table).sort()).toEqual(['alpha.txt', 'current']))
    const fileRow = (): HTMLElement =>
      dataRows(table).find((row) => row.textContent?.includes('alpha.txt'))!
    const symlinkRow = (): HTMLElement =>
      dataRows(table).find((row) => row.textContent?.includes('current'))!

    await user.dblClick(fileRow())
    await waitFor(() => expect(readTextFile).toHaveBeenCalledWith(SESSION_ID, `${HOME}/alpha.txt`))
    expect(useTextEditorStore.getState().tabs[0]).toMatchObject({
      sessionId: SESSION_ID,
      path: `${HOME}/alpha.txt`,
      content: 'server file\n',
      status: 'ready',
    })
    expect(useTextEditorStore.getState().open).toBe(true)

    useTextEditorStore.getState().reset()
    readTextFile.mockClear()

    fileRow().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(readTextFile).toHaveBeenCalledWith(SESSION_ID, `${HOME}/alpha.txt`))

    useTextEditorStore.getState().reset()
    readTextFile.mockClear()
    fireEvent.contextMenu(fileRow())
    await user.click(screen.getByRole('menuitem', { name: /用内置编辑器打开/ }))
    await waitFor(() => expect(readTextFile).toHaveBeenCalledWith(SESSION_ID, `${HOME}/alpha.txt`))

    useTextEditorStore.getState().reset()
    readTextFile.mockClear()
    await user.click(symlinkRow())
    await user.keyboard('{Enter}')
    expect(readTextFile).not.toHaveBeenCalled()
  })

  it('creates a real remote directory from the toolbar dialog', async () => {
    const mkdir = vi.fn(
      async (sessionId: string, parentPath: string, name: string) =>
        ({
          ok: true,
          value: { sessionId, path: `${parentPath}/${name}`, operation: 'mkdir' },
        }) as OperationResult<SftpMutationAck>,
    )
    installBridge(
      {
        '/': [],
        '/home': [],
        [HOME]: [],
      },
      { mkdir },
    )
    const user = userEvent.setup()
    render(<SftpDock />)
    await waitFor(() => expect(screen.getByText(/SFTP 已连接/)).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: '新建远程目录' }))
    const dialog = screen.getByRole('dialog', { name: '新建远程目录' })
    await user.type(within(dialog).getByLabelText(/目录名称/), 'release 2026')
    await user.click(within(dialog).getByRole('button', { name: '创建目录' }))

    await waitFor(() =>
      expect(mkdir).toHaveBeenCalledWith(SESSION_ID, HOME, 'release 2026'),
    )
  })
})
