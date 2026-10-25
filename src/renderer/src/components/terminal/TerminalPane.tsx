import {
  Fingerprint,
  KeyRound,
  LoaderCircle,
  PlugZap,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { SessionInfo, SshFailure } from '@shared/types'
import { Button } from '@renderer/components/common/Button'
import { StatusDot, statusLabel } from '@renderer/components/common/StatusDot'
import { AutoReconnectNotice } from '@renderer/components/terminal/AutoReconnectNotice'
import { TerminalPaneHeader } from '@renderer/components/terminal/TerminalPaneHeader'
import { XtermTerminal } from '@renderer/components/terminal/XtermTerminal'
import type { SplitDirection, SplitPaneId } from '@renderer/features/terminal/splitLayout'
import { formatSshFailureMessage } from '@renderer/lib/formatSshFailure'
import { promptForCredentialIfNeeded, useSessionStore } from '@renderer/stores/sessionStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'

interface TerminalPaneProps {
  session: SessionInfo
  visible: boolean
  focused: boolean
  paneId: SplitPaneId | null
  splitDirection: SplitDirection
}

interface Presentation {
  icon: LucideIcon
  title: string
  description: string
  busy: boolean
  danger: boolean
}

const AUTH_LABELS: Record<SessionInfo['authMethod'], string> = {
  password: 'Password',
  privateKey: 'Private Key',
  sshAgent: 'SSH Agent',
}

const BUSY_STATUSES = new Set<SessionInfo['status']>([
  'connecting',
  'authenticating',
  'awaiting-host-key',
  'reconnecting',
])

function guidanceFor(failure: SshFailure): string | null {
  switch (failure.code) {
    case 'credential-required':
    case 'credential-invalid':
    case 'authentication-failed':
      return '可以使用下方“输入凭据”重新提供凭据，或检查服务器授权配置。'
    case 'host-key-changed':
      return '已信任的主机密钥不会自动更新，本次连接已被阻止。请联系服务器管理员核实指纹。'
    case 'host-key-timeout':
      return '确认窗口已超时，本次连接未建立。重试会重新发起主机密钥确认。'
    case 'agent-unavailable':
      return '请启动 Windows OpenSSH Agent 或改用密码 / 私钥认证。'
    case 'credential-unavailable':
      return '操作系统凭据存储不可用，应用不会回退为明文保存。'
    default:
      return null
  }
}

function present(session: SessionInfo): Presentation {
  switch (session.status) {
    case 'connecting':
      return {
        icon: LoaderCircle,
        title: '正在连接服务器…',
        description: session.activeHop
          ? `正在连接跳板 ${session.activeHop.index}/${session.jumps.length} ${session.activeHop.name}（${session.activeHop.host}:${session.activeHop.port}）。`
          : `正在与 ${session.host}:${session.port} 建立独立的 SSH 传输层连接。`,
        busy: true,
        danger: false,
      }
    case 'authenticating':
      return {
        icon: LoaderCircle,
        title: '正在认证…',
        description: session.activeHop
          ? `正在对跳板 ${session.activeHop.index}/${session.jumps.length} ${session.activeHop.name} 进行认证；凭据不会进入渲染进程状态或日志。`
          : '认证由主进程完成，凭据不会进入渲染进程状态或日志。',
        busy: true,
        danger: false,
      }
    case 'awaiting-host-key':
      return {
        icon: Fingerprint,
        title: '等待主机密钥确认',
        description: session.activeHop
          ? `首次连接跳板 ${session.activeHop.name}（${session.activeHop.host}:${session.activeHop.port}）需要你核对指纹；确认前连接不会继续。`
          : '首次连接需要你核对服务器指纹；确认前连接不会继续。',
        busy: true,
        danger: false,
      }
    case 'connected':
      return {
        icon: ShieldCheck,
        title: 'SSH 已连接',
        description:
          session.jumps.length > 0
            ? `SSH 传输层已经由 ${session.jumps.length} 个跳板建立，交互式终端将在当前标签中打开。`
            : 'SSH 传输层已建立，交互式终端将在当前标签中打开。',
        busy: false,
        danger: false,
      }
    case 'reconnecting':
      return {
        icon: LoaderCircle,
        title: '正在重新连接…',
        description: '旧 SSH 传输正在释放；新连接建立后会在此标签打开新的远程 Shell。',
        busy: true,
        danger: false,
      }
    case 'closing':
      return {
        icon: LoaderCircle,
        title: '正在关闭会话…',
        description: '正在停止终端事件并释放远程 Shell 与 SSH 传输。',
        busy: true,
        danger: false,
      }
    case 'disconnected':
      return {
        icon: PlugZap,
        title: 'SSH 连接已断开',
        description: session.failure
          ? formatSshFailureMessage(session.failure)
          : '会话已主动断开，或服务器关闭了连接。',
        busy: false,
        danger: false,
      }
    case 'error':
      return {
        icon: ShieldAlert,
        title: 'SSH 连接失败',
        description: session.failure
          ? formatSshFailureMessage(session.failure)
          : 'SSH 连接过程中发生错误，请重试。',
        busy: false,
        danger: true,
      }
    case 'idle':
    default:
      return {
        icon: PlugZap,
        title: '尚未连接',
        description: '选择服务器以建立 SSH 连接。',
        busy: false,
        danger: false,
      }
  }
}

function formatConnectedAt(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString()
}

export function TerminalPane({
  session,
  visible,
  focused,
  paneId,
  splitDirection,
}: TerminalPaneProps) {
  const cancelConnect = useSessionStore((state) => state.cancelConnect)
  const cancelAutoReconnect = useSessionStore((state) => state.cancelAutoReconnect)
  const reconnectSession = useSessionStore((state) => state.reconnectSession)
  const closeSession = useSessionStore((state) => state.closeSession)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const view = present(session)
  const Icon = view.icon
  const guidance = session.failure ? guidanceFor(session.failure) : null
  const autoReconnectActive = session.autoReconnect !== null && !session.autoReconnect.exhausted
  const canRetry = session.status === 'error' || session.status === 'disconnected'
  const canCancel =
    (BUSY_STATUSES.has(session.status) || session.status === 'closing') && !autoReconnectActive
  const canProvideCredential =
    session.failure?.credentialKind !== undefined && session.status === 'error'
  const connectedAt = formatConnectedAt(session.connectedAt)
  const sshConnected = session.status === 'connected'
  const preserveTerminal =
    session.hasTerminal && (sshConnected || session.status === 'disconnected')
  const paneClasses = ['terminal-pane']
  if (visible) paneClasses.push('terminal-pane--visible')
  if (focused) paneClasses.push('terminal-pane--focused')
  if (paneId) paneClasses.push(`terminal-pane--slot-${paneId === 'pane-a' ? 'a' : 'b'}`)

  const requestPaneFocus = (): void => {
    if (paneId && !focused) focusPane(paneId)
  }

  return (
    <div
      id={`terminal-panel-${session.id}`}
      role="tabpanel"
      aria-labelledby={`session-tab-${session.id}`}
      className={paneClasses.join(' ')}
      aria-hidden={!visible}
      onMouseDown={requestPaneFocus}
      onFocusCapture={requestPaneFocus}
    >
      {paneId ? (
        <TerminalPaneHeader
          session={session}
          paneId={paneId}
          focused={focused}
          direction={splitDirection}
        />
      ) : null}
      <div className="terminal-pane__body">
        {preserveTerminal ? (
          <>
            <XtermTerminal
              tabId={session.id}
              active={focused}
              generation={session.generation}
              sshConnected={sshConnected}
            />
            {!sshConnected ? (
              <div className="terminal-shell-overlay">
                <section
                  className="terminal-shell-overlay__card terminal-shell-overlay__card--danger"
                  aria-live="polite"
                  aria-label="SSH 已断开"
                >
                  <span className="terminal-shell-overlay__icon" aria-hidden="true">
                    <PlugZap size={18} />
                  </span>
                  <h4 className="terminal-shell-overlay__title">SSH 连接已断开</h4>
                  <p className="terminal-shell-overlay__description">
                    {session.failure
                      ? formatSshFailureMessage(session.failure)
                      : '服务器或网络关闭了 SSH 传输。终端输入已禁用，屏幕上的历史输出仅保留在本地。'}
                  </p>
                  <p className="terminal-shell-overlay__meta">
                    重新连接会为这个标签创建新的 SSH 传输和新的远程
                    Shell；原远程进程与工作目录不会自动恢复。
                  </p>
                  <AutoReconnectNotice
                    session={session}
                    onCancel={() => void cancelAutoReconnect(session.id)}
                  />
                  <div className="terminal-connection__actions">
                    {canRetry ? (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void reconnectSession(session.id)}
                      >
                        <RotateCw size={13} aria-hidden="true" />
                        重新连接
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => void closeSession(session.id)}>
                      <X size={13} aria-hidden="true" />
                      关闭标签
                    </Button>
                  </div>
                </section>
              </div>
            ) : null}
          </>
        ) : (
          <div className="terminal-connection">
            <section
              className="terminal-connection__panel"
              aria-live="polite"
              aria-label={`${session.title} SSH 连接状态`}
            >
              <span
                className={
                  view.danger
                    ? 'terminal-connection__icon terminal-connection__icon--danger'
                    : view.busy
                      ? 'terminal-connection__icon terminal-connection__icon--busy'
                      : 'terminal-connection__icon'
                }
                aria-hidden="true"
              >
                <Icon size={22} className={view.busy ? 'spin' : undefined} />
              </span>

              <span className="terminal-connection__eyebrow">
                <StatusDot status={session.status} />
                {statusLabel(session.status)} · SSH
              </span>
              <h3 className="terminal-connection__title">{view.title}</h3>
              <p className="terminal-connection__description">{view.description}</p>
              {guidance ? <p className="terminal-connection__guidance">{guidance}</p> : null}

              <dl className="terminal-connection__meta">
                <div>
                  <dt>目标</dt>
                  <dd>
                    {session.username}@{session.host}:{session.port}
                  </dd>
                </div>
                {session.jumps.length > 0 ? (
                  <div>
                    <dt>连接路径</dt>
                    <dd>
                      {[
                        '本机',
                        ...session.jumps.map((hop) => hop.name),
                        session.connectionName,
                      ].join(' → ')}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>认证</dt>
                  <dd>{AUTH_LABELS[session.authMethod]}</dd>
                </div>
                {connectedAt ? (
                  <div>
                    <dt>已连接</dt>
                    <dd>{connectedAt}</dd>
                  </div>
                ) : null}
                {session.hostKey ? (
                  <div>
                    <dt>主机密钥</dt>
                    <dd className="terminal-connection__fingerprint">
                      {session.hostKey.algorithm} · {session.hostKey.fingerprint}
                    </dd>
                  </div>
                ) : null}
              </dl>

              <AutoReconnectNotice
                session={session}
                onCancel={() => void cancelAutoReconnect(session.id)}
              />

              <div className="terminal-connection__actions">
                {canCancel ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={session.status === 'closing'}
                    onClick={() => void cancelConnect(session.id)}
                  >
                    <PlugZap size={13} aria-hidden="true" />
                    {session.status === 'closing' ? '正在断开…' : '取消连接'}
                  </Button>
                ) : null}
                {canRetry ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void reconnectSession(session.id)}
                  >
                    <RotateCw size={13} aria-hidden="true" />
                    重新连接
                  </Button>
                ) : null}
                {canProvideCredential ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => promptForCredentialIfNeeded(session)}
                  >
                    <KeyRound size={13} aria-hidden="true" />
                    输入凭据
                  </Button>
                ) : null}
                {session.status !== 'closing' ? (
                  <Button variant="ghost" size="sm" onClick={() => void closeSession(session.id)}>
                    <X size={13} aria-hidden="true" />
                    关闭标签
                  </Button>
                ) : null}
              </div>

              <p className="terminal-connection__footnote">
                SSH 连接建立后会在当前标签内打开真实的远程 PTY；此状态页仅用于连接、认证与断开流程。
              </p>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
