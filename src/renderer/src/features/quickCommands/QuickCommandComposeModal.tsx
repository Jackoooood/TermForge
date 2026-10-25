import { useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CornerDownLeft, Info, Play, Send, Target } from 'lucide-react'
import {
  parseQuickCommandTemplate,
  renderQuickCommandTemplate,
} from '@shared/quickCommands/template'
import type { QuickCommandExecuteInput } from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useAppStore } from '@renderer/stores/appStore'
import {
  createQuickCommandRequestId,
  useQuickCommandStore,
} from '@renderer/stores/quickCommandStore'
import type { QuickCommandComposeRequest } from '@renderer/stores/quickCommandStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { listQuickCommandTargets, targetKey } from '@renderer/lib/quickCommandTargets'

export function QuickCommandComposeModal() {
  const compose = useQuickCommandStore((state) => state.compose)
  if (!compose) return null
  const key =
    compose.source.kind === 'command'
      ? `${compose.intent}:command:${compose.source.commandId}`
      : `${compose.intent}:history:${compose.source.entryId}`
  return <ComposeDialog key={key} request={compose} />
}

function ComposeDialog({ request }: { request: QuickCommandComposeRequest }) {
  const commands = useQuickCommandStore((state) => state.commands)
  const history = useQuickCommandStore((state) => state.history)
  const source = request.source
  const command =
    source.kind === 'command'
      ? (commands.find((item) => item.id === source.commandId) ?? null)
      : null
  const historyEntry =
    source.kind === 'history' ? (history.find((item) => item.id === source.entryId) ?? null) : null
  const capturedTarget = useQuickCommandStore((state) => state.capturedTarget)
  const closeCompose = useQuickCommandStore((state) => state.closeCompose)
  const insertQuickCommand = useQuickCommandStore((state) => state.insertQuickCommand)
  const executeQuickCommand = useQuickCommandStore((state) => state.executeQuickCommand)
  const historyEnabled = useSettingsStore((state) => state.commandHistoryEnabled)
  const sessions = useSessionStore((state) => state.sessions)
  const shells = useTerminalStore((state) => state.shells)
  const pushToast = useAppStore((state) => state.pushToast)
  const targetInputId = useId()
  const requestIdRef = useRef(createQuickCommandRequestId())

  const [values, setValues] = useState<Record<string, string>>(() => {
    if (!command) return {}
    return Object.fromEntries(
      command.parameters.map((parameter) => [parameter.name, parameter.defaultValue]),
    )
  })
  const [targetSelection, setTargetSelection] = useState<string>(() => {
    const capturedPair = capturedTarget ? targetKey(capturedTarget) : null
    if (!capturedPair) return ''
    const available = listQuickCommandTargets(sessions, shells).some(
      (target) => targetKey(target) === capturedPair,
    )
    return available ? capturedPair : ''
  })
  const [recordHistory, setRecordHistory] = useState(
    () => useSettingsStore.getState().commandHistoryEnabled,
  )
  const [submitting, setSubmitting] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)

  const targets = useMemo(() => listQuickCommandTargets(sessions, shells), [sessions, shells])
  const selectedTarget = targets.find((target) => targetKey(target) === targetSelection) ?? null
  const capturedPair = capturedTarget ? targetKey(capturedTarget) : null
  const capturedInvalid =
    capturedPair !== null && !targets.some((target) => targetKey(target) === capturedPair)
  const selectionInvalid = targetSelection.length > 0 && selectedTarget === null

  const preview = useMemo(() => {
    if (command) return renderQuickCommandTemplate(command.body, values)
    if (historyEntry) return { ok: true as const, text: historyEntry.body }
    return { ok: false as const, message: '命令或历史记录已不存在，可能已被删除。' }
  }, [command, historyEntry, values])

  const templateError = useMemo(() => {
    if (!command) return null
    const parsed = parseQuickCommandTemplate(command.body)
    return parsed.ok ? null : parsed.message
  }, [command])

  const title = request.intent === 'send' ? '确认发送快速命令' : '插入快速命令'
  const description = command
    ? `${command.name} · ${command.category}`
    : historyEntry
      ? '按历史记录中的正文原样发送；不会重新解析参数。'
      : '来源已不存在'

  const close = (): void => {
    if (submitting) return
    closeCompose()
  }

  const submit = async (): Promise<void> => {
    if (submitting) return
    if (!preview.ok) {
      setRequestError(preview.message)
      return
    }
    if (!selectedTarget) {
      setRequestError('请显式选择一个 SSH 已连接且 Shell 已打开的目标终端。')
      return
    }
    setSubmitting(true)
    setRequestError(null)

    if (request.intent === 'insert') {
      const result = await insertQuickCommand(
        selectedTarget.tabId,
        selectedTarget.sessionId,
        preview.text,
      )
      if (!result.ok) {
        setRequestError(result.error?.message ?? '命令未能插入目标终端。')
        setSubmitting(false)
        return
      }
      closeCompose()
      pushToast({
        tone: 'success',
        title: '已插入终端输入行',
        description: '未追加回车，也未执行命令；可在终端中检查后再手动提交。',
      })
      return
    }

    const base = {
      requestId: requestIdRef.current,
      tabId: selectedTarget.tabId,
      sessionId: selectedTarget.sessionId,
      recordHistory: historyEnabled ? recordHistory : false,
    }
    let input: QuickCommandExecuteInput
    if (request.source.kind === 'command') {
      if (!command) {
        setRequestError('命令已不存在，可能已被删除，未发送任何内容。')
        setSubmitting(false)
        return
      }
      input = {
        ...base,
        kind: 'command',
        commandId: command.id,
        parameterValues: values,
      }
    } else {
      input = { ...base, kind: 'history', body: preview.text }
    }

    const result = await executeQuickCommand(input)
    if (!result.ok) {
      setRequestError(result.error.message)
      setSubmitting(false)
      return
    }

    closeCompose()
    if (result.value.historyWarning) {
      pushToast({
        tone: 'warning',
        title: '命令已写入终端，但历史未记录',
        description: result.value.historyWarning,
      })
      return
    }
    pushToast({
      tone: 'success',
      title: result.value.historyRecorded ? '命令已写入终端并记录历史' : '命令已写入终端',
      description: '回车已发送；远端命令是否执行成功请以终端输出为准。',
    })
  }

  return (
    <Modal
      title={title}
      description={description}
      width={620}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" disabled={submitting} onClick={close}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={submitting || !preview.ok || !selectedTarget}
            onClick={() => void submit()}
          >
            {request.intent === 'send' ? (
              <Send size={13} aria-hidden="true" />
            ) : (
              <CornerDownLeft size={13} aria-hidden="true" />
            )}
            {submitting
              ? request.intent === 'send'
                ? '发送中…'
                : '插入中…'
              : request.intent === 'send'
                ? '确认发送'
                : '插入到终端'}
          </Button>
        </>
      }
    >
      <div className="qc-compose">
        {templateError ? (
          <div className="qc-notice qc-notice--danger" role="alert">
            <AlertTriangle size={12} aria-hidden="true" />
            <span>{templateError}</span>
          </div>
        ) : null}

        {command && command.parameters.length > 0 ? (
          <div className="qc-compose__params">
            <p className="qc-compose__section-title">参数</p>
            {command.parameters.map((parameter) => (
              <div className="field" key={parameter.name}>
                <label className="field__label" htmlFor={`qc-param-${parameter.name}`}>
                  {parameter.name}
                </label>
                <input
                  id={`qc-param-${parameter.name}`}
                  className="text-input qc-compose__param-input"
                  value={values[parameter.name] ?? ''}
                  placeholder={`填写 ${parameter.name} 的值`}
                  autoComplete="off"
                  disabled={submitting}
                  onChange={(event) => {
                    const next = event.target.value
                    setValues((current) => ({ ...current, [parameter.name]: next }))
                    setRequestError(null)
                  }}
                />
                <p className="field__hint">
                  按字面单次替换；不进行额外 shell 转义，请自行确认参数内容。
                </p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="qc-compose__preview-block">
          <div className="qc-compose__preview-head">
            <p className="qc-compose__section-title">最终命令预览</p>
            {command ? <Badge tone="neutral">模板</Badge> : null}
          </div>
          <pre className="qc-preview" aria-label="最终命令预览">
            {preview.ok ? preview.text : '—'}
          </pre>
          {!preview.ok ? (
            <p className="field__error" role="alert">
              {preview.message}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={targetInputId}>
            <Target size={12} aria-hidden="true" />
            目标终端（显式选择）
          </label>
          <select
            id={targetInputId}
            className="select"
            value={targetSelection}
            disabled={submitting || targets.length === 0}
            onChange={(event) => {
              setTargetSelection(event.target.value)
              setRequestError(null)
            }}
          >
            {targets.length === 0 ? (
              <option value="">没有可用的已连接终端</option>
            ) : (
              <option value="">请选择目标终端</option>
            )}
            {selectionInvalid ? (
              <option value={targetSelection}>之前选择的目标已不可用，请重新选择</option>
            ) : null}
            {targets.map((target) => (
              <option key={targetKey(target)} value={targetKey(target)}>
                {target.label} — {target.detail}
              </option>
            ))}
          </select>
          {targets.length === 0 ? (
            <p className="field__hint">
              需要 SSH 状态为「已连接」且该标签的远程 Shell 已打开。若刚断开或重连，请先恢复终端。
            </p>
          ) : capturedInvalid ? (
            <p className="field__hint field__hint--warning">
              打开命令库时捕获的终端已断开、重连或关闭了 Shell。不会自动切换目标，请显式重新选择。
            </p>
          ) : selectionInvalid ? (
            <p className="field__hint field__hint--warning">
              之前选择的目标已不可用。不会自动切换目标，请显式重新选择。
            </p>
          ) : (
            <p className="field__hint">
              目标在发送时还会由主进程再次校验标签、会话与 Shell 状态；不一致会拒绝发送。
            </p>
          )}
        </div>

        {request.intent === 'send' ? (
          <div className="qc-compose__history">
            {historyEnabled ? (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={recordHistory}
                  disabled={submitting}
                  onChange={(event) => setRecordHistory(event.target.checked)}
                />
                <span>记录本次发送到命令历史（仅保存命令正文与目标信息，不保存输出或退出码）</span>
              </label>
            ) : (
              <p className="qc-compose__history-off">
                命令历史已在设置中关闭，本次发送不会记录。可在「设置 → 会话与传输记录」中启用。
              </p>
            )}
          </div>
        ) : null}

        <div className="qc-notice">
          <Info size={12} aria-hidden="true" />
          <span>
            {request.intent === 'send'
              ? '确认后会向所选终端已有 SSH Shell 写入上述正文并追加回车。写入成功只代表数据已交给 Shell，不代表远端命令执行成功；状态变更类命令请自行核实。'
              : '插入只把上述正文写入当前光标位置，不追加回车，不会自动执行。确认前目标终端不会切换。'}
          </span>
        </div>

        {requestError ? (
          <p className="field__error qc-compose__error" role="alert">
            <AlertTriangle size={12} aria-hidden="true" />
            {requestError}
          </p>
        ) : null}

        {request.intent === 'send' ? (
          <p className="qc-compose__intent">
            <Play size={11} aria-hidden="true" />
            本次操作：发送并回车
          </p>
        ) : null}
      </div>
    </Modal>
  )
}
