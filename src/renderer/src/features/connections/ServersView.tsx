import {
  Fingerprint,
  Info,
  KeyRound,
  LockKeyhole,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  SearchX,
  Server,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import type { AuthMethod, ConnectionProfile } from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { IconButton } from '@renderer/components/common/IconButton'
import { SearchInput } from '@renderer/components/common/SearchInput'
import { StatusDot, statusLabel } from '@renderer/components/common/StatusDot'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import { openConnectionSession } from '@renderer/features/sessions/openConnectionSession'
import { formatSshFailureMessage } from '@renderer/lib/formatSshFailure'
import { cn } from '@renderer/lib/utils'

const AUTH_LABELS: Record<AuthMethod, string> = {
  password: 'Password',
  privateKey: 'Private Key',
  sshAgent: 'SSH Agent',
}

export function ServersView() {
  const connections = useConnectionStore((state) => state.connections)
  const groups = useConnectionStore((state) => state.groups)
  const tags = useConnectionStore((state) => state.tags)
  const searchQuery = useConnectionStore((state) => state.searchQuery)
  const setSearchQuery = useConnectionStore((state) => state.setSearchQuery)
  const loadStatus = useConnectionStore((state) => state.loadStatus)
  const loadError = useConnectionStore((state) => state.loadError)
  const persistenceError = useConnectionStore((state) => state.persistenceError)
  const clearPersistenceError = useConnectionStore((state) => state.clearPersistenceError)
  const loadConnections = useConnectionStore((state) => state.loadConnections)
  const openCreateEditor = useConnectionStore((state) => state.openCreateEditor)
  const openEditEditor = useConnectionStore((state) => state.openEditEditor)
  const toggleFavorite = useConnectionStore((state) => state.toggleFavorite)
  const requestDelete = useConnectionStore((state) => state.requestDelete)
  const sessions = useSessionStore((state) => state.sessions)
  const activeTabId = useWorkspaceStore((state) => state.activeTabId)
  const activeConnectionId = activeTabId ? sessions[activeTabId]?.connectionId : undefined

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
      AUTH_LABELS[connection.authMethod],
      ...tagNamesOf(connection),
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  })

  const connectTo = (connection: ConnectionProfile): void => {
    void openConnectionSession(connection)
  }

  return (
    <div className="module-view servers-view">
      <header className="module-header">
        <div className="module-header__main">
          <div className="module-header__eyebrow">
            <span>Connections</span>
            <Badge tone="neutral">本机持久化</Badge>
          </div>
          <h1 className="module-header__title">服务器连接</h1>
          <p className="module-header__description">
            连接配置保存在本机用户数据目录。连接到服务器会由主进程发起真实 SSH
            握手：密码与私钥保存在操作系统凭据存储中，未知主机密钥必须经你明确确认。每次连接会新建独立
            会话标签；交互式终端已接入，SFTP 尚未接入。
          </p>
        </div>
        <div className="module-header__actions">
          <Button size="sm" variant="secondary" onClick={() => void loadConnections()}>
            <RefreshCw size={13} aria-hidden="true" />
            刷新
          </Button>
          <Button size="sm" variant="primary" onClick={openCreateEditor}>
            <Plus size={14} aria-hidden="true" />
            新建连接
          </Button>
        </div>
      </header>

      <div className="module-toolbar">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索名称、主机、用户、分组或标签"
          label="搜索服务器列表"
        />
        <span className="module-toolbar__meta">
          显示 {filteredConnections.length} / {connections.length}
        </span>
        <span className="module-toolbar__spacer" />
        <span className="module-toolbar__meta">凭据引用不含密码或私钥内容</span>
      </div>

      {persistenceError && loadStatus !== 'error' ? (
        <div className="persistence-banner" role="alert">
          <Info size={13} aria-hidden="true" />
          <span>{persistenceError}</span>
          <button
            type="button"
            className="persistence-banner__dismiss"
            aria-label="关闭存储错误提示"
            onClick={clearPersistenceError}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="module-body servers-table-scroll">
        {loadStatus === 'idle' || loadStatus === 'loading' ? (
          <div className="servers-empty">
            <p className="table-muted">正在加载本地连接…</p>
          </div>
        ) : loadStatus === 'error' ? (
          <div className="servers-empty">
            <EmptyState
              icon={Info}
              title="连接列表加载失败"
              description={loadError ?? '无法读取本地连接数据。'}
            >
              <Button size="sm" variant="secondary" onClick={() => void loadConnections()}>
                重试
              </Button>
            </EmptyState>
          </div>
        ) : connections.length === 0 ? (
          <div className="servers-empty">
            <EmptyState
              icon={Server}
              title="还没有连接"
              description="创建一个连接配置后即可发起真实 SSH 连接。凭据由操作系统安全存储保护，不会写入普通配置文件。"
            >
              <Button variant="primary" onClick={openCreateEditor}>
                <Plus size={14} aria-hidden="true" />
                新建连接
              </Button>
            </EmptyState>
          </div>
        ) : filteredConnections.length === 0 ? (
          <div className="servers-empty">
            <EmptyState
              icon={SearchX}
              title="没有匹配的服务器"
              description={`没有找到与“${searchQuery.trim()}”匹配的连接。搜索会匹配名称、地址、用户名、分组和标签。`}
            >
              <Button variant="secondary" onClick={() => setSearchQuery('')}>
                清除搜索
              </Button>
            </EmptyState>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">地址</th>
                <th scope="col">分组</th>
                <th scope="col">认证</th>
                <th scope="col" className="col-tags">
                  标签
                </th>
                <th scope="col">状态</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredConnections.map((connection) => {
                const connectionSessions = Object.values(sessions).filter(
                  (item) => item.connectionId === connection.id,
                )
                const session =
                  connectionSessions.find((item) => item.id === activeTabId) ??
                  connectionSessions.find((item) => item.status === 'connected') ??
                  connectionSessions[0]
                const status = session?.status ?? 'not-connected'
                const sessionCount = connectionSessions.length
                const statusText = session?.failure
                  ? `${statusLabel(status)}：${formatSshFailureMessage(session.failure)}`
                  : statusLabel(status)
                const opened = connection.id === activeConnectionId
                const connectionTags = connection.tagIds.flatMap((tagId) => {
                  const tag = tagById.get(tagId)
                  return tag ? [tag] : []
                })
                const AuthIcon =
                  connection.authMethod === 'password'
                    ? LockKeyhole
                    : connection.authMethod === 'privateKey'
                      ? KeyRound
                      : Fingerprint
                return (
                  <tr key={connection.id}>
                    <td>
                      <div className="table-name">
                        <Server className="table-name__icon" size={14} aria-hidden="true" />
                        <span className="table-name__text" title={connection.name}>
                          {connection.name}
                          {session ? (
                            <Badge tone="primary" style={{ marginLeft: 6 }}>
                              {opened ? '当前' : '会话'}
                              {sessionCount > 1 ? ` ×${sessionCount}` : ''}
                            </Badge>
                          ) : null}
                        </span>
                        <IconButton
                          label={connection.favorite ? '取消收藏' : '加入收藏'}
                          title={connection.favorite ? '取消收藏' : '加入收藏'}
                          size="sm"
                          aria-pressed={connection.favorite}
                          active={connection.favorite}
                          onClick={() => void toggleFavorite(connection.id)}
                        >
                          <Star
                            size={12}
                            fill={connection.favorite ? 'currentColor' : 'none'}
                            aria-hidden="true"
                          />
                        </IconButton>
                      </div>
                    </td>
                    <td>
                      <span
                        className="table-address"
                        title={`${connection.username}@${connection.host}:${connection.port}`}
                      >
                        {connection.username}@{connection.host}:{connection.port}
                      </span>
                    </td>
                    <td>
                      <span className="table-muted">
                        {connection.groupId
                          ? groupNames.get(connection.groupId) ?? '未分组'
                          : '未分组'}
                      </span>
                    </td>
                    <td>
                      <span className="table-auth">
                        <AuthIcon size={12} aria-hidden="true" />
                        {AUTH_LABELS[connection.authMethod]}
                      </span>
                    </td>
                    <td className="col-tags">
                      <div className="tag-list">
                        {connectionTags.slice(0, 3).map((tag) => (
                          <span className={cn('tag', `tag--${tag.color}`)} key={tag.id}>
                            {tag.name}
                          </span>
                        ))}
                        {connectionTags.length > 3 ? (
                          <span className="tag">+{connectionTags.length - 3}</span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <span className="table-status" title={statusText}>
                        <StatusDot status={status} label={statusText} />
                        {statusLabel(status)}
                      </span>
                    </td>
                    <td>
                      <div className="table-actions">
                        <IconButton
                          label={`连接到 ${connection.name}`}
                          size="sm"
                          onClick={() => connectTo(connection)}
                        >
                          <Play size={13} aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`编辑 ${connection.name}`}
                          size="sm"
                          onClick={() => openEditEditor(connection.id)}
                        >
                          <Pencil size={13} aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`删除 ${connection.name}`}
                          title="删除连接"
                          size="sm"
                          onClick={() => requestDelete(connection.id)}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <footer className="servers-footer">
        <span>
          共 {connections.length} 个连接 · 分组 {groups.length} 个
        </span>
        <span className="servers-footer__hint">
          <Info size={11} aria-hidden="true" />
          凭据受系统安全存储保护 · 远程终端已接入 · SFTP 尚未接入
        </span>
      </footer>
    </div>
  )
}
