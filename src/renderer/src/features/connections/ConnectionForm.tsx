import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Info, Lock, X } from 'lucide-react'
import { MAX_JUMP_HOPS, MAX_TAGS } from '@shared/constants/app'
import type { ConnectionFormValues } from '@shared/schemas/connection'
import { connectionFormSchema, toConnectionFieldErrors } from '@shared/schemas/connection'
import type {
  AuthMethod,
  ConnectionGroup,
  ConnectionInput,
  ConnectionProfile,
  ConnectionTag,
} from '@shared/types'
import { AUTH_METHODS } from '@shared/types/connection'
import type { ConnectionFieldErrors } from '@shared/schemas/connection'
import { Button } from '@renderer/components/common/Button'
import { cn } from '@renderer/lib/utils'

const AUTH_METHOD_LABELS: Record<AuthMethod, string> = {
  password: 'Password',
  privateKey: 'Private Key',
  sshAgent: 'SSH Agent',
}

const AUTH_NOTES: Record<AuthMethod, string> = {
  password:
    '密码不会写入连接配置。首次连接时由主进程提示输入，并保存到操作系统凭据存储。',
  privateKey:
    '可填写私钥文件路径（由主进程读取），或留空以在连接时粘贴私钥并存入操作系统凭据存储。私钥内容不会写入配置文件。',
  sshAgent:
    '通过系统 SSH Agent 认证；Windows 使用 OpenSSH Agent 命名管道，未检测到 Agent 时会明确失败。',
}

interface ConnectionFormProps {
  formId: string
  mode: 'create' | 'edit'
  connection?: ConnectionProfile
  groups: ConnectionGroup[]
  tags: ConnectionTag[]
  /** All saved connections; the edited connection itself is excluded from jump candidates. */
  connections: ConnectionProfile[]
  onSubmit: (input: ConnectionInput) => Promise<void>
  onCancel: () => void
}

function emptyValues(groups: ConnectionGroup[]): ConnectionFormValues {
  return {
    name: '',
    host: '',
    port: '22',
    username: '',
    authMethod: 'password',
    groupId: groups[0]?.id ?? '',
    tagIds: [],
    credentialRef: '',
    jumpConnectionIds: [],
  }
}

function toFormValues(connection: ConnectionProfile): ConnectionFormValues {
  return {
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    username: connection.username,
    authMethod: connection.authMethod,
    groupId: connection.groupId ?? '',
    tagIds: [...connection.tagIds],
    credentialRef: connection.credentialRef ?? '',
    jumpConnectionIds: [...connection.jumpConnectionIds],
  }
}

