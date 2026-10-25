import { useId, useMemo, useState } from 'react'
import { AlertTriangle, Info, Save } from 'lucide-react'
import { QUICK_COMMAND_LIMITS } from '@shared/constants/quickCommands'
import { parseQuickCommandTemplate } from '@shared/quickCommands/template'
import { quickCommandDraftSchema } from '@shared/schemas/quickCommands'
import type { QuickCommand } from '@shared/types'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useAppStore } from '@renderer/stores/appStore'
import { useQuickCommandStore } from '@renderer/stores/quickCommandStore'

export function QuickCommandEditorModal() {
  const editor = useQuickCommandStore((state) => state.editor)
  if (!editor) return null
  return <EditorDialog key={editor.commandId ?? 'new'} commandId={editor.commandId} />
}

function EditorDialog({ commandId }: { commandId: string | null }) {
  const commands = useQuickCommandStore((state) => state.commands)
  const closeEditor = useQuickCommandStore((state) => state.closeEditor)
  const saveCommand = useQuickCommandStore((state) => state.saveCommand)
  const pushToast = useAppStore((state) => state.pushToast)
  const [initialCommand] = useState<QuickCommand | null>(
    () => commands.find((command) => command.id === commandId) ?? null,
  )
  const missing = commandId !== null && initialCommand === null

  const [name, setName] = useState(initialCommand?.name ?? '')
  const [category, setCategory] = useState(initialCommand?.category ?? '')
  const [description, setDescription] = useState(initialCommand?.description ?? '')
  const [body, setBody] = useState(initialCommand?.body ?? '')
  const [defaults, setDefaults] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (initialCommand?.parameters ?? []).map((parameter) => [
        parameter.name,
        parameter.defaultValue,
      ]),
    ),
  )
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const nameId = useId()
  const categoryId = useId()
  const descriptionId = useId()
  const bodyId = useId()
  const categoryListId = useId()

  const categories = useMemo(() => {
    const seen = new Set<string>()
    for (const command of commands) seen.add(command.category)
    return [...seen]
  }, [commands])

  const parsed = useMemo(() => parseQuickCommandTemplate(body), [body])
  const parameters = parsed.ok
    ? parsed.parameters.map((parameterName) => ({
        name: parameterName,
        defaultValue: defaults[parameterName] ?? '',
      }))
    : []

  const close = (): void => {
    if (submitting) return
    closeEditor()
  }

  const save = async (): Promise<void> => {
    if (submitting) return
    if (missing) {
      setFormError('该命令已不存在，无法保存。')
      return
    }
    if (!parsed.ok) {
      setFormError(parsed.message)
      return
    }
    const validation = quickCommandDraftSchema.safeParse({
      name,
      category,
      description,
      body,
      parameters,
    })
    if (!validation.success) {
      setFormError(validation.error.issues[0]?.message ?? '请检查命令内容。')
      return
    }

    setSubmitting(true)
    setFormError(null)
    const result = await saveCommand(validation.data, commandId)
    setSubmitting(false)
    if (!result.ok) {
      setFormError(result.error.message)
      return
    }
    closeEditor()
    pushToast({
      tone: 'success',
      title: commandId ? '快速命令已更新' : '快速命令已创建',
      description: '保存不会自动执行命令；请在命令库中预览后手动发送。',
    })
  }

  return (
    <Modal
      title={commandId ? '编辑快速命令' : '新建快速命令'}
      description="自定义命令可能改变远端状态。发送前始终展示完整预览，并要求显式确认目标和发送。"
      width={620}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" disabled={submitting} onClick={close}>
            取消
          </Button>
          <Button variant="primary" disabled={submitting || missing} onClick={() => void save()}>
            <Save size={13} aria-hidden="true" />
            {submitting ? '保存中…' : '保存命令'}
          </Button>
        </>
      }
    >
      <div className="qc-editor">
        <div className="qc-editor__grid">
          <div className="field">
            <label className="field__label" htmlFor={nameId}>
              命令名称
              <span className="field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={nameId}
              className="text-input"
              value={name}
              aria-required="true"
              maxLength={QUICK_COMMAND_LIMITS.maxNameLength}
              disabled={submitting || missing}
              onChange={(event) => {
                setName(event.target.value)
                setFormError(null)
              }}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={categoryId}>
              分类
              <span className="field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={categoryId}
              className="text-input"
              list={categoryListId}
              value={category}
              aria-required="true"
              maxLength={QUICK_COMMAND_LIMITS.maxCategoryLength}
              placeholder="例如：服务诊断"
              disabled={submitting || missing}
              onChange={(event) => {
                setCategory(event.target.value)
                setFormError(null)
              }}
            />
            <datalist id={categoryListId}>
              {categories.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={descriptionId}>
            说明
          </label>
          <input
            id={descriptionId}
            className="text-input"
            value={description}
            maxLength={QUICK_COMMAND_LIMITS.maxDescriptionLength}
            placeholder="可选：说明用途或影响范围"
            disabled={submitting || missing}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor={bodyId}>
            命令正文
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id={bodyId}
            className="text-input qc-editor__body"
            value={body}
            aria-required="true"
            maxLength={QUICK_COMMAND_LIMITS.maxBodyLength}
            placeholder="例如：journalctl -u {{service}} -n 100 --no-pager"
            spellCheck={false}
            aria-invalid={!parsed.ok && body.length > 0}
            disabled={submitting || missing}
            onChange={(event) => {
              setBody(event.target.value)
              setFormError(null)
            }}
          />
          <p className="field__hint">
            单行命令；使用 <code>{'{{参数名}}'}</code> 声明参数，最多{' '}
            {QUICK_COMMAND_LIMITS.maxParameters} 个。参数按字面单次替换，不做额外 shell 转义，也没有
            eval 或本地 shell。
          </p>
          {!parsed.ok ? (
            <p className="field__error" role="alert">
              {parsed.message}
            </p>
          ) : null}
        </div>

        <div className="qc-editor__params">
          <p className="qc-compose__section-title">
            参数默认值
            {parsed.ok && parsed.parameters.length > 0 ? `（${parsed.parameters.length} 个）` : ''}
          </p>
          {parsed.ok && parsed.parameters.length > 0 ? (
            parsed.parameters.map((parameterName) => (
              <div className="field" key={parameterName}>
                <label className="field__label" htmlFor={`qc-default-${parameterName}`}>
                  {parameterName}
                </label>
                <input
                  id={`qc-default-${parameterName}`}
                  className="text-input"
                  value={defaults[parameterName] ?? ''}
                  maxLength={QUICK_COMMAND_LIMITS.maxParameterValueLength}
                  placeholder="可选：发送时预填的默认值"
                  disabled={submitting || missing}
                  onChange={(event) => {
                    const next = event.target.value
                    setDefaults((current) => ({ ...current, [parameterName]: next }))
                    setFormError(null)
                  }}
                />
              </div>
            ))
          ) : (
            <p className="field__hint">
              在命令正文中输入 <code>{'{{identifier}}'}</code> 后，会自动在这里生成参数默认值。
            </p>
          )}
        </div>

        <div className="qc-notice">
          <Info size={12} aria-hidden="true" />
          <span>
            首版内置命令均为只读诊断；自定义命令可能修改远端状态。保存不会执行命令，也不会因连接建立或重连自动运行。
          </span>
        </div>

        {missing ? (
          <p className="field__error" role="alert">
            <AlertTriangle size={12} aria-hidden="true" />
            该命令已不存在，可能已被删除。
          </p>
        ) : null}
        {formError ? (
          <p className="field__error qc-compose__error" role="alert">
            <AlertTriangle size={12} aria-hidden="true" />
            {formError}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}
