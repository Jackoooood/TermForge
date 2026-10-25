import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeftRight, Info } from 'lucide-react'
import type {
  PortForwardCreateInput,
  PortForwardItem,
  PortForwardRule,
  PortForwardType,
  PortForwardUpdateInput,
} from '@shared/types'
import { isLoopbackAddress } from '@shared/portForward/address'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useAppStore } from '@renderer/stores/appStore'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { usePortForwardStore } from '@renderer/stores/portForwardStore'

const TYPE_LABELS: Record<PortForwardType, string> = {
  local: '本地转发 (-L)',
  remote: '远程转发 (-R)',
  dynamic: '动态 SOCKS5 (-D)',
}

const TYPE_NOTES: Record<PortForwardType, string> = {
  local:
    '本机监听端口，经当前 SSH 会话转发到目标地址。监听地址默认 127.0.0.1；填写非回环地址时，启动前必须确认暴露风险。',
  remote:
    '请求 SSH 服务端监听端口，并把连接转发回本机可访问的目标地址。服务端 bind 默认 127.0.0.1；非回环地址需要显式确认，服务端拒绝时不会自动放宽。',
  dynamic:
    '在本机启动 SOCKS5 代理，仅支持无认证 CONNECT，且监听地址固定为 127.0.0.1。不支持 UDP ASSOCIATE 或 SOCKS4。',
}

interface FormValues {
  name: string
  connectionId: string
  type: PortForwardType
  bindAddress: string
  bindPort: string
  targetHost: string
  targetPort: string
}

interface FieldErrors {
  name?: string
  connectionId?: string
  bindAddress?: string
  bindPort?: string
  targetHost?: string
  targetPort?: string
}

function toValues(rule?: PortForwardRule, fallbackConnectionId = ''): FormValues {
  if (!rule) {
    return {
      name: '',
      connectionId: fallbackConnectionId,
      type: 'local',
      bindAddress: '127.0.0.1',
      bindPort: '',
      targetHost: '127.0.0.1',
      targetPort: '',
    }
  }
  return {
    name: rule.name,
    connectionId: rule.connectionId,
    type: rule.type,
    bindAddress: rule.bindAddress,
    bindPort: String(rule.bindPort),
    targetHost: rule.type === 'dynamic' ? '' : rule.targetHost,
    targetPort: rule.type === 'dynamic' ? '' : String(rule.targetPort),
  }
}

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value.trim())) return null
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : null
}

function validate(values: FormValues, editing: boolean): FieldErrors {
  const errors: FieldErrors = {}
  if (values.name.trim().length === 0) errors.name = '请输入规则名称。'
  else if (values.name.trim().length > 64) errors.name = '规则名称最多 64 个字符。'
  if (!editing && values.connectionId.length === 0) errors.connectionId = '请选择关联连接。'
  if (values.type !== 'dynamic' && values.bindAddress.trim().length === 0) {
    errors.bindAddress = '请输入监听地址。'
  }
  if (parsePort(values.bindPort) === null) errors.bindPort = '端口范围为 1–65535。'
  if (values.type !== 'dynamic') {
    if (values.targetHost.trim().length === 0) errors.targetHost = '请输入目标主机。'
    if (parsePort(values.targetPort) === null) errors.targetPort = '端口范围为 1–65535。'
  }
  return errors
}

