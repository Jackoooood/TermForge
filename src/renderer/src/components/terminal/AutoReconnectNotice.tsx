import { useEffect, useState } from 'react'
import { Clock3, LoaderCircle, ShieldAlert } from 'lucide-react'
import type { SessionInfo } from '@shared/types'
import { Button } from '@renderer/components/common/Button'

interface AutoReconnectNoticeProps {
  session: SessionInfo
  onCancel: () => void
}

function remainingSeconds(nextRetryAt: string): number {
  const remaining = new Date(nextRetryAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(remaining / 1_000))
}

export function AutoReconnectNotice({ session, onCancel }: AutoReconnectNoticeProps) {
  const autoReconnect = session.autoReconnect
  const nextRetryAt = autoReconnect?.nextRetryAt ?? null
  const [seconds, setSeconds] = useState<number | null>(() =>
    nextRetryAt ? remainingSeconds(nextRetryAt) : null,
  )

  useEffect(() => {
    if (!nextRetryAt) {
      setSeconds(null)
      return
    }
    const update = (): void => setSeconds(remainingSeconds(nextRetryAt))
    update()
    const timer = setInterval(update, 500)
    return () => clearInterval(timer)
  }, [nextRetryAt])

  if (!autoReconnect) return null

  if (autoReconnect.exhausted) {
    return (
      <div
        className="terminal-auto-reconnect terminal-auto-reconnect--exhausted"
        role="status"
        aria-live="polite"
      >
        <ShieldAlert size={14} aria-hidden="true" />
        <div className="terminal-auto-reconnect__body">
          <p className="terminal-auto-reconnect__title">自动重连已停止</p>
          <p className="terminal-auto-reconnect__description">
            已自动尝试 {autoReconnect.maxAttempts}{' '}
            次仍未成功。请检查网络或服务器状态后手动重新连接。
          </p>
        </div>
      </div>
    )
  }

  const inFlight = session.status === 'reconnecting'
  return (
    <div className="terminal-auto-reconnect" role="status" aria-live="polite">
      {inFlight ? (
        <LoaderCircle className="spin" size={14} aria-hidden="true" />
      ) : (
        <Clock3 size={14} aria-hidden="true" />
      )}
      <div className="terminal-auto-reconnect__body">
        <p className="terminal-auto-reconnect__title">
          {inFlight ? '正在自动重连' : '等待自动重连'}
        </p>
        <p className="terminal-auto-reconnect__description">
          {inFlight
            ? `第 ${autoReconnect.attempt}/${autoReconnect.maxAttempts} 次自动尝试正在重新执行 SSH 认证与主机密钥校验；不会恢复旧的远程 Shell 或重放输入。`
            : `将在 ${seconds ?? 0} 秒后进行第 ${autoReconnect.attempt}/${autoReconnect.maxAttempts} 次自动尝试。仅重试网络类错误，不会重放输入或自动信任新主机密钥。`}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {inFlight ? '取消自动重连' : '停止自动重连'}
      </Button>
    </div>
  )
}
