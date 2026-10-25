import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeftRight,
  ChevronDown,
  Copy,
  FolderSync,
  History,
  Info,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  SearchX,
  Server,
  Settings,
  Star,
  StarOff,
  Terminal,
  Trash2,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ConnectionGroupTone, ConnectionProfile } from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { IconButton } from '@renderer/components/common/IconButton'
import { FloatingMenu, MenuItem, MenuSeparator } from '@renderer/components/common/Menu'
import type { MenuPosition } from '@renderer/components/common/Menu'
import { SearchInput } from '@renderer/components/common/SearchInput'
import { StatusDot, statusLabel } from '@renderer/components/common/StatusDot'
import { useAppStore } from '@renderer/stores/appStore'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { useQuickCommandStore } from '@renderer/stores/quickCommandStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import type { WorkspaceModule } from '@renderer/stores/workspaceStore'
import { cn } from '@renderer/lib/utils'
import { formatSshFailureMessage } from '@renderer/lib/formatSshFailure'
import { openConnectionSession } from '@renderer/features/sessions/openConnectionSession'

interface GroupView {
  id: string
  name: string
  tone?: ConnectionGroupTone
  icon?: LucideIcon
  connections: ConnectionProfile[]
}

interface ConnectionMenuState {
  connection: ConnectionProfile
  position: MenuPosition
}

interface NavItem {
  id: WorkspaceModule | 'quick-commands' | 'command-history'
  label: string
  icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
  { id: 'workbench', label: '首页', icon: LayoutDashboard },
  { id: 'servers', label: '连接管理', icon: Server },
  { id: 'sftp', label: 'SFTP 文件', icon: FolderSync },
  { id: 'quick-commands', label: '命令库', icon: Zap },
  { id: 'command-history', label: '历史记录', icon: History },
  { id: 'port-forwards', label: '端口转发', icon: ArrowLeftRight },
  { id: 'settings', label: '设置', icon: Settings },
]

