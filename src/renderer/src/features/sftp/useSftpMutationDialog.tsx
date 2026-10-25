import { useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertTriangle, FileText, Folder, FolderPlus, Info, Link2, PencilLine } from 'lucide-react'
import type { OperationResult, RemoteFileEntry, SftpMutationAck } from '@shared/types'
import { getRemoteEntryNameError, joinRemotePath, remoteParentPath } from '@shared/sftp/remotePath'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useAppStore } from '@renderer/stores/appStore'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useSftpStore } from '@renderer/stores/sftpStore'
import type { SftpOperationKind } from '@renderer/stores/sftpStore'

const MUTATION_TITLES: Record<SftpOperationKind, string> = {
  mkdir: '新建远程目录',
  rename: '重命名远程条目',
  delete: '删除远程条目？',
}

interface MutationDialogState {
  tabId: string
  sessionId: string
  parentPath: string
  kind: SftpOperationKind
  entry: RemoteFileEntry | null
  name: string
  fieldError: string | null
  requestError: string | null
  submitting: boolean
  outcomeUnknown: boolean
}

interface UseSftpMutationDialogOptions {
  tabId: string | null
  sessionId: string | null
  path: string
  canMutate: boolean
}

interface SftpMutationDialogResult {
  openMkdir: () => void
  openRename: (entry: RemoteFileEntry) => void
  openDelete: (entry: RemoteFileEntry) => void
  dialog: ReactNode
}

function safeJoin(directory: string, name: string): string | null {
  try {
    return joinRemotePath(directory, name)
  } catch {
    return null
  }
}

function entryKindLabel(kind: RemoteFileEntry['kind']): string {
  if (kind === 'directory') return '目录'
  if (kind === 'symlink') return '符号链接'
  return '文件'
}

function EntryIcon({ entry, size = 16 }: { entry: RemoteFileEntry; size?: number }) {
  if (entry.kind === 'directory') return <Folder size={size} aria-hidden="true" />
  if (entry.kind === 'symlink') return <Link2 size={size} aria-hidden="true" />
  return <FileText size={size} aria-hidden="true" />
}

