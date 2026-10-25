import { randomUUID } from 'node:crypto'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import { connectionIdSchema } from '../../../shared/schemas/ipc'
import {
  respondHostKeyInputSchema,
  sshClientIdSchema,
  sshCredentialInputSchema,
  sshSessionIdSchema,
} from '../../../shared/schemas/ssh'
import { terminalSizeSchema, terminalWriteDataSchema } from '../../../shared/schemas/terminal'
import type { ConnectionProfile } from '../../../shared/types/connection'
import type { PresentedHostKey } from '../../../shared/types/hostKey'
import type {
  HostKeyChallenge,
  SshConnectCancelAck,
  SshConnectResult,
  SshCredentialAck,
  SshCredentialInput,
  SshFailure,
  SshHostKeyRequestEvent,
  SshHostKeyResponseAck,
  SshJumpHop,
  SshSessionSnapshot,
  SshSessionStatus,
  SshStatusEvent,
} from '../../../shared/types/ssh'
import type {
  TerminalAck,
  TerminalExitEvent,
  TerminalFailure,
  TerminalOpenResult,
  TerminalOutputEvent,
  TerminalShellSnapshot,
  TerminalSize,
  TerminalStatusEvent,
} from '../../../shared/types/terminal'
import { AppOperationError } from '../../errors'
import type { ConnectionStore } from '../../storage/connectionRepository'
import type { HostKeyStore } from '../../storage/hostKeyRepository'
import { ShellChannelManager, type SshShellClientLike } from '../terminal/ShellChannelManager'
import type { ResolvedSshAuth, SshCredentialResolver } from './credentialResolver'
import { parseHostKeyBlob } from './hostKeyBlob'
import {
  SshForwardingSessionHandle,
  type SshForwardingSession,
} from './SshForwardingSession'
import { mapSshClientError, SshFailureError } from './sshFailure'

export interface SshClientLike extends SshShellClientLike {
  on(event: string, listener: (...args: unknown[]) => void): this
  removeListener(event: string, listener: (...args: unknown[]) => void): this
  connect(config: ConnectConfig): void
  sftp(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): unknown
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, channel: ClientChannel) => void,
  ): unknown
  forwardIn(
    remoteAddr: string,
    remotePort: number,
    callback: (error: Error | undefined, actualPort: number) => void,
  ): unknown
  unforwardIn(
    remoteAddr: string,
    remotePort: number,
    callback: (error: Error | undefined) => void,
  ): unknown
  end(): this
  destroy(): this
}

export type SshClientFactory = () => SshClientLike

export interface SshServiceDependencies {
  connections: ConnectionStore
  hostKeys: HostKeyStore
  credentialResolver: SshCredentialResolver
  createClient: SshClientFactory
  emitStatus: (event: SshStatusEvent) => void
  emitHostKeyRequest: (event: SshHostKeyRequestEvent) => void
  emitTerminalOutput: (event: TerminalOutputEvent) => void
  emitTerminalStatus: (event: TerminalStatusEvent) => void
  emitTerminalExit: (event: TerminalExitEvent) => void
  /** Main-process-only notification; no renderer IPC is involved. */
  onSessionTerminated?: (sessionId: string) => void
  now?: () => Date
  readyTimeoutMs?: number
  connectGuardMs?: number
  hostKeyTimeoutMs?: number
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
  disconnectGraceMs?: number
  maxActiveSessions?: number
  shellOutputFlushMs?: number
  shellOpenTimeoutMs?: number
}

export interface SshServicePort {
  connect(connectionId: string, clientId: string): Promise<SshConnectResult>
  cancelConnect(clientId: string): Promise<SshConnectCancelAck>
  disconnect(sessionId: string): Promise<SshSessionSnapshot>
  getStatus(sessionId: string): Promise<SshSessionSnapshot>
  respondToHostKey(requestId: string, accepted: boolean): Promise<SshHostKeyResponseAck>
  saveCredential(input: SshCredentialInput): Promise<SshCredentialAck>
  openShell(sessionId: string, size: TerminalSize): Promise<TerminalOpenResult>
  writeShell(sessionId: string, data: string): Promise<TerminalAck>
  resizeShell(sessionId: string, size: TerminalSize): Promise<TerminalAck>
  closeShell(sessionId: string): Promise<TerminalAck>
  getShellStatus(sessionId: string): Promise<TerminalShellSnapshot>
  acquireForwardingSession(sessionId: string): SshForwardingSession
}

const DEFAULT_READY_TIMEOUT_MS = 90_000
const DEFAULT_CONNECT_GUARD_MS = 95_000
const DEFAULT_HOST_KEY_TIMEOUT_MS = 30_000
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000
const DEFAULT_KEEPALIVE_COUNT_MAX = 3
const DEFAULT_DISCONNECT_GRACE_MS = 3_000
const DEFAULT_MAX_ACTIVE_SESSIONS = 32

const SSH_SHELL_DISCONNECTED: TerminalFailure = {
  code: 'ssh-disconnected',
  message: 'SSH 连接已断开，远程 Shell 已关闭。',
}

const ACTIVE_STATUSES: ReadonlySet<SshSessionStatus> = new Set([
  'connecting',
  'authenticating',
  'awaiting-host-key',
  'connected',
  'reconnecting',
  'closing',
])

