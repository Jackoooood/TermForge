import type { SshSessionStatus } from '@shared/types'
import { cn } from '@renderer/lib/utils'

export type StatusTone = SshSessionStatus | 'not-connected' | 'online'

const STATUS_LABELS: Record<StatusTone, string> = {
  idle: '尚未连接',
  connecting: '连接中',
  authenticating: '正在认证',
  'awaiting-host-key': '等待主机密钥确认',
  connected: '已连接',
  reconnecting: '正在重新连接',
  closing: '正在断开',
  disconnected: '已断开',
  error: '连接失败',
  'not-connected': '未连接',
  online: '在线',
}

const STATUS_CLASS: Record<StatusTone, string> = {
  idle: 'status-dot--muted',
  connecting: 'status-dot--warning',
  authenticating: 'status-dot--warning',
  'awaiting-host-key': 'status-dot--warning',
  connected: 'status-dot--success',
  reconnecting: 'status-dot--warning',
  closing: 'status-dot--warning',
  disconnected: 'status-dot--muted',
  error: 'status-dot--danger',
  'not-connected': 'status-dot--muted',
  online: 'status-dot--success',
}

interface StatusDotProps {
  status: StatusTone
  label?: string
  className?: string
}

export function StatusDot({ status, label, className }: StatusDotProps) {
  const text = label ?? STATUS_LABELS[status]
  return (
    <span
      className={cn('status-dot', STATUS_CLASS[status], className)}
      title={text}
      aria-hidden="true"
    />
  )
}

export function statusLabel(status: StatusTone): string {
  return STATUS_LABELS[status]
}