export function PortForwardEditorModal() {
  const formId = `port-forward-editor-${useId().replace(/:/g, '')}`
  const editor = usePortForwardStore((state) => state.editor)
  const items = usePortForwardStore((state) => state.items)
  const closeEditor = usePortForwardStore((state) => state.closeEditor)
  const createRule = usePortForwardStore((state) => state.createRule)
  const updateRule = usePortForwardStore((state) => state.updateRule)
  const connections = useConnectionStore((state) => state.connections)
  const pushToast = useAppStore((state) => state.pushToast)

  if (!editor.open) return null
  const editing = editor.mode === 'edit'
  const item = editing
    ? items.find((entry) => entry.rule.id === editor.ruleId)
    : undefined
  const rule = item?.rule
  if (editing && !rule) return null

  return (
    <Modal
      title={editing ? `编辑转发规则 · ${rule?.name ?? ''}` : '新建端口转发规则'}
      description="规则只保存地址与端口，不保存任何密码、私钥或会话数据。应用重启后规则保持停止，不会假定旧监听器仍然存在。"
      width={620}
      onClose={closeEditor}
    >
      <PortForwardForm
        key={editing ? rule?.id : 'create'}
        formId={formId}
        editing={editing}
        item={item}
        connections={connections}
        onCancel={closeEditor}
        onSubmit={async (input) => {
          if (editing && rule) {
            const updated = await updateRule(rule.id, input as PortForwardUpdateInput)
            pushToast({
              tone: 'success',
              title: '转发规则已更新',
              description: `${updated.rule.name} 已保存；下次启动时才会重新创建监听器。`,
            })
          } else {
            const created = await createRule(input as PortForwardCreateInput)
            pushToast({
              tone: 'success',
              title: '转发规则已创建',
              description: `${created.rule.name} 已保存为停止状态，启动前不会监听任何端口。`,
            })
          }
          closeEditor()
        }}
      />
    </Modal>
  )
}

interface PortForwardFormProps {
  formId: string
  editing: boolean
  item?: PortForwardItem
  connections: Array<{ id: string; name: string; host: string; username: string }>
  onCancel: () => void
  onSubmit: (input: PortForwardCreateInput | PortForwardUpdateInput) => Promise<void>
}

