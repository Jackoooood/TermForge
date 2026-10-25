import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import {
  AlertTriangle,
  FileText,
  LoaderCircle,
  RotateCcw,
  Save,
  Search,
  WrapText,
  X,
} from 'lucide-react'
import type { RemoteTextEncoding, RemoteTextEol } from '@shared/types'
import { Badge } from '@renderer/components/common/Badge'
import { Button } from '@renderer/components/common/Button'
import { IconButton } from '@renderer/components/common/IconButton'
import { sftpErrorGuidance } from '@renderer/features/sftp/errorGuidance'
import { cn } from '@renderer/lib/utils'
import {
  isTextEditorTabDirty,
  useTextEditorStore,
} from '@renderer/stores/textEditorStore'
import type { TextEditorTab } from '@renderer/stores/textEditorStore'
import { CodeMirrorSurface } from './CodeMirrorSurface'
import type { CodeMirrorSurfaceHandle } from './CodeMirrorSurface'

type ConfirmState =
  | { kind: 'close-overlay' }
  | { kind: 'close-tab'; tabId: string }
  | { kind: 'reload-tab'; tabId: string }
  | null

function encodingLabel(encoding: RemoteTextEncoding): string {
  return encoding === 'utf-8-bom' ? 'UTF-8 BOM' : 'UTF-8'
}

function eolLabel(eol: RemoteTextEol): string {
  return eol === 'crlf' ? 'CRLF' : 'LF'
}