export function useSftpMutationDialog({
  tabId,
  sessionId,
  path,
  canMutate,
}: UseSftpMutationDialogOptions): SftpMutationDialogResult {
  const dialogInputId = useId()
  const pushToast = useAppStore((state) => state.pushToast)
  const [dialog, setDialog] = useState<MutationDialogState | null>(null)

  useEffect(() => {
    setDialog(null)
  }, [tabId, sessionId])

  const openMkdir = (): void => {
    if (!canMutate || !tabId || !sessionId) return
    const parentPath = useSftpStore.getState().tabs[tabId]?.path || path || '/'
    setDialog({
      tabId,
      sessionId,
      parentPath,
      kind: 'mkdir',
      entry: null,
      name: '',
      fieldError: null,
      requestError: null,
      submitting: false,
      outcomeUnknown: false,
    })
  }

  const openRename = (entry: RemoteFileEntry): void => {
    if (!canMutate || !tabId || !sessionId) return
    setDialog({
      tabId,
      sessionId,
      parentPath: remoteParentPath(entry.path),
      kind: 'rename',
      entry,
      name: entry.name,
      fieldError: null,
      requestError: null,
      submitting: false,
      outcomeUnknown: false,
    })
  }

  const openDelete = (entry: RemoteFileEntry): void => {
    if (!canMutate || !tabId || !sessionId) return
    setDialog({
      tabId,
      sessionId,
      parentPath: remoteParentPath(entry.path),
      kind: 'delete',
      entry,
      name: '',
      fieldError: null,
      requestError: null,
      submitting: false,
      outcomeUnknown: false,
    })
  }

  const closeDialog = (): void => {
    if (dialog?.submitting) return
    setDialog(null)
  }

  const finishMutation = async (
    tabIdToUpdate: string,
    mutationSessionId: string,
    result: OperationResult<SftpMutationAck>,
    success: { title: string; description: string; selectPath?: string },
  ): Promise<void> => {
    if (!result.ok) {
      setDialog((current) =>
        current && current.tabId === tabIdToUpdate && current.sessionId === mutationSessionId
          ? {
              ...current,
              submitting: false,
              requestError: result.error.message,
              outcomeUnknown: result.error.code === 'outcome-unknown',
            }
          : current,
      )
      if (result.error.code === 'outcome-unknown') {
        pushToast({
          tone: 'warning',
          title: '文件操作结果未知',
          description: `${result.error.message} 已请求刷新目录，请核实后再操作。`,
        })
        if (useSftpStore.getState().tabs[tabIdToUpdate]?.sessionId === mutationSessionId) {
          void useSftpStore.getState().refresh(tabIdToUpdate)
          void useSftpStore.getState().refreshTree(tabIdToUpdate, mutationSessionId)
        }
      }
      return
    }

    setDialog((current) =>
      current && current.tabId === tabIdToUpdate && current.sessionId === mutationSessionId
        ? null
        : current,
    )
    pushToast({
      tone: 'success',
      title: success.title,
      description: success.description,
    })

    if (useSftpStore.getState().tabs[tabIdToUpdate]?.sessionId !== mutationSessionId) return
    void useSftpStore.getState().refreshTree(tabIdToUpdate, mutationSessionId)
    const refreshed = await useSftpStore.getState().refresh(tabIdToUpdate)
    if (!refreshed || !success.selectPath) return
    const latest = useSftpStore.getState().tabs[tabIdToUpdate]
    if (latest?.entries.some((entry) => entry.path === success.selectPath)) {
      useSftpStore.getState().select(tabIdToUpdate, success.selectPath)
    }
  }

  const submitDialog = async (): Promise<void> => {
    const current = dialog
    if (!current || current.submitting || current.outcomeUnknown) return

    const currentTab = useSftpStore.getState().tabs[current.tabId]
    const currentSession = useSessionStore.getState().sessions[current.tabId]
    if (
      !currentSession ||
      currentSession.status !== 'connected' ||
      currentSession.sessionId !== current.sessionId ||
      !currentTab ||
      currentTab.sessionId !== current.sessionId ||
      currentTab.status !== 'ready'
    ) {
      setDialog((state) =>
        state ? { ...state, requestError: 'SSH 会话不可用或目录尚未就绪，操作已取消。' } : state,
      )
      return
    }

    if (current.kind !== 'delete') {
      if (current.kind === 'rename' && current.entry?.name === current.name) {
        setDialog({ ...current, fieldError: '新名称与当前名称相同' })
        return
      }
      const nameError = getRemoteEntryNameError(current.name)
      if (nameError) {
        setDialog({ ...current, fieldError: nameError })
        return
      }
    }

    let targetPath: string | null = null
    if (current.kind === 'mkdir') {
      targetPath = safeJoin(current.parentPath, current.name)
      if (!targetPath) {
        setDialog({ ...current, fieldError: '目标路径无效' })
        return
      }
    } else if (current.kind === 'rename' && current.entry) {
      targetPath = safeJoin(current.parentPath, current.name)
      if (!targetPath) {
        setDialog({ ...current, fieldError: '目标路径无效' })
        return
      }
      if (targetPath === current.entry.path) {
        setDialog({ ...current, fieldError: '新名称与当前名称相同' })
        return
      }
    }

    setDialog({ ...current, submitting: true, fieldError: null, requestError: null })
    const store = useSftpStore.getState()
    let result: OperationResult<SftpMutationAck>

    if (current.kind === 'mkdir') {
      result = await store.mkdir(current.tabId, current.sessionId, current.parentPath, current.name)
      await finishMutation(current.tabId, current.sessionId, result, {
        title: '已创建远程目录',
        description: targetPath ?? current.name,
        selectPath: targetPath ?? undefined,
      })
      return
    }

    if (current.kind === 'rename' && current.entry) {
      result = await store.renamePath(
        current.tabId,
        current.sessionId,
        current.entry.path,
        targetPath as string,
      )
      await finishMutation(current.tabId, current.sessionId, result, {
        title: '已重命名远程条目',
        description: `${current.entry.path} → ${targetPath}`,
        selectPath: targetPath ?? undefined,
      })
      return
    }

    if (current.kind === 'delete' && current.entry) {
      const entry = current.entry
      result = await store.deleteEntry(current.tabId, current.sessionId, entry)
      await finishMutation(current.tabId, current.sessionId, result, {
        title:
          entry.kind === 'directory'
            ? '已删除空目录'
            : entry.kind === 'symlink'
              ? '已删除符号链接'
              : '已删除远程文件',
        description: entry.path,
      })
    }
  }

  const dialogLocked = Boolean(dialog?.submitting || dialog?.outcomeUnknown)
  const dialogEntry = dialog?.entry ?? null
  const dialogTarget =
    dialog?.kind === 'mkdir'
      ? safeJoin(dialog.parentPath, dialog.name)
      : dialog?.kind === 'rename' && dialogEntry
        ? safeJoin(dialog.parentPath, dialog.name)
        : null
  const dialogTitle = dialog ? MUTATION_TITLES[dialog.kind] : ''

  const dialogNode = dialog ? (
    <Modal
      title={dialogTitle}
      description={
        dialog.kind === 'mkdir'
          ? '在当前远程目录中创建单个目录，不会递归创建多级路径。'
          : dialog.kind === 'rename'
            ? '条目保留在同一目录；目标已存在时服务器会拒绝，不会静默覆盖。'
            : '此操作只会影响远程服务器上的目标条目。'
      }
      width={480}
      onClose={closeDialog}
      footer={
        <>
          <Button
            variant={dialog.kind === 'delete' ? 'danger' : 'primary'}
            disabled={dialog.submitting || dialog.outcomeUnknown}
            onClick={() => void submitDialog()}
          >
            {dialog.kind === 'delete' ? (
              <AlertTriangle size={13} aria-hidden="true" />
            ) : dialog.kind === 'mkdir' ? (
              <FolderPlus size={13} aria-hidden="true" />
            ) : (
              <PencilLine size={13} aria-hidden="true" />
            )}
            {dialog.outcomeUnknown
              ? '结果未确认'
              : dialog.submitting
                ? '处理中…'
                : dialog.kind === 'delete'
                  ? '确认删除'
                  : dialog.kind === 'mkdir'
                    ? '创建目录'
                    : '重命名'}
          </Button>
          <Button variant="ghost" disabled={dialog.submitting} onClick={closeDialog}>
            {dialog.outcomeUnknown ? '关闭' : '取消'}
          </Button>
        </>
      }
    >
      <form
        className="sftp-dialog"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          void submitDialog()
        }}
      >
        {dialog.kind === 'delete' && dialogEntry ? (
          <div className="delete-confirm">
            <div className="delete-confirm__target">
              <span className="delete-confirm__icon" aria-hidden="true">
                <EntryIcon entry={dialogEntry} />
              </span>
              <div>
                <p className="delete-confirm__name">{dialogEntry.name}</p>
                <p className="delete-confirm__address">
                  {entryKindLabel(dialogEntry.kind)} · {dialogEntry.path}
                </p>
              </div>
            </div>
            <p className="delete-confirm__message">
              {dialogEntry.kind === 'directory'
                ? '仅当该目录为空时才会删除。目录中存在任何条目时，服务器会拒绝本次操作，目录保持不变。'
                : dialogEntry.kind === 'symlink'
                  ? '将删除符号链接本身，不会修改或删除它指向的目标。'
                  : '将删除该远程文件。删除后无法通过本应用恢复。'}
            </p>
            <div className="delete-confirm__note">
              <AlertTriangle size={13} aria-hidden="true" />
              <span>
                不会递归删除。根目录、常见系统目录以及权限不足的目标会由主进程或服务器拒绝。
              </span>
            </div>
          </div>
        ) : (
          <div className="sftp-dialog__target">
            <span className="sftp-dialog__target-icon" aria-hidden="true">
              {dialog.kind === 'mkdir' ? <FolderPlus size={16} /> : <PencilLine size={16} />}
            </span>
            <div>
              <p className="sftp-dialog__target-path">{dialogTarget ?? '输入名称后显示目标路径'}</p>
              <p className="sftp-dialog__target-hint">
                {dialog.kind === 'mkdir'
                  ? `父目录：${dialog.parentPath}`
                  : `目标目录：${dialog.parentPath}`}
              </p>
            </div>
          </div>
        )}

        {dialog.kind !== 'delete' ? (
          <div className="field">
            <label className="field__label" htmlFor={dialogInputId}>
              {dialog.kind === 'mkdir' ? '目录名称' : '新名称'}{' '}
              <span className="field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={dialogInputId}
              className="text-input"
              type="text"
              autoFocus
              disabled={dialogLocked}
              value={dialog.name}
              aria-invalid={Boolean(dialog.fieldError || dialog.requestError)}
              aria-describedby={`${dialogInputId}-hint`}
              placeholder={dialog.kind === 'mkdir' ? '例如 release-2026.11' : '输入新的名称'}
              onChange={(event) => {
                const name = event.target.value
                setDialog((state) =>
                  state
                    ? {
                        ...state,
                        name,
                        fieldError: null,
                        requestError: null,
                        outcomeUnknown: false,
                      }
                    : state,
                )
              }}
            />
            {dialog.fieldError ? (
              <p className="field__error" role="alert">
                {dialog.fieldError}
              </p>
            ) : (
              <p className="field__hint" id={`${dialogInputId}-hint`}>
                支持空格与 Unicode；不能包含 /、NUL 或控制字符，不能是 . 或 ..。
              </p>
            )}
          </div>
        ) : null}

        {dialog.requestError ? (
          <div className="form-error-summary" role="alert">
            <Info size={13} aria-hidden="true" />
            <span>{dialog.requestError}</span>
          </div>
        ) : null}

        {dialog.outcomeUnknown ? (
          <div className="delete-confirm__note">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>
              无法确认操作是否已在服务器上生效。已请求刷新目录；请根据最新列表核实后再操作，应用不会自动重试。
            </span>
          </div>
        ) : null}
      </form>
    </Modal>
  ) : null

  return {
    openMkdir,
    openRename,
    openDelete,
    dialog: dialogNode,
  }
}
