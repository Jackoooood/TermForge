import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  ArrowUpDown,
  CornerDownLeft,
  FolderSync,
  LayoutDashboard,
  Moon,
  PanelLeft,
  Plus,
  Search,
  Server,
  Settings,
  Sun,
  type LucideIcon,
  Zap,
} from 'lucide-react'
import type { ConnectionProfile } from '@shared/types'
import { nextThemeStyle, themeLabel } from '@shared/theme/catalog'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { useQuickCommandStore } from '@renderer/stores/quickCommandStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { openConnectionSession } from '@renderer/features/sessions/openConnectionSession'
import { formatShortcut } from '@renderer/lib/platform'

interface PaletteAction {
  id: string
  section: '命令' | '服务器'
  label: string
  description: string
  icon: LucideIcon
  hint?: string
  keywords: string
  run: () => void
}

function matches(action: PaletteAction, query: string): boolean {
  if (query.length === 0) return true
  return `${action.label} ${action.description} ${action.keywords}`.toLowerCase().includes(query)
}

export function CommandPalette() {
  const mode = useWorkspaceStore((state) => state.paletteMode)
  const closePalette = useWorkspaceStore((state) => state.closePalette)
  const setActiveModule = useWorkspaceStore((state) => state.setActiveModule)
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar)
  const connections = useConnectionStore((state) => state.connections)
  const tags = useConnectionStore((state) => state.tags)
  const openCreateEditor = useConnectionStore((state) => state.openCreateEditor)
  const resolvedStyle = useSettingsStore((state) => state.resolvedStyle)
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme)
  const toggleTheme = useSettingsStore((state) => state.toggleTheme)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    if (!mode) return
    setQuery('')
    setSelectedIndex(0)
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [mode])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const results = useMemo<PaletteAction[]>(() => {
    if (!mode) return []
    const normalized = query.trim().toLowerCase()

    const commands: PaletteAction[] = [
      {
        id: 'command-new-connection',
        section: '命令',
        label: '新建连接',
        description: '打开连接编辑器，创建保存在本机的连接配置',
        icon: Plus,
        keywords: 'create connection server 服务器',
        run: () => {
          closePalette()
          openCreateEditor()
        },
      },
      {
        id: 'command-workbench',
        section: '命令',
        label: '切换到工作台',
        description: '查看主进程 SSH 会话状态与标签',
        icon: LayoutDashboard,
        keywords: 'workbench ssh terminal 终端',
        run: () => {
          setActiveModule('workbench')
          closePalette()
        },
      },
      {
        id: 'command-servers',
        section: '命令',
        label: '打开服务器管理',
        description: '浏览、编辑或删除本机连接配置',
        icon: Server,
        keywords: 'servers connections 服务器 连接',
        run: () => {
          setActiveModule('servers')
          closePalette()
        },
      },
      {
        id: 'command-sftp',
        section: '命令',
        label: '打开 SFTP 文件页',
        description: '浏览真实远程目录，上传或下载文件',
        icon: FolderSync,
        keywords: 'sftp files upload download 文件 上传 下载',
        run: () => {
          setActiveModule('sftp')
          closePalette()
        },
      },
      {
        id: 'command-transfers',
        section: '命令',
        label: '打开传输队列',
        description: '查看主进程维护的上传 / 下载任务与冲突',
        icon: ArrowUpDown,
        keywords: 'transfer queue download upload conflict 传输 冲突',
        run: () => {
          const transfers = useTransferStore.getState()
          if (!transfers.panelOpen) transfers.setPanelOpen(true)
          closePalette()
        },
      },
      {
        id: 'command-quick-commands',
        section: '命令',
        label: '打开快速命令',
        description: '浏览命令库、填写参数预览，或查看命令历史',
        icon: Zap,
        hint: formatShortcut('K', { shift: true }),
        keywords: 'quick command history snippet 快速命令 命令库 历史 片段',
        run: () => {
          useQuickCommandStore.getState().openDrawer()
          closePalette()
        },
      },
      {
        id: 'command-settings',
        section: '命令',
        label: '打开设置',
        description: '主题、终端字号与应用信息',
        icon: Settings,
        hint: formatShortcut(','),
        keywords: 'settings preferences 设置 主题',
        run: () => {
          setActiveModule('settings')
          closePalette()
        },
      },
      {
        id: 'command-theme',
        section: '命令',
        label: `切换到 ${themeLabel(nextThemeStyle(resolvedStyle))} 主题`,
        description: '仅改变界面外观，不影响连接',
        icon: resolvedTheme === 'light' ? Moon : Sun,
        keywords: 'theme aurora obsidian mist dbx pearl graphite cobalt sage amber blush 主题 深色 浅色',
        run: () => {
          toggleTheme()
          closePalette()
        },
      },
      {
        id: 'command-sidebar',
        section: '命令',
        label: '收起 / 展开服务器侧栏',
        description: '切换左侧连接列表可见性',
        icon: PanelLeft,
        hint: formatShortcut('B'),
        keywords: 'sidebar panel 侧栏',
        run: () => {
          toggleSidebar()
          closePalette()
        },
      },
    ]

    const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]))
    const serverActions: PaletteAction[] = connections.map((connection: ConnectionProfile) => ({
      id: `server-${connection.id}`,
      section: '服务器',
      label: connection.name,
      description: `${connection.username}@${connection.host}:${connection.port}`,
      icon: Server,
      hint: '发起 SSH 连接',
      keywords: `${connection.host} ${connection.username} ${connection.tagIds
        .map((tagId) => tagNames.get(tagId) ?? '')
        .join(' ')}`,
      run: () => {
        openConnectionSession(connection)
        closePalette()
      },
    }))

    const ordered =
      mode === 'commands' ? [...commands, ...serverActions] : [...serverActions, ...commands]
    return ordered.filter((action) => matches(action, normalized))
  }, [
    mode,
    query,
    connections,
    tags,
    resolvedStyle,
    resolvedTheme,
    closePalette,
    openCreateEditor,
    setActiveModule,
    toggleSidebar,
    toggleTheme,
  ])

  useEffect(() => {
    if (!mode) return
    document.getElementById(`palette-result-${selectedIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [mode, selectedIndex])

  if (!mode) return null
  const runSelected = (): void => {
    const action = results[selectedIndex]
    if (action) action.run()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closePalette()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((index) =>
        results.length === 0 ? 0 : (index - 1 + results.length) % results.length,
      )
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setSelectedIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setSelectedIndex(Math.max(0, results.length - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      runSelected()
    }
  }

  let lastSection: string | null = null

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette()
      }}
    >
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <header className="command-palette__header">
          {mode === 'search' ? (
            <Search size={16} aria-hidden="true" />
          ) : (
            <CornerDownLeft size={16} aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            className="command-palette__input"
            type="text"
            role="combobox"
            aria-label={mode === 'search' ? '搜索服务器或命令' : '搜索命令'}
            aria-expanded="true"
            aria-controls="palette-results"
            aria-autocomplete="list"
            aria-activedescendant={
              results.length > 0 ? `palette-result-${selectedIndex}` : undefined
            }
            placeholder={mode === 'search' ? '搜索服务器或命令…' : '输入命令名称…'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="command-palette__mode">
            <span className="badge badge--neutral">{mode === 'search' ? '搜索' : '命令'}</span>
          </span>
        </header>

        <div
          className="command-palette__list"
          id="palette-results"
          role="listbox"
          aria-label="结果"
        >
          {results.length === 0 ? (
            <div className="palette-empty">
              <span>没有匹配的服务器或命令</span>
              <span className="palette-empty__hint">尝试使用名称、地址、标签或功能关键词</span>
            </div>
          ) : (
            results.map((action, index) => {
              const Icon = action.icon
              const showSection = action.section !== lastSection
              lastSection = action.section
              return (
                <div key={action.id}>
                  {showSection ? (
                    <div className="palette-section-label" aria-hidden="true">
                      {action.section}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    id={`palette-result-${index}`}
                    role="option"
                    aria-selected={index === selectedIndex}
                    className={
                      index === selectedIndex
                        ? 'palette-item palette-item--selected'
                        : 'palette-item'
                    }
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => action.run()}
                  >
                    <Icon className="palette-item__icon" size={15} aria-hidden="true" />
                    <span className="palette-item__body">
                      <span className="palette-item__label">{action.label}</span>
                      <span className="palette-item__description">{action.description}</span>
                    </span>
                    {action.hint ? <span className="palette-item__hint">{action.hint}</span> : null}
                  </button>
                </div>
              )
            })
          )}
        </div>

        <footer className="command-palette__footer">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> 选择
          </span>
          <span>
            <kbd className="kbd">Enter</kbd> 执行
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> 关闭
          </span>
        </footer>
      </section>
    </div>
  )
}