export function RemoteTextEditor() {
  const open = useTextEditorStore((state) => state.open)
  const tabs = useTextEditorStore((state) => state.tabs)
  const activeTabId = useTextEditorStore((state) => state.activeTabId)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const dirtyTabs = tabs.filter(isTextEditorTabDirty)

  const [wrap, setWrap] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const [busyAction, setBusyAction] = useState(false)
  const surfaceRef = useRef<CodeMirrorSurfaceHandle>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      previousFocusRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (open) return
    setConfirm(null)
    setBusyAction(false)
    setCursor({ line: 1, column: 1 })
  }, [open])

  useEffect(() => {
    setCursor({ line: 1, column: 1 })
  }, [activeTabId])

  if (!open) return null

  const dirty = activeTab ? isTextEditorTabDirty(activeTab) : false
  const activeLoaded = Boolean(activeTab?.loaded)
  const saving = activeTab?.status === 'saving'
  const guidance = activeTab ? sftpErrorGuidance(activeTab.errorCode) : null
  const conflictTab = activeTab?.conflict ? activeTab : null
  const saveError = activeTab?.error && activeLoaded && !activeTab.conflict ? activeTab : null

  const saveTab = async (tabId: string, force = false): Promise<boolean> =>
    useTextEditorStore.getState().save(tabId, { force })

  const closeTab = (tabId: string): void => {
    useTextEditorStore.getState().closeFile(tabId)
  }

  const requestCloseTab = (tab: TextEditorTab): void => {
    if (isTextEditorTabDirty(tab)) {
      setConfirm({ kind: 'close-tab', tabId: tab.id })
      return
    }
    closeTab(tab.id)
  }

  const requestReload = (tab: TextEditorTab): void => {
    if (isTextEditorTabDirty(tab)) {
      setConfirm({ kind: 'reload-tab', tabId: tab.id })
      return
    }
    void useTextEditorStore.getState().reload(tab.id)
  }

  const requestCloseOverlay = (): void => {
    if (dirtyTabs.length > 0) {
      setConfirm({ kind: 'close-overlay' })
      return
    }
    useTextEditorStore.getState().closeOverlay()
  }

  const closeOverlayDiscarding = (): void => {
    const store = useTextEditorStore.getState()
    for (const tab of dirtyTabs) store.closeFile(tab.id)
    store.closeOverlay()
  }

  const handleConfirmSaveAll = async (): Promise<void> => {
    setBusyAction(true)
    const ids = dirtyTabs.map((tab) => tab.id)
    let savedAll = true
    for (const id of ids) {
      const saved = await saveTab(id)
      if (!saved) {
        savedAll = false
        break
      }
    }
    setBusyAction(false)
    setConfirm(null)
    if (savedAll) useTextEditorStore.getState().closeOverlay()
    else {
      const failing = useTextEditorStore.getState().tabs.find(isTextEditorTabDirty)
      if (failing) useTextEditorStore.getState().setActive(failing.id)
      surfaceRef.current?.focus()
    }
  }

  const handleConfirmSaveOne = async (tabId: string): Promise<void> => {
    setBusyAction(true)
    const saved = await saveTab(tabId)
    setBusyAction(false)
    setConfirm(null)
    if (saved) closeTab(tabId)
    else surfaceRef.current?.focus()
  }

  const confirmTab =
    confirm?.kind === 'close-tab' || confirm?.kind === 'reload-tab'
      ? (tabs.find((tab) => tab.id === confirm.tabId) ?? null)
      : null

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    if (confirm) {
      event.preventDefault()
      setConfirm(null)
      return
    }
    const target = event.target as HTMLElement | null
    if (target?.closest('.cm-editor')) return
    event.preventDefault()
    requestCloseOverlay()
  }

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) requestCloseOverlay()
  }

  return (
    <div
      className="text-editor-backdrop"
      onMouseDown={handleBackdropMouseDown}
      onKeyDown={handleKeyDown}
    >
      <section
        className="text-editor"
        role="dialog"
        aria-modal="true"
        aria-label="内置文本编辑器"
      >
        <header className="text-editor__header">
          <div className="text-editor__brand">
            <FileText size={14} aria-hidden="true" />
            <strong>文本编辑器</strong>
            <Badge tone="primary">内置</Badge>
          </div>
          <div className="text-editor__header-actions">
            <span className="text-editor__shortcut-hint">Ctrl+S 保存 · Ctrl+F 查找</span>
            <IconButton label="关闭编辑器" size="sm" onClick={requestCloseOverlay}>
              <X size={15} aria-hidden="true" />
            </IconButton>
          </div>
        </header>

        <div className="text-editor__tabbar">
          <div className="text-editor__tabs" role="tablist" aria-label="打开的文件">
            {tabs.map((tab) => {
              const active = tab.id === activeTabId
              const tabDirty = isTextEditorTabDirty(tab)
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  className={cn('text-editor__tab', active && 'text-editor__tab--active')}
                  title={`${tab.path}${tabDirty ? ' · 未保存' : ''}`}
                  onClick={() => {
                    useTextEditorStore.getState().setActive(tab.id)
                    surfaceRef.current?.focus()
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    useTextEditorStore.getState().setActive(tab.id)
                    surfaceRef.current?.focus()
                  }}
                >
                  <FileText size={11} aria-hidden="true" />
                  <span className="text-editor__tab-name">{tab.name}</span>
                  {tab.status === 'saving' ? (
                    <LoaderCircle className="spin" size={11} aria-hidden="true" />
                  ) : tabDirty ? (
                    <span className="text-editor__tab-dirty" aria-hidden="true">
                      ●
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="text-editor__tab-close"
                    aria-label={`关闭 ${tab.name}`}
                    title={`关闭 ${tab.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestCloseTab(tab)
                    }}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        <div className="text-editor__toolbar">
          <div className="text-editor__file">
            {activeTab ? (
              <>
                <span className="text-editor__file-name" title={activeTab.path}>
                  {activeTab.name}
                </span>
                <span className="text-editor__file-path" title={activeTab.path}>
                  {activeTab.path}
                </span>
              </>
            ) : (
              <span className="text-editor__file-path">没有打开的文件</span>
            )}
          </div>
          <div className="text-editor__actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={!activeTab || !activeLoaded || !dirty || saving}
              title="保存远程文件（Ctrl+S）"
              onClick={() => {
                if (activeTab) void saveTab(activeTab.id)
              }}
            >
              <Save size={13} aria-hidden="true" />
              保存
            </Button>
            <IconButton
              label="重新加载远程文件"
              size="sm"
              title="从服务器重新读取该文件"
              disabled={!activeTab || saving || activeTab?.status === 'loading'}
              onClick={() => {
                if (activeTab) requestReload(activeTab)
              }}
            >
              <RotateCcw size={13} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="查找与替换"
              size="sm"
              title="查找与替换（Ctrl+F）"
              disabled={!activeLoaded}
              onClick={() => surfaceRef.current?.openSearch()}
            >
              <Search size={13} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={wrap ? '关闭自动换行' : '开启自动换行'}
              size="sm"
              active={wrap}
              title={wrap ? '关闭自动换行' : '开启自动换行'}
              onClick={() => setWrap((current) => !current)}
            >
              <WrapText size={13} aria-hidden="true" />
            </IconButton>
          </div>
        </div>

        {conflictTab ? (
          <div className="text-editor__banner text-editor__banner--warning" role="alert">
            <AlertTriangle size={13} aria-hidden="true" />
            <div className="text-editor__banner-text">
              <strong>远程文件已被其他程序修改</strong>
              <span>{conflictTab.error ?? '保存时检测到文件版本冲突，未覆盖远程内容。'}</span>
            </div>
            <div className="text-editor__banner-actions">
              <Button
                size="sm"
                variant="secondary"
                disabled={saving}
                onClick={() => requestReload(conflictTab)}
              >
                重新加载
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={saving}
                title="用编辑器内容覆盖服务器上的新版本"
                onClick={() => void saveTab(conflictTab.id, true)}
              >
                强制保存
              </Button>
            </div>
          </div>
        ) : saveError ? (
          <div className="text-editor__banner text-editor__banner--danger" role="alert">
            <AlertTriangle size={13} aria-hidden="true" />
            <div className="text-editor__banner-text">
              <strong>保存失败</strong>
              <span>
                {saveError.error}
                {guidance ? ` ${guidance}` : ''}
              </span>
            </div>
            <div className="text-editor__banner-actions">
              <Button
                size="sm"
                variant="secondary"
                disabled={saving || !dirty}
                onClick={() => void saveTab(saveError.id)}
              >
                重试保存
              </Button>
            </div>
          </div>
        ) : null}

        <div className="text-editor__body">
          {!activeTab ? (
            <div className="text-editor__state" role="status">
              <FileText size={18} aria-hidden="true" />
              <strong>没有打开的文件</strong>
              <p>从 SFTP 文件列表中选择一个文件，即可在内置编辑器中打开。</p>
            </div>
          ) : activeTab.status === 'loading' ? (
            <div className="text-editor__state" role="status">
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
              <span>正在读取远程文件…</span>
            </div>
          ) : activeTab.status === 'error' && !activeTab.loaded ? (
            <div className="text-editor__state" role="alert">
              <span className="text-editor__state-icon text-editor__state-icon--danger">
                <AlertTriangle size={18} aria-hidden="true" />
              </span>
              <strong>无法打开文件</strong>
              <p>{activeTab.error ?? '服务器未返回文件内容。'}</p>
              {guidance ? <p className="text-editor__state-hint">{guidance}</p> : null}
              <div className="text-editor__state-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void useTextEditorStore.getState().reload(activeTab.id)}
                >
                  重试
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => useTextEditorStore.getState().closeFile(activeTab.id)}
                >
                  关闭标签
                </Button>
              </div>
            </div>
          ) : (
            <CodeMirrorSurface
              ref={surfaceRef}
              tabId={activeTab.id}
              fileName={activeTab.name}
              content={activeTab.content}
              wrap={wrap}
              onChange={(content) =>
                useTextEditorStore.getState().updateContent(activeTab.id, content)
              }
              onSave={() => void saveTab(activeTab.id)}
              onCursorChange={(line, column) => setCursor({ line, column })}
            />
          )}
        </div>

        <footer className="text-editor__status">
          <span className="text-editor__status-path" title={activeTab?.path ?? undefined}>
            {activeTab?.path ?? '未打开文件'}
          </span>
          <span className="text-editor__status-meta">
            {saving ? (
              <span className="text-editor__status-saving">
                <LoaderCircle className="spin" size={11} aria-hidden="true" />
                保存中…
              </span>
            ) : activeTab && activeLoaded ? (
              <span className={cn('text-editor__status-dirty', !dirty && 'is-clean')}>
                {dirty ? '未保存' : '已保存'}
              </span>
            ) : null}
            {activeTab && activeLoaded ? (
              <>
                <span>{encodingLabel(activeTab.encoding)}</span>
                <span>{eolLabel(activeTab.eol)}</span>
                <span>
                  行 {cursor.line}，列 {cursor.column}
                </span>
              </>
            ) : null}
            <span className="text-editor__status-limit">仅 UTF-8 · 2 MiB</span>
          </span>
        </footer>

        {confirm ? (
          <div
            className="text-editor__confirm-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !busyAction) setConfirm(null)
            }}
          >
            <div
              className="text-editor__confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="text-editor-confirm-title"
            >
              <h3 className="text-editor__confirm-title" id="text-editor-confirm-title">
                {confirm.kind === 'close-overlay'
                  ? '关闭前处理未保存修改'
                  : confirm.kind === 'close-tab'
                    ? `关闭 ${confirmTab?.name ?? '标签'}`
                    : `重新加载 ${confirmTab?.name ?? '文件'}`}
              </h3>
              <div className="text-editor__confirm-body">
                {confirm.kind === 'close-overlay' ? (
                  <>
                    <p>以下文件还有未保存的修改：</p>
                    <ul className="text-editor__confirm-list">
                      {dirtyTabs.map((tab) => (
                        <li key={tab.id} title={tab.path}>
                          {tab.name}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : confirm.kind === 'close-tab' ? (
                  <p>该文件有未保存的修改，关闭后将丢失。</p>
                ) : (
                  <p>重新加载会丢弃当前未保存的修改，并显示服务器上的最新内容。</p>
                )}
              </div>
              <div className="text-editor__confirm-actions">
                {confirm.kind === 'close-overlay' ? (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busyAction}
                      autoFocus
                      onClick={() => void handleConfirmSaveAll()}
                    >
                      保存全部并关闭
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busyAction}
                      onClick={() => {
                        setConfirm(null)
                        closeOverlayDiscarding()
                      }}
                    >
                      放弃修改并关闭
                    </Button>
                  </>
                ) : confirm.kind === 'close-tab' ? (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busyAction}
                      autoFocus
                      onClick={() => void handleConfirmSaveOne(confirm.tabId)}
                    >
                      保存并关闭
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busyAction}
                      onClick={() => {
                        setConfirm(null)
                        closeTab(confirm.tabId)
                      }}
                    >
                      放弃修改
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    autoFocus
                    onClick={() => {
                      setConfirm(null)
                      void useTextEditorStore.getState().reload(confirm.tabId)
                    }}
                  >
                    重新加载
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyAction}
                  onClick={() => {
                    setConfirm(null)
                    surfaceRef.current?.focus()
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}