/**
 * Statuses in which an in-flight attempt may still be aborted by the user.
 * An established connection is never torn down through the cancel path.
 */
const CANCELLABLE_STATUSES: ReadonlySet<SshSessionStatus> = new Set([
  'connecting',
  'authenticating',
  'awaiting-host-key',
  'reconnecting',
])

class Signal {
  private settled = false
  private readonly promise: Promise<void>
  private resolvePromise!: () => void

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolvePromise = resolve
    })
  }

  wait(): Promise<void> {
    return this.promise
  }

  fire(): void {
    if (this.settled) return
    this.settled = true
    this.resolvePromise()
  }

  get isSettled(): boolean {
    return this.settled
  }
}

interface PendingHostKey {
  requestId: string
  presented: PresentedHostKey
  /** Set when the challenge belongs to a jump host instead of the target. */
  hop: SshJumpHop | null
  verify: (accepted: boolean) => void
  timer: NodeJS.Timeout | null
  expiresAt: string
}

/**
 * Lifecycle of one jump host in a session. The client's transport is either a
 * direct TCP socket (first hop) or the `forwardOut` channel of the previous
 * hop; nothing here ever reaches the renderer.
 */
interface HopRecord {
  connection: ConnectionProfile
  info: SshJumpHop
  client: SshClientLike | null
  /** Channel opened toward the next endpoint; used as the next client's `sock`. */
  outboundChannel: ClientChannel | null
  ready: Signal
  closed: Signal
}

interface SessionRecord {
  snapshot: SshSessionSnapshot
  connection: ConnectionProfile
  /** Ordered jump runtimes (nearest hop first); empty for direct connections. */
  hops: HopRecord[]
  client: SshClientLike | null
  forwardingSession: SshForwardingSessionHandle | null
  pendingHostKey: PendingHostKey | null
  /** Number of chain clients that have not emitted `close` yet. */
  pendingCloses: number
  milestone: Signal
  closed: Signal
  readyGuard: NodeJS.Timeout | null
  userClosed: boolean
  disposed: boolean
  /** Shared by concurrent close requests so teardown runs exactly once. */
  disconnectPromise: Promise<SshSessionSnapshot> | null
  terminatedNotified: boolean
}

function makeHopInfo(index: number, connection: ConnectionProfile): SshJumpHop {
  return {
    index,
    connectionId: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMethod: connection.authMethod,
  }
}

function cloneSnapshot(snapshot: SshSessionSnapshot): SshSessionSnapshot {
  return structuredClone(snapshot)
}

function makeTimer(callback: () => void, delay: number): NodeJS.Timeout {
  const timer = setTimeout(callback, delay)
  timer.unref?.()
  return timer
}

/**
 * Owns every ssh2 Client in the main process. The renderer only sees opaque
 * session IDs and snapshots; clients, credentials and verifier callbacks never
 * cross IPC.
 */
export class SshService implements SshServicePort {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly shells: ShellChannelManager
  private disposed = false
  private readonly now: () => Date
  private readonly readyTimeoutMs: number
  private readonly connectGuardMs: number
  private readonly hostKeyTimeoutMs: number
  private readonly keepaliveIntervalMs: number
  private readonly keepaliveCountMax: number
  private readonly disconnectGraceMs: number
  private readonly maxActiveSessions: number

  constructor(private readonly dependencies: SshServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.readyTimeoutMs = dependencies.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.connectGuardMs = dependencies.connectGuardMs ?? DEFAULT_CONNECT_GUARD_MS
    this.hostKeyTimeoutMs = dependencies.hostKeyTimeoutMs ?? DEFAULT_HOST_KEY_TIMEOUT_MS
    this.keepaliveIntervalMs = dependencies.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
    this.keepaliveCountMax = dependencies.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX
    this.disconnectGraceMs = dependencies.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS
    this.maxActiveSessions = dependencies.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS
    this.shells = new ShellChannelManager({
      emitOutput: dependencies.emitTerminalOutput,
      emitStatus: dependencies.emitTerminalStatus,
      emitExit: dependencies.emitTerminalExit,
      outputFlushMs: dependencies.shellOutputFlushMs,
      openTimeoutMs: dependencies.shellOpenTimeoutMs,
    })
  }

