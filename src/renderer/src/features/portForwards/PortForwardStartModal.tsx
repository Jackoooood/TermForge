import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Info, ShieldAlert } from 'lucide-react'
import type { PortForwardItem, SessionInfo } from '@shared/types'
import { isLoopbackAddress } from '@shared/portForward/address'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useAppStore } from '@renderer/stores/appStore'
import { usePortForwardStore } from '@renderer/stores/portForwardStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'

interface StartCandidate {
  sessionId: string
  title: string
  host: string
  username: string
  active: boolean
  createdAt: string
}

function connectedSessionsFor(
  sessionsById: Record<string, SessionInfo>,
  connectionId: string,
  activeTabId: string | null,
): StartCandidate[] {
  const sessions = Object.values(sessionsById)
  const seen = new Set<string>()
  const candidates: StartCandidate[] = []
  for (const session of sessions) {
    if (session.connectionId !== connectionId) continue
    if (session.status !== 'connected' || !session.sessionId) continue
    if (seen.has(session.sessionId)) continue
    seen.add(session.sessionId)
    candidates.push({
      sessionId: session.sessionId,
      title: session.title,
      host: session.host,
      username: session.username,
      active: session.id === activeTabId,
      createdAt: session.createdAt,
    })
  }
  return candidates.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1
    return left.createdAt.localeCompare(right.createdAt)
  })
}

function exposureLabel(item: PortForwardItem): string {
  const rule = item.rule
  const endpoint = `${rule.type === 'remote' ? '远端服务器' : '本机'} ${rule.bindAddress}:${rule.bindPort}`
  return `该规则会在${endpoint}监听，非回环地址会向其他主机暴露端口。请确认这是你预期的行为。`
}

export function PortForwardStartModal() {
  const targetId = usePortForwardStore((state) => state.startTargetId)
  const cancelStart = usePortForwardStore((state) => state.cancelStart)
  const items = usePortForwardStore((state) => state.items)
  const item = targetId ? items.find((entry) => entry.rule.id === targetId) : undefined

  if (!item) return null
  return <StartDialog key={item.rule.id} item={item} onClose={cancelStart} />
}

function StartDialog({ item, onClose }: { item: PortForwardItem; onClose: () => void }) {
  const formId = `port-forward-start-${useId().replace(/:/g, '')}`
  const startRule = usePortForwardStore((state) => state.startRule)
  const pending = usePortForwardStore((state) => state.pending[item.rule.id])
  const activeTabId = useWorkspaceStore((state) => state.activeTabId)
  const sessions = useSessionStore((state) => state.sessions)
  const pushToast = useAppStore((state) => state.pushToast)
  const candidates = connectedSessionsFor(sessions, item.rule.connectionId, activeTabId)
  const exposureRequired =
    item.rule.type !== 'dynamic' && !isLoopbackAddress(item.rule.bindAddress)

  const [sessionId, setSessionId] = useState(candidates[0]?.sessionId ?? '')
  const [riskConfirmed, setRiskConfirmed] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const submitting = pending === 'start'
  const canSubmit =
    !submitting && sessionId.length > 0 && (!exposureRequired || riskConfirmed)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitError(null)
    try {
      const started = await startRule({
        ruleId: item.rule.id,
        sessionId,
        confirmExposure: exposureRequired && riskConfirmed,
      })
      if (started.runtime.status === 'error') {
        pushToast({
          tone: 'danger',
          title: '端口转发启动失败',
          description: started.runtime.failure?.message ?? '主进程未能建立监听器。',
        })
        return
      }
      pushToast({
        tone: 'success',
        title: '端口转发已启动',
        description: started.runtime.boundAddress
          ? `正在监听 ${started.runtime.boundAddress}:${started.runtime.boundPort ?? item.rule.bindPort}。`
          : '监听器已建立。',
      })
    } catch (error) {
      setSubmitError(
        error instanceof Error && error.message
          ? error.message
          : '端口转发未能启动，请稍后重试。',
      )
    }
  }

  return (
    <Modal
      title={`启动转发 · ${item.rule.name}`}
      description="转发必须绑定到一个已连接的真实 SSH 会话；应用不会自动连接、自动重连或静默切换会话。"
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={!canSubmit}
            title={candidates.length === 0 ? '请先在服务器页建立并保持 SSH 连接。' : undefined}
          >
            {submitting ? '启动中…' : '启动转发'}
          </Button>
          <Button variant="ghost" disabled={submitting} onClick={onClose}>
            取消
          </Button>
        </>
      }
    >
      <form className="connection-form" id={formId} onSubmit={(event) => void handleSubmit(event)}>
        <div className="delete-confirm__target">
          <span className="delete-confirm__icon" aria-hidden="true">
            <Info size={16} />
          </span>
          <div>
            <p className="delete-confirm__name">{item.rule.name}</p>
            <p className="delete-confirm__address">
              {item.rule.type === 'dynamic'
                ? `SOCKS5 127.0.0.1:${item.rule.bindPort}`
                : `${item.rule.bindAddress}:${item.rule.bindPort} → ${item.rule.targetHost}:${item.rule.targetPort}`}
            </p>
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${formId}-session`}>
            SSH 会话 <span className="field__required">*</span>
          </label>
          {candidates.length === 0 ? (
            <div className="form-error-summary" role="alert">
              <Info size={13} aria-hidden="true" />
              <span>
                当前没有该连接的活动 SSH 会话。请先在服务器页连接并等待状态变为“已连接”，再启动转发。
              </span>
            </div>
          ) : (
            <>
              <select
                id={`${formId}-session`}
                className="select"
                value={sessionId}
                disabled={submitting}
                onChange={(event) => setSessionId(event.target.value)}
              >
                {candidates.map((candidate) => (
                  <option key={candidate.sessionId} value={candidate.sessionId}>
                    {candidate.title} · {candidate.username}@{candidate.host}
                    {candidate.active ? '（当前标签）' : ''}
                  </option>
                ))}
              </select>
              <p className="field__hint">
                会话断开后规则会自动停止，不会在重连后静默重新启动或改用新的会话。
              </p>
            </>
          )}
        </div>

        {exposureRequired ? (
          <div className="forward-exposure">
            <div className="delete-confirm__note" role="alert">
              <ShieldAlert size={13} aria-hidden="true" />
              <span>{exposureLabel(item)}</span>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={riskConfirmed}
                disabled={submitting}
                onChange={(event) => setRiskConfirmed(event.target.checked)}
              />
              <span>我已确认该监听地址的暴露范围，并理解这台主机可能被同一网络中的其他设备访问。</span>
            </label>
          </div>
        ) : null}

        {submitError ? (
          <div className="form-error-summary" role="alert">
            <Info size={13} aria-hidden="true" />
            <span>{submitError}</span>
          </div>
        ) : null}
      </form>
    </Modal>
  )
}
