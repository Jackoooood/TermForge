import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { KeyRound, Lock, ShieldCheck } from 'lucide-react'
import type { SshCredentialKind } from '@shared/types'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useAppStore } from '@renderer/stores/appStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSshPromptStore } from '@renderer/stores/sshPromptStore'

const KIND_TITLES: Record<SshCredentialKind, string> = {
  password: '输入登录密码',
  privateKey: '提供私钥内容',
  passphrase: '输入私钥口令',
}

const KIND_HINTS: Record<SshCredentialKind, string> = {
  password: '密码只会经 IPC 写入操作系统凭据存储，不会进入渲染进程状态、配置文件或日志。',
  privateKey:
    '粘贴完整的 OpenSSH 或 PEM 私钥内容。私钥经 IPC 直接写入系统凭据存储，不会写入普通配置。',
  passphrase: '该私钥已加密，需要口令才能解密。口令由主进程读取，不会保存到渲染进程状态。',
}

const KIND_LABELS: Record<SshCredentialKind, string> = {
  password: '密码',
  privateKey: '私钥',
  passphrase: '私钥口令',
}

export function CredentialPromptModal() {
  const prompt = useSshPromptStore((state) => state.credentialPrompt)
  const closeCredentialPrompt = useSshPromptStore((state) => state.closeCredentialPrompt)
  const formId = useId()
  const secretRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!prompt) return null

  const close = (): void => {
    if (submitting) return
    if (secretRef.current) secretRef.current.value = ''
    setError(null)
    closeCredentialPrompt()
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (submitting) return

    const element = secretRef.current
    const secret = element?.value ?? ''
    if (element) element.value = ''
    if (secret.length === 0) {
      setError(`请输入${KIND_LABELS[prompt.kind]}。`)
      return
    }

    const bridge = window.termforge
    if (!bridge) {
      setError('未加载 Electron preload bridge，无法保存凭据。')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const result = await bridge.ssh.saveCredential({
        connectionId: prompt.connectionId,
        kind: prompt.kind,
        secret,
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }

      closeCredentialPrompt()
      useAppStore.getState().pushToast({
        tone: 'success',
        title: '凭据已保存',
        description: `正在使用新的${KIND_LABELS[prompt.kind]}重新连接 ${prompt.connectionName}。`,
      })

      const store = useSessionStore.getState()
      if (store.sessions[prompt.tabId]) {
        void store.reconnectSession(prompt.tabId)
      } else {
        void store.openSession({ id: prompt.connectionId, name: prompt.connectionName })
      }
    } catch {
      setError('保存凭据时发生错误，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={
        prompt.hopIndex ? `跳板 ${prompt.hopIndex} · ${KIND_TITLES[prompt.kind]}` : KIND_TITLES[prompt.kind]
      }
      description={`${prompt.username}@${prompt.host}:${prompt.port} · ${prompt.connectionName}`}
      width={560}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" disabled={submitting} onClick={close}>
            取消
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={submitting}>
            <ShieldCheck size={13} aria-hidden="true" />
            {submitting ? '保存中…' : '保存并重新连接'}
          </Button>
        </>
      }
    >
      <form className="connection-form" id={formId} noValidate onSubmit={(event) => void submit(event)}>
        <div className="form-error-summary" role="alert">
          <Lock size={13} aria-hidden="true" />
          <span>{prompt.message}</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`${formId}-secret`}>
            {KIND_LABELS[prompt.kind]}{' '}
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          {prompt.kind === 'privateKey' ? (
            <textarea
              id={`${formId}-secret`}
              ref={(element) => {
                secretRef.current = element
              }}
              className="text-input credential-prompt__key"
              autoComplete="off"
              spellCheck={false}
              rows={9}
              aria-invalid={Boolean(error)}
              aria-describedby={`${formId}-hint`}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
          ) : (
            <input
              id={`${formId}-secret`}
              ref={(element) => {
                secretRef.current = element
              }}
              className="text-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby={`${formId}-hint`}
              placeholder={prompt.kind === 'password' ? '输入登录密码' : '输入私钥口令'}
            />
          )}
          <p className="field__hint" id={`${formId}-hint`}>
            {KIND_HINTS[prompt.kind]}
          </p>
        </div>

        {error ? (
          <div className="form-error-summary" role="alert">
            <KeyRound size={13} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
      </form>
    </Modal>
  )
}
