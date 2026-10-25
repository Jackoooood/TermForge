import { useState } from 'react'
import {
  ArrowLeftRight,
  Info,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  SearchX,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import type { PortForwardItem, PortForwardStatus, PortForwardType } from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import type { BadgeTone } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { IconButton } from '@renderer/components/common/IconButton'
import { SearchInput } from '@renderer/components/common/SearchInput'
import { useAppStore } from '@renderer/stores/appStore'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import {
  isPortForwardActive,
  sortPortForwardItems,
  usePortForwardStore,
} from '@renderer/stores/portForwardStore'

const TYPE_LABELS: Record<PortForwardType, string> = {
  local: '本地',
  remote: '远程',
  dynamic: 'SOCKS5',
}

const STATUS_META: Record<PortForwardStatus, { label: string; tone: BadgeTone }> = {
  stopped: { label: '已停止', tone: 'neutral' },
  starting: { label: '启动中', tone: 'warning' },
  running: { label: '运行中', tone: 'success' },
  stopping: { label: '停止中', tone: 'warning' },
  error: { label: '异常', tone: 'danger' },
}

function endpoint(rule: PortForwardItem['rule'], bound: boolean, item: PortForwardItem): string {
  if (rule.type === 'dynamic') {
    return bound && item.runtime.boundPort
      ? `127.0.0.1:${item.runtime.boundPort}`
      : `127.0.0.1:${rule.bindPort}`
  }
  if (bound && item.runtime.boundAddress) {
    return `${item.runtime.boundAddress}:${item.runtime.boundPort ?? rule.bindPort}`
  }
  return `${rule.bindAddress}:${rule.bindPort}`
}

interface RuleActionsProps {
  item: PortForwardItem
  pending: 'start' | 'stop' | 'remove' | undefined
  onStart: () => void
  onStop: () => void
  onEdit: () => void
  onDelete: () => void
}

function RuleActions({ item, pending, onStart, onStop, onEdit, onDelete }: RuleActionsProps) {
  const active = isPortForwardActive(item)
  const busy = pending !== undefined
  const canStop = active
  const stopEnabled = canStop && pending !== 'stop' && item.runtime.status !== 'stopping'

  return (
    <div className="table-actions">
      {canStop ? (
        <IconButton
          label={`停止 ${item.rule.name}`}
          title={
            item.runtime.status === 'stopping'
              ? '正在停止'
              : item.runtime.cleanupPending
                ? '重试停止并清理'
                : '停止转发'
          }
          size="sm"
          disabled={!stopEnabled}
          onClick={onStop}
        >
          <Square size={12} aria-hidden="true" />
        </IconButton>
      ) : (
        <IconButton
          label={`启动 ${item.rule.name}`}
          title={busy ? '请等待当前操作完成' : '启动转发'}
          size="sm"
          disabled={busy}
          onClick={onStart}
        >
          <Play size={13} aria-hidden="true" />
        </IconButton>
      )}
      <IconButton
        label={`编辑 ${item.rule.name}`}
        title={active ? '请先停止该规则再编辑' : '编辑规则'}
        size="sm"
        disabled={active || busy}
        onClick={onEdit}
      >
        <Pencil size={13} aria-hidden="true" />
      </IconButton>
      <IconButton
        label={`删除 ${item.rule.name}`}
        title={active ? '请先停止该规则并等待清理完成后再删除' : '删除规则'}
        size="sm"
        disabled={active || busy}
        onClick={onDelete}
      >
        <Trash2 size={13} aria-hidden="true" />
      </IconButton>
    </div>
  )
}

export function PortForwardsView() {
  const items = usePortForwardStore((state) => state.items)
  const loadStatus = usePortForwardStore((state) => state.loadStatus)
  const loadError = usePortForwardStore((state) => state.loadError)
  const actionError = usePortForwardStore((state) => state.actionError)
  const pending = usePortForwardStore((state) => state.pending)
  const sync = usePortForwardStore((state) => state.sync)
  const openCreateEditor = usePortForwardStore((state) => state.openCreateEditor)
  const openEditEditor = usePortForwardStore((state) => state.openEditEditor)
  const requestStart = usePortForwardStore((state) => state.requestStart)
  const requestDelete = usePortForwardStore((state) => state.requestDelete)
  const stopRule = usePortForwardStore((state) => state.stopRule)
  const clearActionError = usePortForwardStore((state) => state.clearActionError)
  const connections = useConnectionStore((state) => state.connections)
  const pushToast = useAppStore((state) => state.pushToast)
  const [query, setQuery] = useState('')

  const connectionName = new Map(connections.map((connection) => [connection.id, connection.name]))
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = sortPortForwardItems(items).filter((item) => {
    if (normalizedQuery.length === 0) return true
    return [
      item.rule.name,
      item.rule.type,
      connectionName.get(item.rule.connectionId) ?? item.rule.connectionId,
      item.rule.type === 'dynamic' ? 'socks5' : item.rule.bindAddress,
      item.rule.type === 'dynamic' ? String(item.rule.bindPort) : item.rule.targetHost,
      item.runtime.status,
      item.runtime.failure?.message ?? '',
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  })
  const runningCount = items.filter((item) => item.runtime.status === 'running').length

  const handleStop = async (item: PortForwardItem): Promise<void> => {
    try {
      await stopRule(item.rule.id)
      pushToast({
        tone: 'success',
        title: '端口转发已停止',
        description: `${item.rule.name} 的监听器已关闭，活动连接已清理。`,
      })
    } catch (error) {
      pushToast({
        tone: 'danger',
        title: '停止端口转发失败',
        description:
          error instanceof Error && error.message
            ? error.message
            : '监听器或连接未能清理，请重试。',
      })
    }
  }

  return (
    <div className="module-view port-forward-view">
      <header className="module-header">
        <div className="module-header__main">
          <div className="module-header__eyebrow">
            <span>Port Forwarding</span>
            <Badge tone="neutral">复用现有 SSH 会话</Badge>
          </div>
          <h1 className="module-header__title">端口转发</h1>
          <p className="module-header__description">
            在本机或 SSH 服务端建立监听器，并通过已连接的会话转发 TCP 流量。列表状态来自主进程的实际监听结果；
            应用重启后规则保持停止，SSH 重连也不会静默恢复旧规则。转发数据不会被读取、记录或发送给界面。
          </p>
        </div>
        <div className="module-header__actions">
          <Button size="sm" variant="secondary" onClick={() => void sync()}>
            <RefreshCw size={13} aria-hidden="true" />
            刷新
          </Button>
          <Button size="sm" variant="primary" onClick={openCreateEditor}>
            <Plus size={14} aria-hidden="true" />
            新建规则
          </Button>
        </div>
      </header>

      <div className="module-toolbar">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="搜索规则、连接、地址或状态"
          label="搜索端口转发规则"
        />
        <span className="module-toolbar__meta">
          显示 {filtered.length} / {items.length}
        </span>
        <span className="module-toolbar__spacer" />
        <span className="module-toolbar__meta">
          运行中 {runningCount} 条 · 仅使用现有 SSH 会话
        </span>
      </div>

      {actionError ? (
        <div className="persistence-banner" role="alert">
          <Info size={13} aria-hidden="true" />
          <span>{actionError}</span>
          <button
            type="button"
            className="persistence-banner__dismiss"
            aria-label="关闭转发错误提示"
            onClick={clearActionError}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="module-body servers-table-scroll">
        {loadStatus === 'idle' || loadStatus === 'loading' ? (
          <div className="servers-empty">
            <p className="table-muted">正在读取本机端口转发规则…</p>
          </div>
        ) : loadStatus === 'error' ? (
          <div className="servers-empty">
            <EmptyState
              icon={Info}
              title="端口转发规则加载失败"
              description={loadError ?? '无法读取本机端口转发规则。'}
            >
              <Button size="sm" variant="secondary" onClick={() => void sync()}>
                重试
              </Button>
            </EmptyState>
          </div>
        ) : items.length === 0 ? (
          <div className="servers-empty">
            <EmptyState
              icon={ArrowLeftRight}
              title="还没有端口转发规则"
              description="创建本地、远程或 SOCKS5 规则后，启动时会要求选择一个已连接的 SSH 会话。规则本身不保存密码或私钥。"
            >
              <Button variant="primary" onClick={openCreateEditor}>
                <Plus size={14} aria-hidden="true" />
                新建规则
              </Button>
            </EmptyState>
          </div>
        ) : filtered.length === 0 ? (
          <div className="servers-empty">
            <EmptyState
              icon={SearchX}
              title="没有匹配的转发规则"
              description={`没有找到与“${query.trim()}”匹配的规则。`}
            >
              <Button variant="secondary" onClick={() => setQuery('')}>
                清除搜索
              </Button>
            </EmptyState>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">类型</th>
                <th scope="col">连接</th>
                <th scope="col">监听</th>
                <th scope="col">目标 / 模式</th>
                <th scope="col">状态</th>
                <th scope="col">活动连接</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const meta = STATUS_META[item.runtime.status]
                const pendingAction = pending[item.rule.id]
                const running = item.runtime.status === 'running'
                return (
                  <tr key={item.rule.id}>
                    <td>
                      <div className="table-name">
                        <ArrowLeftRight
                          className="table-name__icon"
                          size={14}
                          aria-hidden="true"
                        />
                        <span className="table-name__text" title={item.rule.name}>
                          {item.rule.name}
                        </span>
                        {item.runtime.cleanupPending ? (
                          <Badge tone="warning">清理待重试</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <Badge
                        tone={item.rule.type === 'dynamic' ? 'primary' : 'neutral'}
                      >
                        {TYPE_LABELS[item.rule.type]}
                      </Badge>
                    </td>
                    <td>
                      <span className="table-muted">
                        {connectionName.get(item.rule.connectionId) ?? item.rule.connectionId}
                      </span>
                    </td>
                    <td>
                      <span className="table-address">
                        {endpoint(item.rule, running, item)}
                      </span>
                      {running && item.runtime.boundPort !== item.rule.bindPort ? (
                        <span className="field__hint">实际端口</span>
                      ) : null}
                    </td>
                    <td>
                      {item.rule.type === 'dynamic' ? (
                        <span className="table-muted">SOCKS5 · 仅回环</span>
                      ) : (
                        <span className="table-address">
                          {item.rule.targetHost}:{item.rule.targetPort}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="table-status">
                        <Badge tone={pendingAction === 'start' ? 'warning' : meta.tone}>
                          {pendingAction === 'start' ? '启动中…' : meta.label}
                        </Badge>
                      </span>
                      {item.runtime.sessionId ? (
                        <p
                          className="forward-session"
                          title={`绑定 SSH 会话 ${item.runtime.sessionId}`}
                        >
                          会话 {item.runtime.sessionId}
                        </p>
                      ) : null}
                      {item.runtime.failure ? (
                        <p className="forward-failure" title={item.runtime.failure.message}>
                          {item.runtime.failure.message}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <span className="table-muted">
                        {running ? item.runtime.activeConnections : 0}
                      </span>
                    </td>
                    <td>
                      <RuleActions
                        item={item}
                        pending={pendingAction}
                        onStart={() => requestStart(item.rule.id)}
                        onStop={() => void handleStop(item)}
                        onEdit={() => openEditEditor(item.rule.id)}
                        onDelete={() => requestDelete(item.rule.id)}
                      />
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
          共 {items.length} 条规则 · 运行中 {runningCount} 条
        </span>
        <span className="servers-footer__hint">
          <ShieldAlert size={11} aria-hidden="true" />
          非回环监听需在启动时确认暴露风险 · SOCKS5 仅限 127.0.0.1 · 不记录转发数据
        </span>
      </footer>
    </div>
  )
}