  async connect(rawConnectionId: string, rawClientId: string): Promise<SshConnectResult> {
    this.assertUsable()
    const parsedId = connectionIdSchema.safeParse(rawConnectionId)
    if (!parsedId.success) {
      throw new AppOperationError('invalid-input', '连接 ID 格式无效。')
    }
    const parsedClientId = sshClientIdSchema.safeParse(rawClientId)
    if (!parsedClientId.success) {
      throw new AppOperationError('invalid-input', 'SSH 客户端标识格式无效。')
    }

    const catalog = await this.dependencies.connections.list()
    const connection = catalog.connections.find((item) => item.id === parsedId.data)
    if (!connection) {
      throw new AppOperationError('not-found', '找不到该连接，可能已被删除。')
    }

    // The catalog is schema-validated, so a missing reference here would mean
    // the store changed underneath us; refuse rather than dial a partial chain.
    const jumpPlan: ConnectionProfile[] = []
    for (const jumpId of connection.jumpConnectionIds) {
      const jump = catalog.connections.find((item) => item.id === jumpId)
      if (!jump) {
        throw new AppOperationError(
          'invalid-input',
          '该连接的跳板引用已失效，请重新编辑连接配置后重试。',
        )
      }
      jumpPlan.push(structuredClone(jump))
    }

    // Deduplication is per renderer tab, never per connection profile. Two
    // tabs opened for the same server must own independent transports.
    const existing = this.findSessionByClientId(parsedClientId.data)
    if (existing) {
      if (ACTIVE_STATUSES.has(existing.snapshot.status)) {
        if (existing.pendingHostKey) this.emitHostKeyChallenge(existing, existing.pendingHostKey)
        return { session: cloneSnapshot(existing.snapshot), reused: true }
      }
      this.discardRecord(existing)
    }

    if (this.countActiveSessions() >= this.maxActiveSessions) {
      throw new AppOperationError(
        'limit-exceeded',
        `同时进行的 SSH 会话不能超过 ${this.maxActiveSessions} 个，请先断开其他连接。`,
      )
    }

    const record = this.createRecord(connection, parsedClientId.data, jumpPlan)
    this.sessions.set(record.snapshot.sessionId, record)
    this.emitStatus(record)

    record.readyGuard = makeTimer(() => {
      if (!ACTIVE_STATUSES.has(record.snapshot.status) || record.snapshot.status === 'closing') {
        return
      }
      this.fail(
        record,
        this.attributeHop(
          new SshFailureError('connection-timeout').failure,
          record.snapshot.activeHop,
        ),
      )
    }, this.connectGuardMs)

    void this.establish(record).catch(() => {
      this.fail(record, new SshFailureError('internal').failure)
    })

    await record.milestone.wait()
    return { session: cloneSnapshot(record.snapshot), reused: false }
  }

  /**
   * Aborts only the connection attempt owned by one renderer tab. This is
   * intentionally a narrow operation: it never touches another tab's session,
   * never closes an already-established connection, and is safe to call
   * repeatedly (later calls observe `disconnected` and report `cancelled:false`).
   */
  async cancelConnect(rawClientId: string): Promise<SshConnectCancelAck> {
    this.assertUsable()
    const parsed = sshClientIdSchema.safeParse(rawClientId)
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', 'SSH 客户端标识格式无效。')
    }

    const record = this.findSessionByClientId(parsed.data)
    if (!record) return { cancelled: false, session: null }
    if (!CANCELLABLE_STATUSES.has(record.snapshot.status)) {
      return { cancelled: false, session: cloneSnapshot(record.snapshot) }
    }

