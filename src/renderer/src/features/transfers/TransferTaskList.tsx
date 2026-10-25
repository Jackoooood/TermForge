import { useEffect, useId, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  RotateCcw,
} from 'lucide-react'
import { getLocalFileNameError } from '@shared/transfer/localFileName'
import { getRemoteEntryNameError } from '@shared/sftp/remotePath'
import { isActiveTransferStatus } from '@shared/types'
import type {
  TransferConflictPolicy,
  TransferErrorCode,
  TransferStatus,
  TransferTask,
} from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import type { BadgeTone } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { useAppStore } from '@renderer/stores/appStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import { cn, formatBytes } from '@renderer/lib/utils'

const STATUS_LABELS: Record<TransferStatus, string> = {
  queued: '排队中',
  preparing: '准备中',
  waitingForConflictResolution: '待处理冲突',
  transferring: '传输中',
  cancelling: '正在取消',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
  interrupted: '已中断',
}

const STATUS_TONES: Record<TransferStatus, BadgeTone> = {
  queued: 'neutral',
  preparing: 'primary',
  waitingForConflictResolution: 'warning',
  transferring: 'primary',
  cancelling: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
  interrupted: 'warning',
}

function errorGuidance(code: TransferErrorCode | null): string | null {
  switch (code) {
    case 'source-missing':
      return '源文件已不存在，请重新选择。'
    case 'source-changed':
      return '源文件在传输期间发生变化，已拒绝完成。'
    case 'source-not-file':
      return '源路径不是可以传输的普通文件。'
    case 'destination-unavailable':
      return '目标目录不可用，请确认权限或重新选择。'
    case 'connection-lost':
      return 'SSH 会话已断开，请重连后再重试。'
    case 'target-changed':
      return '目标在提交前发生变化，请核实后重试。'
    case 'cleanup-failed':
      return '临时文件未能全部清理，请检查目标目录中的 .termforge-* 文件。'
    case 'outcome-unknown':
      return '无法确认服务器状态，请刷新目录核实后再重试。'
    case 'permission-denied':
      return '当前 SSH 用户没有足够的权限。'
    case 'timeout':
      return '操作超时，请确认网络后重试。'
    default:
      return null
  }
}

function progressText(task: TransferTask): string {
  if (task.status === 'completed') return '100%'
  if (task.progress !== null) return `${task.progress}%`
  if (task.status === 'transferring' || task.status === 'preparing') return '进度未知'
  if (task.status === 'interrupted') return '结果未知'
  return '—'
}

