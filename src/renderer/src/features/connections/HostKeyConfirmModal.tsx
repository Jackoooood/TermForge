import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useSshPromptStore } from '@renderer/stores/sshPromptStore'

export function HostKeyConfirmModal() {
  const challenge = useSshPromptStore((state) => state.hostKeyQueue[0] ?? null)
  const submitting = useSshPromptStore((state) => state.hostKeySubmitting)
  const error = useSshPromptStore((state) => state.hostKeyError)
  const resolveHostKey = useSshPromptStore((state) => state.resolveHostKey)

  if (!challenge) return null

  const hop = challenge.hop ?? null

  const reject = (): void => {
    if (submitting) return
    void resolveHostKey(challenge.requestId, false)
  }

  const accept = (): void => {
    if (submitting) return
    void resolveHostKey(challenge.requestId, true)
  }

  return (
    <Modal
      title="确认服务器主机密钥"
      description={
        hop
          ? `首次连接跳板 ${hop.index}（${hop.name}，${challenge.host}:${challenge.port}），用于连接 ${challenge.connectionName}。连接会在你做出明确选择前保持暂停。`
          : `首次连接到 ${challenge.connectionName}（${challenge.host}:${challenge.port}）。连接会在你做出明确选择前保持暂停。`
      }
      width={540}
      onClose={reject}
      footer={
        <>
          <Button variant="ghost" disabled={submitting} onClick={reject}>
            拒绝并断开
          </Button>
          <Button variant="primary" disabled={submitting} onClick={accept}>
            <ShieldCheck size={13} aria-hidden="true" />
            {submitting ? '正在提交…' : '信任并继续'}
          </Button>
        </>
      }
    >
      <div className="host-key-confirm">
        <div className="host-key-confirm__algorithm">
          <ShieldAlert size={16} aria-hidden="true" />
          <div>
            <p className="host-key-confirm__label">主机密钥指纹</p>
            <code className="host-key-confirm__fingerprint">{challenge.fingerprint}</code>
          </div>
        </div>

        <dl className="host-key-confirm__meta">
          <div>
            <dt>服务器</dt>
            <dd>
              {challenge.host}:{challenge.port}
            </dd>
          </div>
          {hop ? (
            <div>
              <dt>跳板</dt>
              <dd>
                第 {hop.index} 跳 · {hop.name}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>算法</dt>
            <dd>{challenge.algorithm}</dd>
          </div>
        </dl>

        <p className="host-key-confirm__warning">
          请通过可信渠道核对指纹。指纹不一致可能意味着服务器已被替换或存在中间人攻击。关闭此窗口等同于拒绝，不会信任该密钥。
          {hop ? ' 该信任仅适用于此跳板；最终目标仍会单独要求确认。' : ''}
        </p>

        {error ? (
          <div className="form-error-summary" role="alert">
            <ShieldAlert size={13} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
