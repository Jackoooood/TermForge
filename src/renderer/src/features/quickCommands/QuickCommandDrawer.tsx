import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Clock3,
  Copy,
  CornerDownLeft,
  Crosshair,
  History,
  Info,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import type { CommandHistoryEntry, QuickCommand } from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { IconButton } from '@renderer/components/common/IconButton'
import { SearchInput } from '@renderer/components/common/SearchInput'
import { useAppStore } from '@renderer/stores/appStore'
import { useQuickCommandStore } from '@renderer/stores/quickCommandStore'
import type { QuickCommandPane } from '@renderer/stores/quickCommandStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { listQuickCommandTargets } from '@renderer/lib/quickCommandTargets'
import { cn } from '@renderer/lib/utils'

type LibraryScope = 'all' | 'favorites'

function formatSentAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function commandMatches(command: QuickCommand, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return true
  return `${command.name} ${command.category} ${command.description} ${command.body}`
    .toLowerCase()
    .includes(normalized)
}

function historyMatches(entry: CommandHistoryEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return true
  return `${entry.body} ${entry.connectionName} ${entry.host}`.toLowerCase().includes(normalized)
}

export function QuickCommandDrawer() {
  const drawerOpen = useQuickCommandStore((state) => state.drawerOpen)
  const activePane = useQuickCommandStore((state) => state.activePane)
  const search = useQuickCommandStore((state) => state.search)
  const commands = useQuickCommandStore((state) => state.commands)
  const commandsStatus = useQuickCommandStore((state) => state.commandsStatus)
  const commandsError = useQuickCommandStore((state) => state.commandsError)
  const history = useQuickCommandStore((state) => state.history)
  const historyStatus = useQuickCommandStore((state) => state.historyStatus)
  const historyError = useQuickCommandStore((state) => state.historyError)
  const capturedTarget = useQuickCommandStore((state) => state.capturedTarget)
  const setSearch = useQuickCommandStore((state) => state.setSearch)
  const setActivePane = useQuickCommandStore((state) => state.setActivePane)
  const closeDrawer = useQuickCommandStore((state) => state.closeDrawer)
  const refreshCommands = useQuickCommandStore((state) => state.refreshCommands)
  const refreshHistory = useQuickCommandStore((state) => state.refreshHistory)
  const openEditor = useQuickCommandStore((state) => state.openEditor)
  const openCompose = useQuickCommandStore((state) => state.openCompose)
  const toggleFavorite = useQuickCommandStore((state) => state.toggleFavorite)
  const removeCommand = useQuickCommandStore((state) => state.removeCommand)
  const removeHistoryEntry = useQuickCommandStore((state) => state.removeHistoryEntry)
  const clearHistory = useQuickCommandStore((state) => state.clearHistory)
  const historyEnabled = useSettingsStore((state) => state.commandHistoryEnabled)
  const sessions = useSessionStore((state) => state.sessions)
  const shells = useTerminalStore((state) => state.shells)
  const pushToast = useAppStore((state) => state.pushToast)

  const [scope, setScope] = useState<LibraryScope>('all')
  const [category, setCategory] = useState('all')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!drawerOpen) return
    setScope('all')
    setCategory('all')
    setPendingDeleteId(null)
    setConfirmingClear(false)
    setClearing(false)
    setBusyId(null)
  }, [drawerOpen])

  useEffect(() => {
    if (!drawerOpen) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const state = useQuickCommandStore.getState()
      if (state.editor || state.compose) return
      event.preventDefault()
      state.closeDrawer()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [drawerOpen])

  const categories = useMemo(() => {
    const seen = new Set<string>()
    for (const command of commands) seen.add(command.category)
    return [...seen]
  }, [commands])

  useEffect(() => {
    if (category !== 'all' && !categories.includes(category)) setCategory('all')
  }, [categories, category])

  const visibleCommands = useMemo(() => {
    const filtered = commands.filter(
      (command) =>
        (scope === 'all' || command.favorite) &&
        (category === 'all' || command.category === category) &&
        commandMatches(command, search),
    )
    return filtered.sort((left, right) => Number(right.favorite) - Number(left.favorite))
  }, [commands, scope, category, search])

  const visibleHistory = useMemo(
    () => history.filter((entry) => historyMatches(entry, search)),
    [history, search],
  )

  const capturedTargetInfo = useMemo(() => {
    if (!capturedTarget) return null
    return (
      listQuickCommandTargets(sessions, shells).find(
        (target) =>
          target.tabId === capturedTarget.tabId && target.sessionId === capturedTarget.sessionId,
      ) ?? null
    )
  }, [capturedTarget, sessions, shells])

  if (!drawerOpen) return null

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      pushToast({ tone: 'success', title: `${label}已复制到剪贴板` })
    } catch {
      pushToast({
        tone: 'warning',
        title: '无法访问剪贴板',
        description: '当前环境不允许写入剪贴板，请手动选择命令文本复制。',
      })
    }
  }

  const favorite = async (command: QuickCommand): Promise<void> => {
    if (busyId) return
    setBusyId(command.id)
    const result = await toggleFavorite(command)
    setBusyId(null)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法更新收藏', description: result.error.message })
    }
  }

  const confirmDelete = async (command: QuickCommand): Promise<void> => {
    if (busyId) return
    setBusyId(command.id)
    const result = await removeCommand(command.id)
    setBusyId(null)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法删除快速命令', description: result.error.message })
      return
    }
    setPendingDeleteId(null)
    pushToast({ tone: 'success', title: `已删除「${command.name}」` })
  }

  const deleteHistory = async (entry: CommandHistoryEntry): Promise<void> => {
    if (busyId) return
    setBusyId(entry.id)
    const result = await removeHistoryEntry(entry.id)
    setBusyId(null)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法删除历史记录', description: result.error.message })
    }
  }

  const clearAllHistory = async (): Promise<void> => {
    if (clearing) return
    setClearing(true)
    const result = await clearHistory()
    setClearing(false)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法清空命令历史', description: result.error.message })
      return
    }
    setConfirmingClear(false)
    pushToast({
      tone: result.value.cleared > 0 ? 'success' : 'info',
      title:
        result.value.cleared > 0
          ? `已清空 ${result.value.cleared} 条命令历史`
          : '没有可清空的命令历史',
      description: '只影响快速命令历史，不会删除应用诊断日志。',
    })
  }

  const retryActivePane = (): void => {
    if (activePane === 'library') void refreshCommands()
    else void refreshHistory()
  }

  const paneButton = (pane: QuickCommandPane, label: string, count: number): ReactElement => (
    <button
      type="button"
      role="tab"
      aria-selected={activePane === pane}
      className={cn('qc-tab', activePane === pane && 'qc-tab--active')}
      onClick={() => setActivePane(pane)}
    >
      {label}
      <span className="qc-tab__count">{count}</span>
    </button>
  )

  return createPortal(
    <>
      <div className="qc-backdrop" aria-hidden="true" onMouseDown={closeDrawer} />
      <aside
        className="qc-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-command-title"
      >
        <header className="qc-drawer__header">
          <div>
            <div className="qc-drawer__title-row">
              <h2 className="qc-drawer__title" id="quick-command-title">
                快速命令
              </h2>
              <Badge tone="primary">现有终端输入通道</Badge>
            </div>
            <p className="qc-drawer__subtitle">
              命令只写入选定的 SSH Shell，不新建 SSH Client，也不通过任意 exec 通道执行。
            </p>
          </div>
          <IconButton label="关闭快速命令" size="sm" autoFocus onClick={closeDrawer}>
            <X size={15} aria-hidden="true" />
          </IconButton>
        </header>

        <div className="qc-target-strip">
          <Crosshair size={12} aria-hidden="true" />
          {capturedTargetInfo ? (
            <span className="qc-target-strip__text">
              打开时目标：
              <strong>{capturedTargetInfo.label}</strong>
              <span className="qc-target-strip__detail">{capturedTargetInfo.detail}</span>
            </span>
          ) : (
            <span className="qc-target-strip__text">
              打开时未捕获可发送终端；发送或插入前需显式选择目标。
            </span>
          )}
        </div>

        <div className="qc-drawer__tabs" role="tablist" aria-label="快速命令视图">
          {paneButton('library', '命令库', commands.length)}
          {paneButton('history', '历史', history.length)}
          <span className="qc-drawer__tabs-spacer" />
          {activePane === 'library' ? (
            <Button size="sm" variant="primary" onClick={() => openEditor(null)}>
              <Plus size={13} aria-hidden="true" />
              新建
            </Button>
          ) : null}
        </div>

        <div className="qc-drawer__toolbar">
          <SearchInput
            className="qc-search"
            value={search}
            onChange={setSearch}
            label={activePane === 'library' ? '搜索快速命令' : '搜索命令历史'}
            placeholder={activePane === 'library' ? '搜索名称、分类或命令…' : '搜索命令正文或目标主机…'}
          />
          <IconButton
            label={activePane === 'library' ? '从主进程刷新快速命令' : '从主进程刷新命令历史'}
            size="sm"
            disabled={
              activePane === 'library'
                ? commandsStatus === 'loading'
                : historyStatus === 'loading'
            }
            onClick={retryActivePane}
          >
            <RefreshCw
              className={
                (activePane === 'library' ? commandsStatus : historyStatus) === 'loading'
                  ? 'spin'
                  : undefined
              }
              size={13}
              aria-hidden="true"
            />
          </IconButton>
          {activePane === 'history' ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={history.length === 0 || clearing}
              onClick={() => setConfirmingClear(true)}
            >
              <Trash2 size={12} aria-hidden="true" />
              清空历史
            </Button>
          ) : null}
        </div>

        {activePane === 'library' ? (
          <div className="qc-filters" aria-label="筛选快速命令">
            <button
              type="button"
              className={cn('qc-chip', scope === 'all' && category === 'all' && 'qc-chip--active')}
              onClick={() => {
                setScope('all')
                setCategory('all')
              }}
            >
              全部
            </button>
            <button
              type="button"
              className={cn('qc-chip', scope === 'favorites' && 'qc-chip--active')}
              onClick={() => setScope(scope === 'favorites' ? 'all' : 'favorites')}
            >
              <Star size={11} aria-hidden="true" />
              收藏
            </button>
            {categories.map((item) => (
              <button
                key={item}
                type="button"
                className={cn('qc-chip', scope === 'all' && category === item && 'qc-chip--active')}
                onClick={() => {
                  setScope('all')
                  setCategory(item)
                }}
              >
                {item}
              </button>
            ))}
          </div>
        ) : null}

        {activePane === 'history' && !historyEnabled ? (
          <div className="qc-notice qc-notice--warning" role="status">
            <Info size={12} aria-hidden="true" />
            <span>
              命令历史已在设置中关闭。已有记录仍可查看、插入、复制、重新发送或清空，但新的发送不会新增记录。
            </span>
          </div>
        ) : null}

        {confirmingClear ? (
          <div className="qc-inline-confirm" role="alertdialog" aria-label="确认清空命令历史">
            <AlertTriangle size={12} aria-hidden="true" />
            <span>确认清空全部 {history.length} 条命令历史？该操作不可撤销。</span>
            <Button size="sm" variant="danger" disabled={clearing} onClick={() => void clearAllHistory()}>
              {clearing ? '清空中…' : '确认清空'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={clearing}
              onClick={() => setConfirmingClear(false)}
            >
              取消
            </Button>
          </div>
        ) : null}

        <div className="qc-drawer__list">
          {activePane === 'library' ? (
            commandsStatus === 'loading' && commands.length === 0 ? (
              <p className="qc-empty">正在读取快速命令…</p>
            ) : commandsStatus === 'error' ? (
              <div className="qc-empty qc-empty--error" role="alert">
                <span>{commandsError ?? '读取快速命令失败。'}</span>
                <Button size="sm" variant="secondary" onClick={() => void refreshCommands()}>
                  重试
                </Button>
              </div>
            ) : visibleCommands.length === 0 ? (
              <div className="qc-empty">
                <Zap size={25} strokeWidth={1.5} aria-hidden="true" />
                <span>{commands.length === 0 ? '还没有快速命令' : '没有匹配的快速命令'}</span>
                <span className="qc-empty__hint">
                  {commands.length === 0
                    ? '创建自定义命令，或使用内置的只读诊断命令。'
                    : '调整搜索关键词、分类或收藏筛选。'}
                </span>
              </div>
            ) : (
              visibleCommands.map((command) => (
                <article className="qc-card" key={command.id} aria-label={command.name}>
                  <div className="qc-card__head">
                    <IconButton
                      label={command.favorite ? `取消收藏 ${command.name}` : `收藏 ${command.name}`}
                      size="sm"
                      active={command.favorite}
                      disabled={busyId === command.id}
                      className="qc-card__star"
                      onClick={() => void favorite(command)}
                    >
                      <Star
                        size={13}
                        fill={command.favorite ? 'currentColor' : 'none'}
                        aria-hidden="true"
                      />
                    </IconButton>
                    <span className="qc-card__name" title={command.name}>
                      {command.name}
                    </span>
                    <Badge tone={command.source === 'built-in' ? 'neutral' : 'primary'}>
                      {command.source === 'built-in' ? '内置 · 只读' : '自定义'}
                    </Badge>
                  </div>
                  <div className="qc-card__meta">
                    <span>{command.category}</span>
                    {command.parameters.length > 0 ? (
                      <span>{command.parameters.length} 个参数</span>
                    ) : null}
                  </div>
                  <code className="qc-card__body" title={command.body}>
                    {command.body}
                  </code>
                  {command.description ? (
                    <p className="qc-card__description">{command.description}</p>
                  ) : null}
                  <div className="qc-card__actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        openCompose('insert', { kind: 'command', commandId: command.id })
                      }
                    >
                      <CornerDownLeft size={12} aria-hidden="true" />
                      插入
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        openCompose('send', { kind: 'command', commandId: command.id })
                      }
                    >
                      <Play size={12} aria-hidden="true" />
                      发送
                    </Button>
                    <span className="qc-card__spacer" />
                    <IconButton
                      label={`复制 ${command.name} 的命令文本`}
                      size="sm"
                      onClick={() => void copyText(command.body, '命令文本')}
                    >
                      <Copy size={12} aria-hidden="true" />
                    </IconButton>
                    {command.editable ? (
                      <>
                        <IconButton
                          label={`编辑 ${command.name}`}
                          size="sm"
                          onClick={() => openEditor(command.id)}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`删除 ${command.name}`}
                          size="sm"
                          disabled={busyId === command.id}
                          onClick={() => setPendingDeleteId(command.id)}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </IconButton>
                      </>
                    ) : null}
                  </div>
                  {pendingDeleteId === command.id ? (
                    <div
                      className="qc-inline-confirm qc-inline-confirm--card"
                      role="alertdialog"
                      aria-label={`确认删除 ${command.name}`}
                    >
                      <AlertTriangle size={12} aria-hidden="true" />
                      <span>删除后不可恢复。</span>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId === command.id}
                        onClick={() => void confirmDelete(command)}
                      >
                        {busyId === command.id ? '删除中…' : '确认删除'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === command.id}
                        onClick={() => setPendingDeleteId(null)}
                      >
                        取消
                      </Button>
                    </div>
                  ) : null}
                </article>
              ))
            )
          ) : historyStatus === 'loading' && history.length === 0 ? (
            <p className="qc-empty">正在读取命令历史…</p>
          ) : historyStatus === 'error' ? (
            <div className="qc-empty qc-empty--error" role="alert">
              <span>{historyError ?? '读取命令历史失败。'}</span>
              <Button size="sm" variant="secondary" onClick={() => void refreshHistory()}>
                重试
              </Button>
              <span className="qc-empty__hint">
                历史文件可能损坏；可在设置中清空命令历史以恢复。其他操作不会覆盖该文件。
              </span>
            </div>
          ) : visibleHistory.length === 0 ? (
            <div className="qc-empty">
              <History size={25} strokeWidth={1.5} aria-hidden="true" />
              <span>{history.length === 0 ? '还没有命令历史' : '没有匹配的历史记录'}</span>
              <span className="qc-empty__hint">
                {history.length === 0
                  ? historyEnabled
                    ? '发送快速命令时勾选「记录本次发送」后，记录会出现在这里。'
                    : '命令历史已在设置中关闭；启用并勾选记录后才会新增。'
                  : '调整搜索关键词。'}
              </span>
            </div>
          ) : (
            visibleHistory.map((entry) => (
              <article className="qc-card" key={entry.id} aria-label={`历史记录 ${entry.body}`}>
                <div className="qc-card__head">
                  <Clock3 size={12} className="qc-card__clock" aria-hidden="true" />
                  <span className="qc-card__time">{formatSentAt(entry.sentAt)}</span>
                  <Badge tone="neutral">{entry.connectionName}</Badge>
                </div>
                <div className="qc-card__meta">
                  <span>{entry.host}</span>
                </div>
                <code className="qc-card__body" title={entry.body}>
                  {entry.body}
                </code>
                <div className="qc-card__actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => openCompose('insert', { kind: 'history', entryId: entry.id })}
                  >
                    <CornerDownLeft size={12} aria-hidden="true" />
                    插入
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => openCompose('send', { kind: 'history', entryId: entry.id })}
                  >
                    <Play size={12} aria-hidden="true" />
                    重新发送
                  </Button>
                  <span className="qc-card__spacer" />
                  <IconButton
                    label="复制历史命令"
                    size="sm"
                    onClick={() => void copyText(entry.body, '历史命令')}
                  >
                    <Copy size={12} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label="删除该历史记录"
                    size="sm"
                    disabled={busyId === entry.id}
                    onClick={() => void deleteHistory(entry)}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </IconButton>
                </div>
              </article>
            ))
          )}
        </div>

        <footer className="qc-drawer__note">
          <Info size={12} aria-hidden="true" />
          <span>
            插入只写入当前光标位置，不追加回车；发送在确认后写入并回车。写入成功仅表示已交给 SSH
            Shell，不代表远端命令执行成功。命令历史与应用日志分离，保存在本机应用数据目录的
            command-history.json，文件未额外加密，不记录终端输出或退出码。
          </span>
        </footer>
      </aside>
    </>,
    document.body,
  )
}