export function ConnectionForm({
  formId,
  mode,
  connection,
  groups,
  tags,
  connections,
  onSubmit,
  onCancel,
}: ConnectionFormProps) {
  const uid = useId()
  const [values, setValues] = useState<ConnectionFormValues>(() =>
    connection ? toFormValues(connection) : emptyValues(groups),
  )
  const [errors, setErrors] = useState<ConnectionFieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [jumpCandidateId, setJumpCandidateId] = useState('')
  const id = (name: keyof ConnectionFieldErrors): string => `${formId}-${name}`
  const authMethod = values.authMethod as AuthMethod
  const showCredentialRef = authMethod === 'privateKey' || authMethod === 'sshAgent'
  const connectionById = new Map(connections.map((item) => [item.id, item]))
  const jumpCandidates = connections.filter(
    (item) =>
      item.id !== connection?.id && !values.jumpConnectionIds.includes(item.id),
  )
  const jumpAtLimit = values.jumpConnectionIds.length >= MAX_JUMP_HOPS
  const jumpPath = [
    '本机',
    ...values.jumpConnectionIds.map((jumpId) => connectionById.get(jumpId)?.name ?? jumpId),
    values.name.trim() || '目标服务器',
  ].join(' → ')

  const moveJump = (index: number, delta: number): void => {
    const next = [...values.jumpConnectionIds]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    update('jumpConnectionIds', next)
  }

  const removeJump = (jumpId: string): void => {
    update(
      'jumpConnectionIds',
      values.jumpConnectionIds.filter((item) => item !== jumpId),
    )
  }

  const addJump = (): void => {
    if (!jumpCandidateId || jumpAtLimit) return
    if (values.jumpConnectionIds.includes(jumpCandidateId)) return
    update('jumpConnectionIds', [...values.jumpConnectionIds, jumpCandidateId])
    setJumpCandidateId('')
  }

  const update = <K extends keyof ConnectionFormValues>(
    key: K,
    value: ConnectionFormValues[K],
  ): void => {
    setValues((current) => ({ ...current, [key]: value }))
    setErrors((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key as keyof ConnectionFieldErrors]
      return next
    })
    setFormError(null)
    setSubmitError(null)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (submitting) return

    const result = connectionFormSchema.safeParse(values)
    if (!result.success) {
      const nextErrors = toConnectionFieldErrors(result.error)
      setErrors(nextErrors)
      setFormError('无法保存连接，请检查标出的字段。')
      setSubmitError(null)
      const firstKey = Object.keys(nextErrors)[0]
      if (firstKey) {
        window.requestAnimationFrame(() => {
          document.getElementById(id(firstKey as keyof ConnectionFieldErrors))?.focus()
        })
      }
      return
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      await onSubmit(result.data)
    } catch (error) {
      setSubmitError(
        error instanceof Error && error.message
          ? error.message
          : '连接配置未能写入本机存储，请稍后重试。',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="connection-form"
      id={formId}
      noValidate
      onSubmit={(event) => void handleSubmit(event)}
    >
      {formError || submitError ? (
        <div className="form-error-summary" role="alert">
          <Info size={13} aria-hidden="true" />
          <span>{formError ?? submitError}</span>
        </div>
      ) : null}

      <div className="form-grid">
        <div className="field field--full">
          <label className="field__label" htmlFor={id('name')}>
            连接名称{' '}
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id={id('name')}
            className="text-input"
            type="text"
            autoComplete="off"
            value={values.name}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? `${id('name')}-error` : undefined}
            placeholder="例如 prod-web-01"
            onChange={(event) => update('name', event.target.value)}
          />
          {errors.name ? (
            <p className="field__error" id={`${id('name')}-error`} role="alert">
              {errors.name}
            </p>
          ) : null}
        </div>

        <div className="form-row-3 field--full">
          <div className="field">
            <label className="field__label" htmlFor={id('host')}>
              主机{' '}
              <span className="field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={id('host')}
              className="text-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={values.host}
              aria-invalid={Boolean(errors.host)}
              aria-describedby={errors.host ? `${id('host')}-error` : `${id('host')}-hint`}
              placeholder="IP 或主机名，不含端口"
              onChange={(event) => update('host', event.target.value)}
            />
            {errors.host ? (
              <p className="field__error" id={`${id('host')}-error`} role="alert">
                {errors.host}
              </p>
            ) : (
              <p className="field__hint" id={`${id('host')}-hint`}>
                支持主机名、IPv4 与 IPv6
              </p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor={id('port')}>
              端口{' '}
              <span className="field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={id('port')}
              className="text-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={values.port}
              aria-invalid={Boolean(errors.port)}
              aria-describedby={errors.port ? `${id('port')}-error` : undefined}
              placeholder="22"
              onChange={(event) => update('port', event.target.value)}
            />
            {errors.port ? (
              <p className="field__error" id={`${id('port')}-error`} role="alert">
                {errors.port}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor={id('username')}>
              用户名{' '}
              <span className="field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={id('username')}
              className="text-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={values.username}
              aria-invalid={Boolean(errors.username)}
              aria-describedby={errors.username ? `${id('username')}-error` : undefined}
              placeholder="例如 deploy"
              onChange={(event) => update('username', event.target.value)}
            />
            {errors.username ? (
              <p className="field__error" id={`${id('username')}-error`} role="alert">
                {errors.username}
              </p>
            ) : null}
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={id('authMethod')}>
            认证方式{' '}
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <select
            id={id('authMethod')}
            className="select"
            value={values.authMethod}
            aria-invalid={Boolean(errors.authMethod)}
            onChange={(event) => update('authMethod', event.target.value as AuthMethod)}
          >
            {AUTH_METHODS.map((method) => (
              <option key={method} value={method}>
                {AUTH_METHOD_LABELS[method]}
              </option>
            ))}
          </select>
          {errors.authMethod ? (
            <p className="field__error" role="alert">
              {errors.authMethod}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={id('groupId')}>
            分组
          </label>
          <select
            id={id('groupId')}
            className="select"
            value={values.groupId}
            aria-invalid={Boolean(errors.groupId)}
            onChange={(event) => update('groupId', event.target.value)}
          >
            <option value="">未分组</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          {errors.groupId ? (
            <p className="field__error" role="alert">
              {errors.groupId}
            </p>
          ) : null}
        </div>

        <div className="field field--full">
          <span className="field__label" id={`${id('tagIds')}-label`}>
            标签
          </span>
          <div
            className="tag-picker"
            id={id('tagIds')}
            role="group"
            tabIndex={-1}
            aria-labelledby={`${id('tagIds')}-label`}
            aria-invalid={Boolean(errors.tagIds)}
            aria-describedby={errors.tagIds ? `${id('tagIds')}-error` : `${id('tagIds')}-hint`}
          >
            {tags.length === 0 ? (
              <span className="field__hint">暂无可用标签。</span>
            ) : (
              tags.map((tag) => {
                const checked = values.tagIds.includes(tag.id)
                return (
                  <label
                    className={cn('tag-picker__option', checked && 'tag-picker__option--checked')}
                    key={tag.id}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && values.tagIds.length >= MAX_TAGS}
                      onChange={(event) =>
                        update(
                          'tagIds',
                          event.target.checked
                            ? [...values.tagIds, tag.id]
                            : values.tagIds.filter((tagId) => tagId !== tag.id),
                        )
                      }
                    />
                    <span>{tag.name}</span>
                  </label>
                )
              })
            )}
          </div>
          {errors.tagIds ? (
            <p className="field__error" id={`${id('tagIds')}-error`} role="alert">
              {errors.tagIds}
            </p>
          ) : (
            <p className="field__hint" id={`${id('tagIds')}-hint`}>
              从标签目录中选择，最多 {MAX_TAGS} 个。
            </p>
          )}
        </div>

        <div className="auth-note field--full">
          <Lock size={13} aria-hidden="true" />
          <span>{AUTH_NOTES[authMethod]}</span>
        </div>

        {showCredentialRef ? (
          <div className="field field--full">
            <label className="field__label" htmlFor={id('credentialRef')}>
              私钥路径或凭据引用
            </label>
            <input
              id={id('credentialRef')}
              className="text-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={values.credentialRef}
              aria-invalid={Boolean(errors.credentialRef)}
              placeholder={
                authMethod === 'privateKey'
                  ? '~/.ssh/id_ed25519 或 vault://team/key'
                  : 'ssh-agent:default（可选）'
              }
              onChange={(event) => update('credentialRef', event.target.value)}
            />
            {errors.credentialRef ? (
              <p className="field__error" role="alert">
                {errors.credentialRef}
              </p>
            ) : (
              <p className="field__hint">
                {authMethod === 'privateKey'
                  ? '路径由主进程读取，内容不会写入配置；留空则在连接时提示提供私钥。'
                  : '可选引用；认证由系统 SSH Agent 完成。'}
              </p>
            )}
          </div>
        ) : null}
      </div>

      <div className="form-section">
        <button
          type="button"
          className="advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span>高级选项</span>
          <ChevronDown
            className={cn(
              'advanced-toggle__chevron',
              advancedOpen && 'advanced-toggle__chevron--open',
            )}
            size={14}
            aria-hidden="true"
          />
        </button>
        {advancedOpen ? (
          <div className="advanced-panel">
            <div className="form-grid">
              <div className="field">
                <label className="field__label" htmlFor={`${uid}-keepalive`}>
                  保持连接间隔
                </label>
                <select id={`${uid}-keepalive`} className="select" disabled defaultValue="30">
                  <option value="30">30 秒（固定）</option>
                </select>
              </div>
            </div>

            <div className="field field--full" id={id('jumpConnectionIds')} tabIndex={-1}>
              <label className="field__label" htmlFor={`${uid}-jump-add`}>
                跳板机 / ProxyJump
              </label>

              {values.jumpConnectionIds.length === 0 ? (
                <p className="field__hint">未配置跳板：将直接连接目标服务器。</p>
              ) : (
                <ol className="jump-chain" aria-label="跳板连接顺序">
                  {values.jumpConnectionIds.map((jumpId, index) => {
                    const jump = connectionById.get(jumpId)
                    const label = jump?.name ?? jumpId
                    return (
                      <li key={jumpId} className="jump-chain__item">
                        <span className="jump-chain__order" aria-hidden="true">
                          {index + 1}
                        </span>
                        <span className="jump-chain__body">
                          <span className="jump-chain__name">{label}</span>
                          <span className="jump-chain__meta">
                            {jump
                              ? `${jump.username}@${jump.host}:${jump.port} · ${AUTH_METHOD_LABELS[jump.authMethod]}`
                              : '引用的连接不存在，请在保存前移除。'}
                          </span>
                        </span>
                        <span className="jump-chain__actions">
                          <button
                            type="button"
                            className="jump-chain__action"
                            disabled={index === 0}
                            aria-label={`将跳板 ${label} 上移`}
                            onClick={() => moveJump(index, -1)}
                          >
                            <ArrowUp size={12} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="jump-chain__action"
                            disabled={index === values.jumpConnectionIds.length - 1}
                            aria-label={`将跳板 ${label} 下移`}
                            onClick={() => moveJump(index, 1)}
                          >
                            <ArrowDown size={12} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="jump-chain__action jump-chain__action--danger"
                            aria-label={`移除跳板 ${label}`}
                            onClick={() => removeJump(jumpId)}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </span>
                      </li>
                    )
                  })}
                </ol>
              )}

              <div className="jump-chain__add">
                <select
                  id={`${uid}-jump-add`}
                  className="select"
                  value={jumpCandidateId}
                  disabled={jumpAtLimit || jumpCandidates.length === 0}
                  aria-label="选择要添加的跳板连接"
                  onChange={(event) => setJumpCandidateId(event.target.value)}
                >
                  <option value="">
                    {jumpCandidates.length === 0
                      ? '没有可添加的已保存连接'
                      : '选择要添加的跳板连接…'}
                  </option>
                  {jumpCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name} · {candidate.username}@{candidate.host}:{candidate.port}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={jumpCandidateId.length === 0 || jumpAtLimit}
                  onClick={addJump}
                >
                  添加
                </Button>
              </div>

              <p className="jump-chain__preview" aria-live="polite">
                连接路径：{jumpPath}
              </p>
              {errors.jumpConnectionIds ? (
                <p className="field__error" role="alert">
                  {errors.jumpConnectionIds}
                </p>
              ) : (
                <p className="field__hint">
                  按顺序从第 1 跳开始依次连接（最多 {MAX_JUMP_HOPS} 个）。每跳使用所选连接自身的认证方式与主机密钥信任记录，跳板被信任不会让目标服务器被自动信任。
                </p>
              )}
            </div>

            <p className="advanced-panel__note">
              SSH keepalive 固定为 30 秒；跳板链路在主进程建立，Socket 与转发通道不会进入渲染进程。
            </p>
          </div>
        ) : null}
      </div>

      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? '保存中…' : mode === 'create' ? '创建连接' : '保存修改'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
      </div>
    </form>
  )
}