    // Mark the record user-closed before any teardown so late `ready`, `error`
    // or `close` events cannot promote the cancelled attempt to connected.
    record.userClosed = true
    this.clearReadyGuard(record)
    // Finalize before destroying transports: `finalizeDisconnected` cancels a
    // pending host-key verifier, and the destroyed clients' subsequent `close`
    // events must observe the terminal `cancelled` state instead of replacing
    // it with a neutral disconnect.
    this.finalizeDisconnected(record, new SshFailureError('cancelled').failure)
    this.destroyClients(record)
    return { cancelled: true, session: cloneSnapshot(record.snapshot) }
  }

  async disconnect(rawSessionId: string): Promise<SshSessionSnapshot> {
    this.assertUsable()
    const record = this.requireSession(rawSessionId)
    if (!ACTIVE_STATUSES.has(record.snapshot.status)) {
      return cloneSnapshot(record.snapshot)
    }
    if (record.disconnectPromise) return record.disconnectPromise

    const operation = this.performDisconnect(record).finally(() => {
      if (record.disconnectPromise === operation) record.disconnectPromise = null
    })
    record.disconnectPromise = operation
    return operation
  }

  private async performDisconnect(record: SessionRecord): Promise<SshSessionSnapshot> {
    record.userClosed = true
    this.clearReadyGuard(record)
    this.cancelPendingHostKey(record, false)
    this.closeShellForRecord(record)
    this.closeForwarding(record)

    // The target depends on the jump chain: release it first, then the hops
    // from the outermost inward so no transport outlives its dependency.
    const clients: SshClientLike[] = []
    if (record.client) clients.push(record.client)
    for (let index = record.hops.length - 1; index >= 0; index -= 1) {
      const hopClient = record.hops[index].client
      if (hopClient) clients.push(hopClient)
    }

    if (clients.length === 0) {
      this.finalizeDisconnected(record, null)
      return cloneSnapshot(record.snapshot)
    }

    this.setStatus(record, 'closing')
    for (const client of clients) {
      try {
        client.end()
      } catch {
        // Fall through to the force-destroy path below.
      }
    }

    const graceTimer = makeTimer(() => {
      if (!record.closed.isSettled) {
        this.destroyClients(record)
        this.finalizeDisconnected(record, null)
      }
    }, this.disconnectGraceMs)

    await record.closed.wait()
    clearTimeout(graceTimer)
    return cloneSnapshot(record.snapshot)
  }

  getStatus(rawSessionId: string): Promise<SshSessionSnapshot> {
    this.assertUsable()
    return Promise.resolve(cloneSnapshot(this.requireSession(rawSessionId).snapshot))
  }

  /**
   * Main-process-only accessor used by the SFTP service. The returned client is
   * never serialized over IPC, and ownership/connectivity is revalidated here.
   */
  getSftpClient(rawSessionId: string): SshClientLike {
    this.assertUsable()
    const record = this.requireSession(rawSessionId)
    if (record.snapshot.status !== 'connected' || !record.client) {
      throw new AppOperationError(
        'unavailable',
        record.snapshot.status === 'error' || record.snapshot.status === 'disconnected'
          ? 'SSH 连接已断开，无法使用 SFTP。'
          : 'SSH 会话尚未连接完成，SFTP 暂不可用。',
      )
    }
    return record.client
  }

  /**
   * Main-process-only narrow facade for port forwarding. It binds to the
   * session's final target client and never exposes that client itself.
   */
  acquireForwardingSession(rawSessionId: string): SshForwardingSession {
    this.assertUsable()
    const record = this.requireSession(rawSessionId)
    if (record.snapshot.status !== 'connected' || !record.client) {
      throw new AppOperationError(
        'unavailable',
        record.snapshot.status === 'error' || record.snapshot.status === 'disconnected'
          ? 'SSH 连接已断开，无法启动端口转发。'
          : 'SSH 会话尚未连接完成，端口转发暂不可用。',
      )
    }

    if (record.forwardingSession && !record.forwardingSession.closed) {
      return record.forwardingSession
    }

    const session = new SshForwardingSessionHandle({
      sessionId: record.snapshot.sessionId,
      client: record.client,
    })
    record.forwardingSession = session
    return session
  }

  async openShell(rawSessionId: string, rawSize: unknown): Promise<TerminalOpenResult> {
    this.assertUsable()
    const record = this.requireConnectedSession(rawSessionId)
    const size = this.parseTerminalSize(rawSize)
    return this.shells.open(record.snapshot.sessionId, record.client as SshClientLike, size)
  }

  async writeShell(rawSessionId: string, rawData: unknown): Promise<TerminalAck> {
    this.assertUsable()
    const record = this.requireConnectedSession(rawSessionId)
    const parsed = terminalWriteDataSchema.safeParse(rawData)
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '终端输入格式无效。')
    }
    return this.shells.write(record.snapshot.sessionId, parsed.data)
  }

  async resizeShell(rawSessionId: string, rawSize: unknown): Promise<TerminalAck> {
    this.assertUsable()
    const record = this.requireConnectedSession(rawSessionId)
    const size = this.parseTerminalSize(rawSize)
    return this.shells.resize(record.snapshot.sessionId, size)
  }

  async closeShell(rawSessionId: string): Promise<TerminalAck> {
    this.assertUsable()
    const record = this.requireSession(rawSessionId)
    this.shells.close(record.snapshot.sessionId)
    return { sessionId: record.snapshot.sessionId }
  }

  getShellStatus(rawSessionId: string): Promise<TerminalShellSnapshot> {
    this.assertUsable()
    const record = this.requireSession(rawSessionId)
    return Promise.resolve(this.shells.getStatus(record.snapshot.sessionId))
  }

  async respondToHostKey(rawRequestId: string, accepted: boolean): Promise<SshHostKeyResponseAck> {
    this.assertUsable()
    const parsed = respondHostKeyInputSchema.safeParse({
      requestId: rawRequestId,
      accepted,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '主机密钥确认参数无效。')
    }

    const record = this.findSessionByRequestId(parsed.data.requestId)
    const pending = record?.pendingHostKey
    if (!record || !pending) {
      throw new AppOperationError('not-found', '主机密钥确认请求不存在或已失效。')
    }

    record.pendingHostKey = null
    if (pending.timer) clearTimeout(pending.timer)

    if (!parsed.data.accepted) {
      this.failHostKey(
        record,
        this.attributeHop(new SshFailureError('host-key-rejected').failure, pending.hop),
        () => this.invokeVerifier(pending, false),
      )
      return { requestId: pending.requestId, accepted: false }
    }

    this.setStatus(record, 'authenticating')
    try {
      await this.dependencies.hostKeys.trust(pending.presented)
    } catch {
      this.failHostKey(
        record,
        this.attributeHop(new SshFailureError('host-key-storage-failed').failure, pending.hop),
        () => this.invokeVerifier(pending, false),
      )
      throw new AppOperationError(
        'storage-write-failed',
        '无法保存主机密钥信任决定，连接已取消；未自动信任该密钥。',
      )
    }

    if (record.disposed || record.userClosed || record.snapshot.status === 'error') {
      this.invokeVerifier(pending, false)
      return { requestId: pending.requestId, accepted: false }
    }

    // Only the target's key belongs in the snapshot; hop keys are tracked by
    // their own HostKeyStore records and never become the target's identity.
    if (!pending.hop) record.snapshot.hostKey = pending.presented
    this.invokeVerifier(pending, true)
    this.emitStatus(record)
    return { requestId: pending.requestId, accepted: true }
  }

  async saveCredential(input: SshCredentialInput): Promise<SshCredentialAck> {
    this.assertUsable()
    const parsed = sshCredentialInputSchema.safeParse(input)
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '凭据参数未通过校验。')
    }
    const catalog = await this.dependencies.connections.list()
    const connection = catalog.connections.find((item) => item.id === parsed.data.connectionId)
    if (!connection) {
      throw new AppOperationError('not-found', '找不到该连接，可能已被删除。')
    }

    await this.dependencies.credentialResolver.saveCredential(
      connection,
      parsed.data.kind,
      parsed.data.secret,
    )
    return { connectionId: connection.id, kind: parsed.data.kind }
  }

  /** Aborts every live session, e.g. when the only window is closed. */
  cancelAll(): void {
    for (const record of this.sessions.values()) {
      if (!ACTIVE_STATUSES.has(record.snapshot.status)) continue
      record.userClosed = true
      this.clearReadyGuard(record)
      this.cancelPendingHostKey(record, false)
      this.closeShellForRecord(record)
      this.destroyClients(record)
      this.finalizeDisconnected(record, new SshFailureError('cancelled').failure)
    }
  }

  /** Final cleanup for application shutdown. The instance is not reusable. */
  dispose(): void {
    if (this.disposed) return
    this.shells.dispose()
    for (const record of this.sessions.values()) {
      record.disposed = true
      record.userClosed = true
      this.clearReadyGuard(record)
      this.cancelPendingHostKey(record, false)
      this.notifySessionTerminated(record)
      this.destroyClients(record)
      record.snapshot.status = 'disconnected'
      record.milestone.fire()
      record.closed.fire()
      this.shells.forget(record.snapshot.sessionId)
    }
    this.sessions.clear()
    this.disposed = true
  }

  private createRecord(
    connection: ConnectionProfile,
    clientId: string,
    jumpPlan: ConnectionProfile[],
  ): SessionRecord {
    const sessionId = `ssh-${randomUUID()}`
    const hops: HopRecord[] = jumpPlan.map((jump, index) => ({
      connection: jump,
      info: makeHopInfo(index + 1, jump),
      client: null,
      outboundChannel: null,
      ready: new Signal(),
      closed: new Signal(),
    }))
    return {
      snapshot: {
        clientId,
        sessionId,
        connectionId: connection.id,
        connectionName: connection.name,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        authMethod: connection.authMethod,
        status: 'connecting',
        jumps: hops.map((hop) => hop.info),
        activeHop: null,
        createdAt: this.now().toISOString(),
        connectedAt: null,
        hostKey: null,
        error: null,
      },
      connection: structuredClone(connection),
      hops,
      client: null,
      forwardingSession: null,
      pendingHostKey: null,
      pendingCloses: 0,
      milestone: new Signal(),
      closed: new Signal(),
      readyGuard: null,
      userClosed: false,
      disposed: false,
      disconnectPromise: null,
      terminatedNotified: false,
    }
  }

  private async establish(record: SessionRecord): Promise<void> {
    if (this.isAborted(record)) {
      record.milestone.fire()
      return
    }

    // Hops are dialed strictly in order: hop 1 directly, every later hop and
    // the target through a `forwardOut` channel of the previous transport.
    for (let index = 0; index < record.hops.length; index += 1) {
      if (this.isAborted(record)) return
      const hop = record.hops[index]
      this.setActiveHop(record, hop.info)

      const inbound = index > 0 ? record.hops[index - 1].outboundChannel : null
      const connected = await this.connectHop(record, hop, inbound)
      if (!connected || this.isAborted(record)) return

      const nextHop = record.hops[index + 1] ?? null
      this.setActiveHop(record, nextHop ? nextHop.info : null)
      const channel = await this.openForward(
        record,
        hop,
        nextHop ? nextHop.connection : record.connection,
        nextHop ? nextHop.info : null,
      )
      if (!channel || this.isAborted(record)) return
      hop.outboundChannel = channel
    }

    this.setActiveHop(record, null)
    await this.connectTarget(record, record.hops.at(-1)?.outboundChannel ?? null)
  }

  private async connectHop(
    record: SessionRecord,
    hop: HopRecord,
    inbound: ClientChannel | null,
  ): Promise<boolean> {
    let auth: ResolvedSshAuth
    try {
      auth = await this.dependencies.credentialResolver.resolve(hop.connection)
    } catch (error) {
      if (record.disposed || record.userClosed) {
        record.milestone.fire()
        return false
      }
      this.fail(record, this.toFailure(error, hop.connection, hop.info))
      return false
    }

    if (this.isAborted(record)) return false

    let client: SshClientLike
    try {
      client = this.dependencies.createClient()
    } catch {
      this.fail(record, this.attributeHop(new SshFailureError('internal').failure, hop.info))
      return false
    }
    hop.client = client
    record.pendingCloses += 1
    this.bindChainClient(record, client, hop)

    const config: ConnectConfig = {
      host: hop.connection.host,
      port: hop.connection.port,
      username: hop.connection.username,
      readyTimeout: this.readyTimeoutMs,
      keepaliveInterval: this.keepaliveIntervalMs,
      keepaliveCountMax: this.keepaliveCountMax,
      hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
        this.handleHostKey(record, key, verify, hop.info)
      },
      ...(inbound ? { sock: inbound } : {}),
      ...this.authConnectOptions(auth),
    }

    this.setStatus(record, 'authenticating')
    try {
      client.connect(config)
    } catch (error) {
      this.fail(record, this.toFailure(error, hop.connection, hop.info))
      return false
    }

    await Promise.race([hop.ready.wait(), hop.closed.wait()])
    if (this.isAborted(record) || !hop.ready.isSettled) return false
    return true
  }

  private openForward(
    record: SessionRecord,
    from: HopRecord,
    nextConnection: ConnectionProfile,
    nextHop: SshJumpHop | null,
  ): Promise<ClientChannel | null> {
    const client = from.client
    if (!client) return Promise.resolve(null)

    return new Promise((resolve) => {
      const failForward = (error: unknown): void => {
        if (!record.disposed && !this.isAborted(record)) {
          // The dialed endpoint is the next hop (or the target), so the
          // failure belongs to it rather than to the transport we dialed from.
          this.fail(record, this.toFailure(error, nextConnection, nextHop))
        }
        resolve(null)
      }

      try {
        client.forwardOut(
          '127.0.0.1',
          0,
          nextConnection.host,
          nextConnection.port,
          (error, channel) => {
            if (error) {
              failForward(error)
              return
            }
            resolve(channel)
          },
        )
      } catch (error) {
        failForward(error)
      }
    })
  }

  private async connectTarget(record: SessionRecord, inbound: ClientChannel | null): Promise<void> {
    let auth: ResolvedSshAuth
    try {
      auth = await this.dependencies.credentialResolver.resolve(record.connection)
    } catch (error) {
      if (record.disposed || record.userClosed) {
        record.milestone.fire()
        return
      }
      this.fail(record, this.toFailure(error, record.connection))
      return
    }

    if (this.isAborted(record)) {
      record.milestone.fire()
      return
    }

    let client: SshClientLike
    try {
      client = this.dependencies.createClient()
    } catch {
      this.fail(record, new SshFailureError('internal').failure)
      return
    }
    record.client = client
    record.pendingCloses += 1
    this.bindChainClient(record, client, null)

    const config: ConnectConfig = {
      host: record.connection.host,
      port: record.connection.port,
      username: record.connection.username,
      readyTimeout: this.readyTimeoutMs,
      keepaliveInterval: this.keepaliveIntervalMs,
      keepaliveCountMax: this.keepaliveCountMax,
      hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
        this.handleHostKey(record, key, verify, null)
      },
      ...(inbound ? { sock: inbound } : {}),
      ...this.authConnectOptions(auth),
    }

    this.setStatus(record, 'authenticating')
    try {
      client.connect(config)
    } catch (error) {
      this.fail(record, this.toFailure(error, record.connection))
    }
  }

  private authConnectOptions(auth: ResolvedSshAuth): Partial<ConnectConfig> {
    return {
      ...(auth.method === 'password' ? { password: auth.password } : {}),
      ...(auth.method === 'privateKey'
        ? {
            privateKey: auth.privateKey,
            ...(auth.passphrase ? { passphrase: auth.passphrase } : {}),
          }
        : {}),
      ...(auth.method === 'sshAgent' ? { agent: auth.agent } : {}),
    }
  }

  private bindChainClient(
    record: SessionRecord,
    client: SshClientLike,
    hop: HopRecord | null,
  ): void {
    client.on('ready', () => this.handleReady(record, hop))
    client.on('error', (error: unknown) => this.handleError(record, error, hop))
    client.on('close', () => this.handleClose(record, hop))
  }

  private setActiveHop(record: SessionRecord, hop: SshJumpHop | null): void {
    if (record.snapshot.activeHop === hop) return
    record.snapshot.activeHop = hop
    this.emitStatus(record)
  }

  private handleReady(record: SessionRecord, hop: HopRecord | null): void {
    if (record.disposed || record.userClosed) {
      this.destroyClients(record)
      return
    }
    if (hop) {
      // Hop readiness only advances the chain; the session is not connected
      // until the final target reports ready.
      hop.ready.fire()
      return
    }
    this.clearReadyGuard(record)
    record.snapshot.connectedAt = this.now().toISOString()
    record.snapshot.error = null
    this.setStatus(record, 'connected')
    record.milestone.fire()
  }

  private handleError(record: SessionRecord, error: unknown, hop: HopRecord | null): void {
    if (record.disposed) return
    if (record.snapshot.status === 'error' || record.snapshot.status === 'disconnected') return
    if (record.userClosed || record.snapshot.status === 'closing') {
      return
    }

    const failure = this.toFailure(
      error,
      hop ? hop.connection : record.connection,
      hop ? hop.info : null,
    )
    if (record.snapshot.status === 'connected') {
      this.closeShellForRecord(record)
      this.finalizeDisconnected(record, failure)
      this.destroyClients(record)
      return
    }
    this.fail(record, failure)
  }

  private handleClose(record: SessionRecord, hop: HopRecord | null): void {
    if (hop) {
      hop.client = null
      hop.closed.fire()
    } else {
      record.client = null
    }
    if (record.pendingCloses > 0) record.pendingCloses -= 1
    if (record.pendingCloses === 0) record.closed.fire()

    if (record.disposed) return

    this.clearReadyGuard(record)
    this.cancelPendingHostKey(record, false)
    this.closeShellForRecord(record)

    if (record.snapshot.status === 'error' || record.snapshot.status === 'disconnected') {
      return
    }

    if (record.snapshot.status === 'closing' || record.userClosed) {
      // The explicit-disconnect path finalizes once the whole chain is closed.
      if (record.pendingCloses === 0) this.finalizeDisconnected(record, null)
      return
    }

    if (record.snapshot.connectedAt !== null) {
      this.finalizeDisconnected(
        record,
        this.attributeHop(new SshFailureError('remote-closed').failure, hop ? hop.info : null),
      )
      this.destroyClients(record)
      return
    }

    this.fail(
      record,
      record.snapshot.error ??
        this.attributeHop(new SshFailureError('network-error').failure, hop ? hop.info : null),
    )
  }

  private handleHostKey(
    record: SessionRecord,
    key: Buffer,
    verify: (accepted: boolean) => void,
    hop: SshJumpHop | null,
  ): void {
    if (record.disposed || record.userClosed || record.snapshot.status === 'error') {
      verify(false)
      return
    }

    let parsed: ReturnType<typeof parseHostKeyBlob>
    try {
      parsed = parseHostKeyBlob(key)
    } catch (error) {
      const failure =
        error instanceof SshFailureError
          ? error.failure
          : new SshFailureError('host-key-verification-failed').failure
      this.failHostKey(record, this.attributeHop(failure, hop), verify)
      return
    }

    // Every hop is verified as its own endpoint: the presented key is keyed by
    // that endpoint's host/port, so jump hosts and the target can never share a
    // trust record. A jump being trusted never implies trust for the target.
    const presented: PresentedHostKey = {
      host: hop ? hop.host : record.connection.host,
      port: hop ? hop.port : record.connection.port,
      algorithm: parsed.algorithm,
      fingerprint: parsed.fingerprint,
    }
    if (!hop) record.snapshot.hostKey = presented
    void this.evaluateHostKey(record, presented, verify, hop).catch(() => {
      this.failHostKey(
        record,
        this.attributeHop(new SshFailureError('host-key-verification-failed').failure, hop),
        verify,
      )
    })
  }

  private async evaluateHostKey(
    record: SessionRecord,
    presented: PresentedHostKey,
    verify: (accepted: boolean) => void,
    hop: SshJumpHop | null,
  ): Promise<void> {
    let verdict: Awaited<ReturnType<HostKeyStore['verify']>>
    try {
      verdict = await this.dependencies.hostKeys.verify(presented)
    } catch {
      this.failHostKey(
        record,
        this.attributeHop(new SshFailureError('host-key-storage-failed').failure, hop),
        verify,
      )
      return
    }

    if (this.isAborted(record)) {
      verify(false)
      return
    }

    if (verdict === 'changed') {
      this.failHostKey(
        record,
        this.attributeHop(new SshFailureError('host-key-changed').failure, hop),
        verify,
      )
      return
    }

    if (verdict === 'trusted') {
      verify(true)
      return
    }

    const expiresAt = new Date(this.now().getTime() + this.hostKeyTimeoutMs).toISOString()
    const pending: PendingHostKey = {
      requestId: `hk-${randomUUID()}`,
      presented,
      hop,
      verify,
      timer: null,
      expiresAt,
    }
    record.pendingHostKey = pending
    this.setStatus(record, 'awaiting-host-key')
    pending.timer = makeTimer(() => {
      if (record.pendingHostKey?.requestId !== pending.requestId) return
      record.pendingHostKey = null
      this.failHostKey(
        record,
        this.attributeHop(new SshFailureError('host-key-timeout').failure, hop),
        () => this.invokeVerifier(pending, false),
      )
    }, this.hostKeyTimeoutMs)
    this.emitHostKeyChallenge(record, pending)
    record.milestone.fire()
  }

  private emitHostKeyChallenge(record: SessionRecord, pending: PendingHostKey): void {
    const challenge: HostKeyChallenge = {
      requestId: pending.requestId,
      sessionId: record.snapshot.sessionId,
      connectionId: record.snapshot.connectionId,
      connectionName: record.snapshot.connectionName,
      host: pending.presented.host,
      port: pending.presented.port,
      algorithm: pending.presented.algorithm,
      fingerprint: pending.presented.fingerprint,
      expiresAt: pending.expiresAt,
      ...(pending.hop ? { hop: pending.hop } : {}),
    }
    try {
      this.dependencies.emitHostKeyRequest({ challenge })
    } catch {
      // Renderer transport failures must never turn into an implicit trust.
    }
  }

  private fail(record: SessionRecord, failure: SshFailure): void {
    if (record.disposed) return
    this.clearReadyGuard(record)
    this.cancelPendingHostKey(record, false)
    this.closeShellForRecord(record)
    if (record.snapshot.status !== 'error') {
      record.snapshot.error = failure
      this.setStatus(record, 'error')
    }
    this.notifySessionTerminated(record)
    record.milestone.fire()
    this.destroyClients(record)
  }

  private finalizeDisconnected(record: SessionRecord, failure: SshFailure | null): void {
    this.clearReadyGuard(record)
    this.cancelPendingHostKey(record, false)
    this.closeForwarding(record)
    record.snapshot.error = failure
    record.snapshot.status = 'disconnected'
    this.notifySessionTerminated(record)
    this.emitStatus(record)
    record.milestone.fire()
    record.closed.fire()
    // The SSH transport is gone, so its PTY runtime can no longer be operated.
    // Renderer history is owned separately and is not affected by this cleanup.
    this.shells.forget(record.snapshot.sessionId)
  }

  private setStatus(record: SessionRecord, status: SshSessionStatus): void {
    if (record.snapshot.status === status) {
      this.emitStatus(record)
      return
    }
    record.snapshot.status = status
    this.emitStatus(record)
  }

  private emitStatus(record: SessionRecord): void {
    try {
      this.dependencies.emitStatus({ session: cloneSnapshot(record.snapshot) })
    } catch {
      // The main-process state remains authoritative even if a window is gone.
    }
  }

  /**
   * Stores the specific failure before releasing ssh2's verifier. A denial
   * emits ssh2's generic "Host denied" error synchronously; notifying it first
   * would let that generic error claim the terminal status.
   */
  private failHostKey(
    record: SessionRecord,
    failure: SshFailure,
    verify: (accepted: boolean) => void,
  ): void {
    this.fail(record, failure)
    try {
      verify(false)
    } catch {
      // The SSH transport may already be torn down.
    }
  }

  private cancelPendingHostKey(record: SessionRecord, accepted: boolean): void {
    const pending = record.pendingHostKey
    if (!pending) return
    record.pendingHostKey = null
    if (pending.timer) clearTimeout(pending.timer)
    this.invokeVerifier(pending, accepted)
  }

  private invokeVerifier(pending: PendingHostKey, accepted: boolean): void {
    try {
      pending.verify(accepted)
    } catch {
      // ssh2 already moved on; trust is never inferred from a callback failure.
    }
  }

  private destroyClients(record: SessionRecord): void {
    this.closeForwarding(record)
    const clients: SshClientLike[] = []
    if (record.client) clients.push(record.client)
    for (const hop of record.hops) {
      if (hop.client) clients.push(hop.client)
    }
    for (const client of clients) {
      try {
        client.destroy()
      } catch {
        // Best-effort teardown; the record is already terminal.
      }
    }
  }

  private clearReadyGuard(record: SessionRecord): void {
    if (record.readyGuard) {
      clearTimeout(record.readyGuard)
      record.readyGuard = null
    }
  }

  private closeForwarding(record: SessionRecord): void {
    const session = record.forwardingSession
    if (!session) return
    record.forwardingSession = null
    try {
      session.close()
    } catch {
      // The facade is best-effort during teardown; SSH teardown must proceed.
    }
  }

  private isAborted(record: SessionRecord): boolean {
    return (
      record.disposed ||
      record.userClosed ||
      record.snapshot.status === 'error' ||
      record.snapshot.status === 'disconnected' ||
      record.snapshot.status === 'closing'
    )
  }

  private discardRecord(record: SessionRecord): void {
    this.clearReadyGuard(record)
    this.cancelPendingHostKey(record, false)
    this.closeShellForRecord(record)
    this.shells.forget(record.snapshot.sessionId)
    this.notifySessionTerminated(record)
    record.userClosed = true
    record.disposed = true
    this.destroyClients(record)
    record.milestone.fire()
    record.closed.fire()
    this.sessions.delete(record.snapshot.sessionId)
  }

  private notifySessionTerminated(record: SessionRecord): void {
    if (record.terminatedNotified) return
    record.terminatedNotified = true
    try {
      this.dependencies.onSessionTerminated?.(record.snapshot.sessionId)
    } catch {
      // SFTP cleanup is best-effort and must never block SSH teardown.
    }
  }

  private findSessionByClientId(clientId: string): SessionRecord | null {
    for (const record of this.sessions.values()) {
      if (record.snapshot.clientId === clientId) return record
    }
    return null
  }

  private findSessionByRequestId(requestId: string): SessionRecord | null {
    for (const record of this.sessions.values()) {
      if (record.pendingHostKey?.requestId === requestId) return record
    }
    return null
  }

  private countActiveSessions(): number {
    let count = 0
    for (const record of this.sessions.values()) {
      if (ACTIVE_STATUSES.has(record.snapshot.status)) count += 1
    }
    return count
  }

  private requireSession(rawSessionId: string): SessionRecord {
    const parsed = sshSessionIdSchema.safeParse(rawSessionId)
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', 'SSH 会话 ID 格式无效。')
    }
    const record = this.sessions.get(parsed.data)
    if (!record) {
      throw new AppOperationError('not-found', '找不到该 SSH 会话，可能已断开或已释放。')
    }
    return record
  }

  private requireConnectedSession(rawSessionId: string): SessionRecord {
    const record = this.requireSession(rawSessionId)
    if (record.snapshot.status !== 'connected' || !record.client) {
      throw new AppOperationError(
        'unavailable',
        record.snapshot.status === 'error' || record.snapshot.status === 'disconnected'
          ? 'SSH 连接已断开，无法操作远程 Shell。'
          : 'SSH 会话尚未连接完成，无法操作远程 Shell。',
      )
    }
    return record
  }

  private parseTerminalSize(rawSize: unknown): TerminalSize {
    const parsed = terminalSizeSchema.safeParse(rawSize)
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '终端尺寸参数无效。')
    }
    return parsed.data
  }

  private closeShellForRecord(record: SessionRecord): void {
    this.shells.closeForSession(record.snapshot.sessionId, 'ssh-closed', SSH_SHELL_DISCONNECTED)
  }

  private toFailure(
    error: unknown,
    connection: ConnectionProfile,
    hop: SshJumpHop | null = null,
  ): SshFailure {
    const failure =
      error instanceof SshFailureError
        ? error.failure
        : mapSshClientError(error, connection.authMethod)
    return this.attributeHop(failure, hop)
  }

  private attributeHop(failure: SshFailure, hop: SshJumpHop | null): SshFailure {
    if (!hop) return failure
    return { ...failure, hop }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new AppOperationError('internal', '应用正在退出，SSH 连接服务已停止。')
    }
  }
}
