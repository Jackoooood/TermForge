import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Info, RefreshCw, Trash2, X } from 'lucide-react'
import { isActiveTransferStatus, isTerminalTransferStatus } from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { IconButton } from '@renderer/components/common/IconButton'
import { useAppStore } from '@renderer/stores/appStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import { TransferTaskList } from './TransferTaskList'

export function TransferDrawer() {
  const panelOpen = useTransferStore((state) => state.panelOpen)
  const tasks = useTransferStore((state) => state.tasks)
  const syncing = useTransferStore((state) => state.syncing)
  const syncError = useTransferStore((state) => state.syncError)
  const setPanelOpen = useTransferStore((state) => state.setPanelOpen)
  const clearHistory = useTransferStore((state) => state.clearHistory)
  const sync = useTransferStore((state) => state.sync)
  const pushToast = useAppStore((state) => state.pushToast)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    if (!panelOpen) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setPanelOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [panelOpen, setPanelOpen])

  if (!panelOpen) return null

  const activeCount = tasks.filter((task) => isActiveTransferStatus(task.status)).length
  const conflictCount = tasks.filter(
    (task) => task.status === 'waitingForConflictResolution',
  ).length
  const terminalCount = tasks.filter((task) => isTerminalTransferStatus(task.status)).length

  const clear = async (): Promise<void> => {
    if (clearing) return
    setClearing(true)
    const result = await clearHistory()
    setClearing(false)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法清空传输记录', description: result.error.message })
      return
    }
    pushToast({
      tone: 'info',
      title:
        result.value.cleared > 0
          ? `已清空 ${result.value.cleared} 条传输记录`
          : '没有可清空的传输记录',
      description: '进行中或等待处理冲突的任务不会被删除。',
    })
  }

  return createPortal(
    <>
      <div
        className="transfer-backdrop"
        aria-hidden="true"
        onMouseDown={() => setPanelOpen(false)}
      />
      <aside
        className="transfer-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-drawer-title"
      >
        <header className="transfer-drawer__header">
          <div>
            <div className="transfer-drawer__title-row">
              <h2 className="transfer-drawer__title" id="transfer-drawer-title">
                传输队列
              </h2>
              <Badge tone="success">主进程</Badge>
            </div>
            <p className="transfer-drawer__subtitle">
              任务状态、文件流与临时文件均由主进程维护；关闭面板不会中断传输。
            </p>
          </div>
          <IconButton label="关闭传输队列" size="sm" autoFocus onClick={() => setPanelOpen(false)}>
            <X size={15} aria-hidden="true" />
          </IconButton>
        </header>

        <div className="transfer-drawer__toolbar">
          <span>
            共 {tasks.length} 个 · 进行中 {activeCount}
            {conflictCount > 0 ? ` · 冲突 ${conflictCount}` : ''}
          </span>
          <div className="transfer-drawer__toolbar-actions">
            <IconButton
              label="从主进程刷新传输任务"
              size="sm"
              disabled={syncing}
              onClick={() => void sync()}
            >
              <RefreshCw className={syncing ? 'spin' : undefined} size={13} aria-hidden="true" />
            </IconButton>
            <Button
              size="sm"
              variant="ghost"
              disabled={terminalCount === 0 || clearing}
              onClick={() => void clear()}
            >
              <Trash2 size={12} aria-hidden="true" />
              {clearing ? '清理中…' : '清空已结束'}
            </Button>
          </div>
        </div>

        {syncError ? (
          <div className="transfer-drawer__error" role="alert">
            <AlertTriangle size={12} aria-hidden="true" />
            <span>{syncError}</span>
            <Button size="sm" variant="ghost" onClick={() => void sync()}>
              重试
            </Button>
          </div>
        ) : null}

        <div className="transfer-drawer__list">
          <TransferTaskList />
        </div>

        <footer className="transfer-drawer__note">
          <Info size={12} aria-hidden="true" />
          <span>
            不支持断点续传或自动重启恢复。应用退出后未完成的任务会在下次启动时标记为「已中断」并保留结果未知提示；请刷新目标目录核实后重新发起。取消和失败会清理本任务创建的临时文件，退出时只进行有界清理。
          </span>
        </footer>
      </aside>
    </>,
    document.body,
  )
}