function PortForwardForm({
  formId,
  editing,
  item,
  connections,
  onCancel,
  onSubmit,
}: PortForwardFormProps) {
  const [values, setValues] = useState<FormValues>(() =>
    toValues(item?.rule, connections[0]?.id),
  )
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const connection = connections.find((entry) => entry.id === values.connectionId)
  const exposureRisk =
    values.type !== 'dynamic' &&
    values.bindAddress.trim().length > 0 &&
    !isLoopbackAddress(values.bindAddress)

  const update = <K extends keyof FormValues>(key: K, value: FormValues[K]): void => {
    setValues((current) => ({ ...current, [key]: value }))
    setErrors((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key as keyof FieldErrors]
      return next
    })
    setFormError(null)
    setSubmitError(null)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (submitting) return

    const nextErrors = validate(values, editing)
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      setFormError('无法保存转发规则，请检查标出的字段。')
      return
    }

    const bindPort = parsePort(values.bindPort) as number
    const name = values.name.trim()
    const target = {
      name,
      bindAddress: values.bindAddress.trim(),
      bindPort,
      targetHost: values.targetHost.trim(),
      targetPort: parsePort(values.targetPort) as number,
    }
    let input: PortForwardCreateInput | PortForwardUpdateInput
    if (values.type === 'dynamic') {
      input = editing
        ? { type: 'dynamic', name, bindPort }
        : { type: 'dynamic', name, connectionId: values.connectionId, bindPort }
    } else if (values.type === 'local') {
      input = editing
        ? { type: 'local', ...target }
        : { type: 'local', connectionId: values.connectionId, ...target }
    } else {
      input = editing
        ? { type: 'remote', ...target }
        : { type: 'remote', connectionId: values.connectionId, ...target }
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      await onSubmit(input)
    } catch (error) {
      setSubmitError(
        error instanceof Error && error.message
          ? error.message
          : '转发规则未能保存，请稍后重试。',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const bindPortId = `${formId}-bind-port`
  const nameId = `${formId}-name`
  const targetHostId = `${formId}-target-host`
  const targetPortId = `${formId}-target-port`

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
          <label className="field__label" htmlFor={nameId}>
            规则名称 <span className="field__required">*</span>
          </label>
          <input
            id={nameId}
            className="text-input"
            value={values.name}
            maxLength={64}
            aria-invalid={errors.name ? 'true' : undefined}
            placeholder="例如：内网数据库"
            onChange={(event) => update('name', event.target.value)}
          />
          {errors.name ? <p className="field__error">{errors.name}</p> : null}
        </div>

        <div className="field field--full">
          <label className="field__label" htmlFor={`${formId}-connection`}>
            关联连接 <span className="field__required">*</span>
          </label>
          <select
            id={`${formId}-connection`}
            className="select"
            value={values.connectionId}
            disabled={editing || connections.length === 0}
            aria-invalid={errors.connectionId ? 'true' : undefined}
            onChange={(event) => update('connectionId', event.target.value)}
          >
            {connections.length === 0 ? <option value="">暂无可用连接</option> : null}
            {connections.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} · {entry.username}@{entry.host}
              </option>
            ))}
          </select>
          {editing ? (
            <p className="field__hint">已保存的规则不能改绑其他连接；如需切换，请新建规则。</p>
          ) : null}
          {errors.connectionId ? <p className="field__error">{errors.connectionId}</p> : null}
        </div>

        <div className="field field--full">
          <label className="field__label" htmlFor={`${formId}-type`}>
            转发类型 <span className="field__required">*</span>
          </label>
          <select
            id={`${formId}-type`}
            className="select"
            value={values.type}
            disabled={editing}
            onChange={(event) => update('type', event.target.value as PortForwardType)}
          >
            {(Object.keys(TYPE_LABELS) as PortForwardType[]).map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <p className="field__hint">{TYPE_NOTES[values.type]}</p>
        </div>

        {values.type === 'dynamic' ? (
          <div className="field field--full">
            <div className="auth-note">
              <ArrowLeftRight size={13} aria-hidden="true" />
              <span>
                SOCKS5 监听固定为 127.0.0.1:端口，仅允许本机应用访问；首版不支持 UDP
                ASSOCIATE、BIND 或 SOCKS4。
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label className="field__label" htmlFor={`${formId}-bind-address`}>
                监听地址 <span className="field__required">*</span>
              </label>
              <input
                id={`${formId}-bind-address`}
                className="text-input"
                value={values.bindAddress}
                aria-invalid={errors.bindAddress ? 'true' : undefined}
                placeholder="127.0.0.1"
                onChange={(event) => update('bindAddress', event.target.value)}
              />
              <p className="field__hint">
                {values.type === 'remote'
                  ? '这是 SSH 服务端上的监听地址，默认 127.0.0.1。'
                  : '监听的 IP 字面量，默认 127.0.0.1；不支持主机名。'}
              </p>
              {errors.bindAddress ? <p className="field__error">{errors.bindAddress}</p> : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor={bindPortId}>
                监听端口 <span className="field__required">*</span>
              </label>
              <input
                id={bindPortId}
                className="text-input"
                value={values.bindPort}
                inputMode="numeric"
                aria-invalid={errors.bindPort ? 'true' : undefined}
                placeholder="8080"
                onChange={(event) => update('bindPort', event.target.value)}
              />
              {errors.bindPort ? <p className="field__error">{errors.bindPort}</p> : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor={targetHostId}>
                目标主机 <span className="field__required">*</span>
              </label>
              <input
                id={targetHostId}
                className="text-input"
                value={values.targetHost}
                aria-invalid={errors.targetHost ? 'true' : undefined}
                placeholder="127.0.0.1"
                onChange={(event) => update('targetHost', event.target.value)}
              />
              <p className="field__hint">
                {values.type === 'remote'
                  ? '由本机解析并访问该目标；远端只负责监听并转回本机。'
                  : '从 SSH 会话远端解析并访问该目标。'}
              </p>
              {errors.targetHost ? <p className="field__error">{errors.targetHost}</p> : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor={targetPortId}>
                目标端口 <span className="field__required">*</span>
              </label>
              <input
                id={targetPortId}
                className="text-input"
                value={values.targetPort}
                inputMode="numeric"
                aria-invalid={errors.targetPort ? 'true' : undefined}
                placeholder="5432"
                onChange={(event) => update('targetPort', event.target.value)}
              />
              {errors.targetPort ? <p className="field__error">{errors.targetPort}</p> : null}
            </div>
          </>
        )}
      </div>

      {exposureRisk && values.type === 'local' ? (
        <div className="delete-confirm__note">
          <Info size={13} aria-hidden="true" />
          <span>
            监听地址 {values.bindAddress} 不是回环地址。启动时会在本机网络上暴露该端口，应用会再次要求你确认风险。
          </span>
        </div>
      ) : null}

      {connection ? (
        <p className="field__hint">
          规则将复用与“{connection.name}”关联的已连接 SSH 会话；不会创建新连接，也不会保存凭据。
        </p>
      ) : null}

      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? '保存中…' : editing ? '保存修改' : '创建规则'}
        </Button>
        <Button type="button" variant="ghost" disabled={submitting} onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  )
}