function ConflictResolver({ task }: { task: TransferTask }) {
  const inputId = useId()
  const resolveTaskConflict = useTransferStore((state) => state.resolveTaskConflict)
  const conflict = task.conflict
  const [name, setName] = useState(conflict?.suggestedName ?? '')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<TransferConflictPolicy | null>(null)

  useEffect(() => {
    setName(conflict?.suggestedName ?? '')
    setFieldError(null)
    setRequestError(null)
    setSubmitting(null)
  }, [task.id, conflict?.targetPath, conflict?.suggestedName])

  if (!conflict) return null

  const resolve = async (choice: TransferConflictPolicy): Promise<void> => {
    if (submitting) return
    const candidate = name.trim()
    if (choice === 'rename') {
      const validation =
        task.direction === 'upload'
          ? getRemoteEntryNameError(candidate)
          : getLocalFileNameError(candidate)
      if (validation) {
        setFieldError(validation)
        return
      }
    }
    setFieldError(null)
    setRequestError(null)
    setSubmitting(choice)
    const result = await resolveTaskConflict(
      task.id,
      choice,
      choice === 'rename' ? candidate : undefined,
    )
    if (!result.ok) {
      setRequestError(result.error.message)
      setSubmitting(null)
    }
  }

  return (
    <div className="transfer-conflict" role="group" aria-label="处理文件冲突">
      <div className="transfer-conflict__head">
        <AlertTriangle size={12} aria-hidden="true" />
        <span>目标已存在，选择本次处理方式</span>
      </div>
      <p className="transfer-conflict__target" title={conflict.targetPath}>
        {conflict.targetPath}
      </p>
      <div className="field transfer-conflict__field">
        <label className="field__label" htmlFor={inputId}>
          重命名后的文件名
        </label>
        <input
          id={inputId}
          className="text-input"
          value={name}
          disabled={submitting !== null}
          aria-invalid={Boolean(fieldError)}
          onChange={(event) => {
            setName(event.target.value)
            setFieldError(null)
            setRequestError(null)
          }}
        />
        {fieldError ? (
          <p className="field__error" role="alert">
            {fieldError}
          </p>
        ) : null}
      </div>
      <div className="transfer-conflict__actions">
        <Button
          size="sm"
          variant="danger"
          disabled={submitting !== null}
          onClick={() => void resolve('overwrite')}
        >
          {submitting === 'overwrite' ? '覆盖中…' : '覆盖'}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={submitting !== null}
          onClick={() => void resolve('rename')}
        >
          {submitting === 'rename' ? '重命名中…' : '重命名'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={submitting !== null}
          onClick={() => void resolve('skip')}
        >
          {submitting === 'skip' ? '跳过中…' : '跳过'}
        </Button>
      </div>
      <p className="transfer-conflict__hint">
        覆盖会先写入同目录临时文件，再替换目标；不会直接删除现有文件。服务器状态在提交前会再次检查。
      </p>
      {requestError ? (
        <p className="transfer-conflict__error" role="alert">
          {requestError}
        </p>
      ) : null}
    </div>
  )
}

function TransferTaskRow({ task }: { task: TransferTask }) {
  const cancelTask = useTransferStore((state) => state.cancelTask)
  const retryTask = useTransferStore((state) => state.retryTask)
  const pushToast = useAppStore((state) => state.pushToast)
  const [busy, setBusy] = useState(false)

  const active = isActiveTransferStatus(task.status)
  const DirectionIcon = task.direction === 'upload' ? ArrowUpFromLine : ArrowDownToLine
  const indeterminate = task.status === 'transferring' && task.progress === null
  const progressValue = task.status === 'completed' ? 100 : (task.progress ?? 0)
  const guidance = errorGuidance(task.errorCode)
  const sourceLabel = task.direction === 'upload' ? '本地' : '远程'
  const destinationLabel = task.direction === 'upload' ? '远程' : '本地'

  const cancel = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const result = await cancelTask(task.id)
    setBusy(false)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法取消传输', description: result.error.message })
    }
  }

  const retry = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const result = await retryTask(task.id)
    setBusy(false)
    if (!result.ok) {
      pushToast({ tone: 'danger', title: '无法重试传输', description: result.error.message })
    }
  }

  return (
    <article
      className="transfer-task"
      aria-label={`${task.fileName} ${STATUS_LABELS[task.status]}`}
    >
      <div className="transfer-task__head">
        <span
          className={cn(
            'transfer-task__direction',
            task.direction === 'download' && 'transfer-task__direction--download',
          )}
          title={task.direction === 'upload' ? '上传' : '下载'}
        >
          <DirectionIcon size={12} aria-hidden="true" />
        </span>
        <span className="transfer-task__name" title={task.fileName}>
          {task.fileName}
        </span>
        <Badge tone={STATUS_TONES[task.status]}>{STATUS_LABELS[task.status]}</Badge>
      </div>

      <div className="transfer-task__paths">
        <span title={task.sourcePath}>
          {sourceLabel}：{task.sourcePath}
        </span>
        <span title={task.destinationPath}>
          {destinationLabel}：{task.destinationPath}
        </span>
      </div>

      <div
        className={cn('transfer-progress', indeterminate && 'transfer-progress--indeterminate')}
        role="progressbar"
        aria-label={`${task.fileName} 传输进度`}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuenow={indeterminate ? undefined : progressValue}
      >
        <div
          className={cn(
            'transfer-progress__bar',
            task.status === 'completed' && 'transfer-progress__bar--completed',
            task.status === 'failed' && 'transfer-progress__bar--failed',
            (task.status === 'cancelled' ||
              task.status === 'skipped' ||
              task.status === 'interrupted') &&
              'transfer-progress__bar--muted',
            indeterminate && 'transfer-progress__bar--indeterminate',
          )}
          style={indeterminate ? undefined : { width: `${progressValue}%` }}
        />
      </div>

      <div className="transfer-task__meta">
        <span>
          {formatBytes(task.transferredBytes)} /{' '}
          {task.totalBytes === null ? '大小未知' : formatBytes(task.totalBytes)} ·{' '}
          {progressText(task)}
        </span>
        <span>
          {task.status === 'transferring' && task.speedBytesPerSecond !== null
            ? `${formatBytes(task.speedBytesPerSecond)}/s`
            : task.direction === 'upload'
              ? '上传'
              : '下载'}
          {task.attempt > 1 ? ` · 第 ${task.attempt} 次尝试` : ''}
        </span>
      </div>

      {task.status === 'waitingForConflictResolution' ? <ConflictResolver task={task} /> : null}

      {task.errorMessage ? (
        <p className="transfer-task__error" role="status">
          {task.errorMessage}
          {guidance ? ` ${guidance}` : ''}
        </p>
      ) : null}

      {active || task.status === 'failed' || task.status === 'cancelled' ? (
        <div className="transfer-task__actions">
          {active && task.status !== 'cancelling' ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
              取消
            </Button>
          ) : null}
          {task.status === 'cancelling' ? (
            <span className="transfer-task__pending">等待主进程停止…</span>
          ) : null}
          {task.status === 'failed' || task.status === 'cancelled' ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retry()}>
              <RotateCcw size={11} aria-hidden="true" />
              {busy ? '重试中…' : '重试'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

export function TransferTaskList() {
  const tasks = useTransferStore((state) => state.tasks)

  if (tasks.length === 0) {
    return (
      <div className="transfer-empty">
        <ArrowUpDown size={25} strokeWidth={1.5} aria-hidden="true" />
        <span>队列为空</span>
        <span className="transfer-empty__hint">
          在 SFTP 面板或 SFTP 页选择文件上传/下载，任务会出现在这里。
        </span>
      </div>
    )
  }
  return (
    <div className="transfer-list">
      {tasks.map((task) => (
        <TransferTaskRow key={task.id} task={task} />
      ))}
    </div>
  )
}