export function PrimarySidebar() {
  const connections = useConnectionStore((state) => state.connections)
  const groups = useConnectionStore((state) => state.groups)
  const tags = useConnectionStore((state) => state.tags)
  const loadStatus = useConnectionStore((state) => state.loadStatus)
  const loadError = useConnectionStore((state) => state.loadError)
  const searchQuery = useConnectionStore((state) => state.searchQuery)
  const collapsedGroupIds = useConnectionStore((state) => state.collapsedGroupIds)
  const setSearchQuery = useConnectionStore((state) => state.setSearchQuery)
  const toggleGroup = useConnectionStore((state) => state.toggleGroup)
  const loadConnections = useConnectionStore((state) => state.loadConnections)
  const openCreateEditor = useConnectionStore((state) => state.openCreateEditor)
  const openEditEditor = useConnectionStore((state) => state.openEditEditor)
  const toggleFavorite = useConnectionStore((state) => state.toggleFavorite)
  const requestDelete = useConnectionStore((state) => state.requestDelete)
  const activeModule = useWorkspaceStore((state) => state.activeModule)
  const setActiveModule = useWorkspaceStore((state) => state.setActiveModule)
  const openDrawer = useQuickCommandStore((state) => state.openDrawer)
  const sessions = useSessionStore((state) => state.sessions)
  const activeTabId = useWorkspaceStore((state) => state.activeTabId)
  const activeConnectionId = activeTabId ? sessions[activeTabId]?.connectionId : undefined
  const pushToast = useAppStore((state) => state.pushToast)
  const [menuState, setMenuState] = useState<ConnectionMenuState | null>(null)

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const groupNames = new Map(groups.map((group) => [group.id, group.name]))
  const tagById = new Map(tags.map((tag) => [tag.id, tag]))
  const tagNamesOf = (connection: ConnectionProfile): string[] =>
    connection.tagIds.flatMap((tagId) => {
      const tag = tagById.get(tagId)
      return tag ? [tag.name] : []
    })

  const filteredConnections = connections.filter((connection) => {
    if (normalizedQuery.length === 0) return true
    const groupName = connection.groupId
      ? groupNames.get(connection.groupId) ?? ''
      : '未分组'
    return [
      connection.name,
      connection.host,
      connection.username,
      String(connection.port),
      groupName,
      ...tagNamesOf(connection),
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  })

  const favorites = filteredConnections.filter((connection) => connection.favorite)
  const showFavoritesBlock = normalizedQuery.length === 0 && favorites.length > 0

  const groupViews: GroupView[] = []
  if (!showFavoritesBlock && favorites.length > 0) {
    groupViews.push({ id: 'favorites', name: '收藏', icon: Star, connections: favorites })
  }
  for (const group of groups) {
    const groupConnections = filteredConnections.filter(
      (connection) => connection.groupId === group.id,
    )
    if (groupConnections.length === 0) continue
    groupViews.push({
      id: group.id,
      name: group.name,
      tone: group.tone,
      connections: groupConnections,
    })
  }
  const ungroupedConnections = filteredConnections.filter(
    (connection) => connection.groupId === null,
  )
  if (ungroupedConnections.length > 0) {
    groupViews.push({
      id: 'ungrouped',
      name: '未分组',
      connections: ungroupedConnections,
    })
  }

  const openConnectionMenu = (connection: ConnectionProfile, position: MenuPosition): void => {
    setMenuState({ connection, position })
  }

  const copyAddress = (connection: ConnectionProfile): void => {
    const address = `${connection.host}:${connection.port}`
    if (!navigator.clipboard?.writeText) {
      pushToast({
        tone: 'warning',
        title: '无法复制地址',
        description: '当前环境不提供剪贴板访问。',
      })
      setMenuState(null)
      return
    }
    void navigator.clipboard
      .writeText(address)
      .then(() => {
        pushToast({ tone: 'success', title: '地址已复制', description: address })
      })
      .catch(() => {
        pushToast({
          tone: 'warning',
          title: '无法复制地址',
          description: '浏览器拒绝了剪贴板访问。',
        })
      })
    setMenuState(null)
  }

  const renderConnection = (connection: ConnectionProfile): ReactNode => {
    const connectionSessions = Object.values(sessions).filter(
      (item) => item.connectionId === connection.id,
    )
    const session =
      connectionSessions.find((item) => item.id === activeTabId) ??
      connectionSessions.find((item) => item.status === 'connected') ??
      connectionSessions[0]
    const status = session?.status ?? 'not-connected'
    const countSuffix =
      connectionSessions.length > 1 ? ` · ${connectionSessions.length} 个会话` : ''
    const label = session?.failure
      ? `${statusLabel(status)}：${formatSshFailureMessage(session.failure)}`
      : `${statusLabel(status)}${countSuffix}`
    const active = connection.id === activeConnectionId
    return (
      <div
        key={connection.id}
        className={cn('server-row', active && 'server-row--active')}
        onContextMenu={(event) => {
          event.preventDefault()
          openConnectionMenu(connection, { x: event.clientX, y: event.clientY })
        }}
      >
        <button
          type="button"
          className="server-row__main"
          aria-label={`连接 ${connection.name}，${connection.username}@${connection.host}:${connection.port}，${label}`}
          title={`${connection.username}@${connection.host}:${connection.port} · ${label}`}
          onClick={() => void openConnectionSession(connection)}
        >
          <StatusDot status={status} label={label} className="server-row__dot" />
          <span className="server-row__body">
            <span className="server-row__name">{connection.name}</span>
            <span className="server-row__address">
              {connection.username}@{connection.host}
              {connection.port === 22 ? '' : `:${connection.port}`}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="server-row__menu"
          aria-label={`${connection.name} 更多操作`}
          title="更多操作"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            openConnectionMenu(connection, {
              x: Math.max(8, rect.right - 224),
              y: rect.bottom + 4,
            })
          }}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>
    )
  }

  const showSkeleton = loadStatus === 'idle' || loadStatus === 'loading'

  const navigate = (item: NavItem): void => {
    if (item.id === 'quick-commands') {
      openDrawer(null, 'library')
      return
    }
    if (item.id === 'command-history') {
      openDrawer(null, 'history')
      return
    }
    setActiveModule(item.id)
  }

  return (
    <aside className="primary-sidebar" aria-label="主导航与服务器资源">
      <div className="primary-sidebar__brand">
        <span className="primary-sidebar__brand-mark" aria-hidden="true">
          <Terminal size={14} strokeWidth={2.2} />
        </span>
        <span className="primary-sidebar__brand-name">TermForge</span>
      </div>

      <nav className="primary-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const active = item.id === activeModule
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={cn('primary-nav__item', active && 'primary-nav__item--active')}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(item)}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar__header">
        <div className="sidebar__title-row">
          <h2 className="sidebar__title">服务器</h2>
          <span className="sidebar__count">{connections.length}</span>
          <Badge tone="neutral" title="连接配置保存在本机用户数据目录；连接状态来自主进程 SSH 会话">
            本地配置
          </Badge>
          <div className="sidebar__actions">
            <IconButton label="新建连接" size="sm" onClick={openCreateEditor}>
              <Plus size={15} aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索名称、地址或标签"
          label="搜索服务器"
        />
      </div>

      <div className="sidebar__scroll">
        {showFavoritesBlock ? (
          <section className="sidebar-favorites" aria-label="常用连接">
            <div className="sidebar-favorites__label">
              <Star size={11} aria-hidden="true" />
              常用连接
            </div>
            {favorites.map((connection) => renderConnection(connection))}
          </section>
        ) : null}

        {showSkeleton ? (
          <div className="sidebar-skeleton" aria-label="正在加载本地连接">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div key={index} className="sidebar-skeleton__row" />
            ))}
          </div>
        ) : loadStatus === 'error' ? (
          <div className="sidebar-state">
            <p>{loadError ?? '连接列表加载失败'}</p>
            <Button size="sm" variant="secondary" onClick={() => void loadConnections()}>
              重试
            </Button>
          </div>
        ) : connections.length === 0 ? (
          <div className="sidebar-state">
            <p>还没有连接配置。</p>
            <Button size="sm" variant="secondary" onClick={openCreateEditor}>
              新建连接
            </Button>
          </div>
        ) : filteredConnections.length === 0 ? (
          <div className="sidebar-empty">
            <SearchX size={20} strokeWidth={1.6} aria-hidden="true" />
            <p>未找到匹配的服务器</p>
            <button type="button" className="text-link" onClick={() => setSearchQuery('')}>
              清除搜索条件
            </button>
          </div>
        ) : (
          <div className="sidebar-groups">
            {groupViews.map((group) => {
              const collapsed = collapsedGroupIds.includes(group.id)
              const GroupIcon = group.icon
              return (
                <section className="sidebar-group" key={group.id} aria-label={group.name}>
                  <button
                    type="button"
                    className="sidebar-group__header"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span
                      className={cn(
                        'sidebar-group__marker',
                        group.tone && `sidebar-group__marker--${group.tone}`,
                      )}
                      aria-hidden="true"
                    >
                      {GroupIcon ? <GroupIcon size={11} /> : null}
                    </span>
                    <span className="sidebar-group__title">{group.name}</span>
                    <span className="sidebar-group__count">{group.connections.length}</span>
                    <ChevronDown
                      className={cn(
                        'sidebar-group__chevron',
                        collapsed && 'sidebar-group__chevron--collapsed',
                      )}
                      size={13}
                      aria-hidden="true"
                    />
                  </button>
                  {!collapsed ? (
                    <div className="sidebar-group__body">
                      {group.connections.map((connection) => renderConnection(connection))}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </div>
        )}
      </div>

      <div className="sidebar__footer">
        <Info size={12} aria-hidden="true" />
        <span>配置本机持久化 · 连接状态来自主进程</span>
      </div>

      {menuState ? (
        <FloatingMenu
          position={menuState.position}
          onClose={() => setMenuState(null)}
          ariaLabel={`${menuState.connection.name} 操作菜单`}
        >
          <div className="menu-header">
            <span>{menuState.connection.name}</span>
            <span>{menuState.connection.host}</span>
          </div>
          <MenuItem
            icon={Play}
            label="连接服务器"
            onSelect={() => {
              void openConnectionSession(menuState.connection)
              setMenuState(null)
            }}
          />
          <MenuItem
            icon={Pencil}
            label="编辑连接"
            onSelect={() => {
              openEditEditor(menuState.connection.id)
              setMenuState(null)
            }}
          />
          <MenuItem
            icon={menuState.connection.favorite ? StarOff : Star}
            label={menuState.connection.favorite ? '取消收藏' : '加入收藏'}
            onSelect={() => {
              void toggleFavorite(menuState.connection.id)
              setMenuState(null)
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={Copy}
            label="复制地址"
            onSelect={() => copyAddress(menuState.connection)}
          />
          <MenuItem
            icon={Trash2}
            label="删除连接"
            danger
            onSelect={() => {
              requestDelete(menuState.connection.id)
              setMenuState(null)
            }}
          />
        </FloatingMenu>
      ) : null}
    </aside>
  )
}
