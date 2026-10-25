import { PORT_FORWARD_LIMITS } from '../../../shared/constants/portForward'
import { isLoopbackAddress } from '../../../shared/portForward/address'
import type {
  ConnectionRemovalImpact,
  PortForwardCreateInput,
  PortForwardFailure,
  PortForwardItem,
  PortForwardRemoveAck,
  PortForwardRule,
  PortForwardRuntime,
  PortForwardSnapshot,
  PortForwardStopReason,
  PortForwardUpdateInput,
  PortForwardUpdateEvent,
  StartPortForwardInput,
} from '../../../shared/types/portForward'
import type { SshSessionSnapshot } from '../../../shared/types/ssh'
import { AppOperationError } from '../../errors'
import type { ConnectionStore } from '../../storage/connectionRepository'
import type { PortForwardStore } from '../../storage/portForwardRepository'
import type { SshForwardingSession } from '../ssh/SshForwardingSession'
import { startDynamicForward } from './dynamicForward'
import { ForwardRuntimeError } from './forwardRuntimeErrors'
import { startLocalForward } from './localForward'
import { startRemoteForward } from './remoteForward'
import type { ForwardRuntimeEvents, ForwardRuntimeHandle } from './runtime'

interface RuleState {
  rule: PortForwardRule
  runtime: PortForwardRuntime
  handle: ForwardRuntimeHandle | null
  facade: SshForwardingSession | null
  unsubscribeClosed: (() => void) | null
  /** Invalidates callbacks from a torn-down runtime instance. */
  generation: number
  queue: Promise<void>
}

export interface PortForwardServiceDependencies {
  store: PortForwardStore
  connections: Pick<ConnectionStore, 'list'>
  ssh: {
    getStatus(sessionId: string): Promise<SshSessionSnapshot>
    acquireForwardingSession(sessionId: string): SshForwardingSession
  }
  emitUpdate?: (event: PortForwardUpdateEvent) => void
  now?: () => Date
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
  stopTimeoutMs?: number
}

export interface PortForwardServicePort {
  list(): Promise<PortForwardSnapshot>
  create(input: PortForwardCreateInput): Promise<PortForwardItem>
  update(id: string, input: PortForwardUpdateInput): Promise<PortForwardItem>
  remove(id: string): Promise<PortForwardRemoveAck>
  start(input: StartPortForwardInput): Promise<PortForwardItem>
  stop(id: string): Promise<PortForwardItem>
  getConnectionRemovalImpact(connectionId: string): Promise<ConnectionRemovalImpact>
  removeForConnection(connectionId: string): Promise<string[]>
  shutdown(): Promise<void>
}

function stoppedRuntime(
  ruleId: string,
  lastStopReason: PortForwardStopReason = null,
): PortForwardRuntime {
  return {
    ruleId,
    status: 'stopped',
    sessionId: null,
    boundAddress: null,
    boundPort: null,
    activeConnections: 0,
    startedAt: null,
    lastStopReason,
    failure: null,
    cleanupPending: false,
  }
}

function requiresExposureConfirmation(rule: PortForwardRule): boolean {
  return rule.type !== 'dynamic' && !isLoopbackAddress(rule.bindAddress)
}

function startFailure(error: unknown): PortForwardFailure {
  if (error instanceof ForwardRuntimeError) return error.failure
  return {
    code: 'internal',
    message: '端口转发未能启动，请稍后重试。',
  }
}

function stopFailure(error: unknown): PortForwardFailure {
  if (error instanceof ForwardRuntimeError) return error.failure
  return {
    code: 'cleanup-failed',
    message: '端口转发资源未能完全清理，请重试停止。',
  }
}

function cloneItem(state: RuleState): PortForwardItem {
  return {
    rule: structuredClone(state.rule),
    runtime: {
      ...state.runtime,
      failure: state.runtime.failure ? { ...state.runtime.failure } : null,
    },
  }
}

/**
 * Authoritative state machine for forwarding rules. The renderer only mirrors
 * snapshots emitted from here; a rule is never marked running until the
 * listener (local or remote) actually exists.
 */
export class PortForwardService implements PortForwardServicePort {
  private readonly states = new Map<string, RuleState>()
  private readonly now: () => Date
  private readonly connectTimeoutMs: number
  private readonly handshakeTimeoutMs: number
  private readonly stopTimeoutMs: number
  private readonly gate: { tryAcquire(): boolean; release(): void }
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private revision = 0
  private shuttingDown = false
  private globalConnections = 0

  constructor(private readonly dependencies: PortForwardServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.connectTimeoutMs =
      dependencies.connectTimeoutMs ?? PORT_FORWARD_LIMITS.connectTimeoutMs
    this.handshakeTimeoutMs =
      dependencies.handshakeTimeoutMs ?? PORT_FORWARD_LIMITS.handshakeTimeoutMs
    this.stopTimeoutMs = dependencies.stopTimeoutMs ?? PORT_FORWARD_LIMITS.stopTimeoutMs
    this.gate = {
      tryAcquire: () => {
        if (this.globalConnections >= PORT_FORWARD_LIMITS.maxGlobalConnections) return false
        this.globalConnections += 1
        return true
      },
      release: () => {
        if (this.globalConnections > 0) this.globalConnections -= 1
      },
    }
  }

  async list(): Promise<PortForwardSnapshot> {
    await this.ensureLoaded()
    return this.snapshot()
  }

  async create(input: PortForwardCreateInput): Promise<PortForwardItem> {
    await this.ensureLoaded()
    const catalog = await this.dependencies.connections.list()
    if (!catalog.connections.some((connection) => connection.id === input.connectionId)) {
      throw new AppOperationError('not-found', '连接配置不存在，无法创建端口转发规则。')
    }

    const rule = await this.dependencies.store.create(input)
    const state = this.createState(rule)
    this.states.set(rule.id, state)
    this.publish()
    return cloneItem(state)
  }

  async update(id: string, input: PortForwardUpdateInput): Promise<PortForwardItem> {
    await this.ensureLoaded()
    const state = this.requireRule(id)
    return this.exclusive(state, async () => {
      if (this.states.get(state.rule.id) !== state) this.throwMissingRule()
      this.assertNotBusy(state, '请先停止该规则并等待清理完成后再编辑。')

      const rule = await this.dependencies.store.update(state.rule.id, input)
      state.rule = rule
      state.runtime = stoppedRuntime(rule.id)
      this.publish()
      return cloneItem(state)
    })
  }

  async remove(id: string): Promise<PortForwardRemoveAck> {
    await this.ensureLoaded()
    const state = this.requireRule(id)
    return this.exclusive(state, async () => {
      if (this.states.get(state.rule.id) !== state) this.throwMissingRule()
      this.assertNotBusy(state, '请先停止该规则并等待清理完成后再删除。')

      await this.dependencies.store.remove(state.rule.id)
      this.detachFacade(state)
      state.handle = null
      this.states.delete(state.rule.id)
      this.publish()
      return { id: state.rule.id }
    })
  }

  async start(input: StartPortForwardInput): Promise<PortForwardItem> {
    await this.ensureLoaded()
    const state = this.requireRule(input.ruleId)

    return this.exclusive(state, async () => {
      if (this.states.get(state.rule.id) !== state) this.throwMissingRule()
      if (this.shuttingDown) {
        throw new AppOperationError('unavailable', '应用正在退出，无法启动端口转发。')
      }
      this.assertNotBusy(state, '该规则已在运行或正在停止。')
      const rule = state.rule
      if (requiresExposureConfirmation(rule) && input.confirmExposure !== true) {
        throw new AppOperationError(
          'permission-denied',
          `监听 ${rule.bindAddress}:${rule.bindPort} 会向非回环地址暴露端口，请先确认暴露风险。`,
        )
      }

      const catalog = await this.dependencies.connections.list()
      if (!catalog.connections.some((connection) => connection.id === state.rule.connectionId)) {
        throw new AppOperationError('not-found', '转发规则关联的连接配置已不存在。')
      }

      const session = await this.dependencies.ssh.getStatus(input.sessionId)
      if (session.status !== 'connected') {
        throw new AppOperationError(
          'unavailable',
          session.status === 'error' || session.status === 'disconnected'
            ? 'SSH 连接已断开，无法启动端口转发。'
            : 'SSH 会话尚未连接完成，端口转发暂不可用。',
        )
      }
      if (session.connectionId !== state.rule.connectionId) {
        throw new AppOperationError('conflict', 'SSH 会话与转发规则关联的连接不一致。')
      }

      // Everything below runs in one synchronous turn so two concurrent starts
      // cannot both claim the last active-rule slot.
      if (this.activeRuleCount() >= PORT_FORWARD_LIMITS.maxActiveRules) {
        throw new AppOperationError(
          'limit-exceeded',
          `同时运行的端口转发规则已达到上限（${PORT_FORWARD_LIMITS.maxActiveRules} 条）。`,
        )
      }
      const facade = this.dependencies.ssh.acquireForwardingSession(session.sessionId)
      if (facade.closed) {
        throw new AppOperationError('unavailable', 'SSH 会话已结束，无法启动端口转发。')
      }

      const generation = state.generation + 1
      state.generation = generation
      state.facade = facade
      state.runtime = {
        ruleId: state.rule.id,
        status: 'starting',
        sessionId: facade.sessionId,
        boundAddress: null,
        boundPort: null,
        activeConnections: 0,
        startedAt: null,
        lastStopReason: null,
        failure: null,
        cleanupPending: false,
      }
      this.publish()

      const events: ForwardRuntimeEvents = {
        onConnectionCountChange: (count) =>
          this.handleConnectionCount(state, generation, count),
        onUnexpectedFailure: (error) =>
          this.handleUnexpectedFailure(state, generation, error),
      }

      let handle: ForwardRuntimeHandle
      try {
        handle =
          rule.type === 'local'
            ? await startLocalForward({
                rule,
                facade,
                gate: this.gate,
                events,
                connectTimeoutMs: this.connectTimeoutMs,
                stopTimeoutMs: this.stopTimeoutMs,
              })
            : rule.type === 'remote'
              ? await startRemoteForward({
                  rule,
                  facade,
                  gate: this.gate,
                  events,
                  connectTimeoutMs: this.connectTimeoutMs,
                  stopTimeoutMs: this.stopTimeoutMs,
                })
              : await startDynamicForward({
                  rule,
                  facade,
                  gate: this.gate,
                  events,
                  connectTimeoutMs: this.connectTimeoutMs,
                  handshakeTimeoutMs: this.handshakeTimeoutMs,
                  stopTimeoutMs: this.stopTimeoutMs,
                })
      } catch (error) {
        const failure = startFailure(error)
        state.generation += 1
        this.detachFacade(state)
        state.runtime = {
          ruleId: state.rule.id,
          status: 'error',
          sessionId: facade.sessionId,
          boundAddress: null,
          boundPort: null,
          activeConnections: 0,
          startedAt: null,
          lastStopReason: null,
          failure,
          cleanupPending: false,
        }
        this.publish()
        return cloneItem(state)
      }

      state.handle = handle

      // A runtime may report a post-listen failure before start resolves; its
      // recovery is already queued and owns teardown from here.
      if (state.runtime.status === 'error' || state.runtime.cleanupPending) {
        return cloneItem(state)
      }

      if (facade.closed) {
        const failure: PortForwardFailure = {
          code: 'session-ended',
          message: 'SSH 会话已结束，端口转发未能保持运行。',
        }
        try {
          await handle.stop()
        } catch (error) {
          const cleanup = stopFailure(error)
          state.runtime = {
            ...state.runtime,
            status: 'error',
            failure: cleanup,
            cleanupPending: true,
          }
          this.publish()
          return cloneItem(state)
        }

        state.handle = null
        state.generation += 1
        this.detachFacade(state)
        state.runtime = {
          ruleId: state.rule.id,
          status: 'error',
          sessionId: facade.sessionId,
          boundAddress: null,
          boundPort: null,
          activeConnections: 0,
          startedAt: null,
          lastStopReason: 'session-ended',
          failure,
          cleanupPending: false,
        }
        this.publish()
        return cloneItem(state)
      }

      state.unsubscribeClosed = facade.onClosed(() => {
        this.handleFacadeClosed(state, facade)
      })
      state.runtime = {
        ruleId: state.rule.id,
        status: 'running',
        sessionId: facade.sessionId,
        boundAddress: handle.boundAddress,
        boundPort: handle.boundPort,
        activeConnections: handle.activeConnections,
        startedAt: this.now().toISOString(),
        lastStopReason: null,
        failure: null,
        cleanupPending: false,
      }
      this.publish()
      return cloneItem(state)
    })
  }

  async stop(id: string): Promise<PortForwardItem> {
    await this.ensureLoaded()
    const state = this.requireRule(id)
    return this.exclusive(state, async () => {
      if (this.states.get(state.rule.id) !== state) this.throwMissingRule()
      return this.stopRuleLocked(state, 'user')
    })
  }

  async getConnectionRemovalImpact(connectionId: string): Promise<ConnectionRemovalImpact> {
    await this.ensureLoaded()
    const related = [...this.states.values()].filter(
      (state) => state.rule.connectionId === connectionId,
    )
    return {
      connectionId,
      portForwardRuleCount: related.length,
      runningPortForwardCount: related.filter((state) => this.isActive(state)).length,
    }
  }

  /**
   * Stops and removes every rule of a connection. Any stop/cleanup failure
   * aborts the whole operation so the caller can refuse to delete the
   * connection while forwarding resources are still alive.
   */
  async removeForConnection(connectionId: string): Promise<string[]> {
    await this.ensureLoaded()
    const related = [...this.states.values()].filter(
      (state) => state.rule.connectionId === connectionId,
    )

    const outcomes = await Promise.allSettled(
      related.map((state) =>
        this.exclusive(state, async () => {
          if (this.states.get(state.rule.id) !== state) return
          if (this.isActive(state)) {
            await this.stopRuleLocked(state, 'connection-removed')
            return
          }
          if (state.runtime.status === 'error') {
            state.runtime = stoppedRuntime(state.rule.id, 'connection-removed')
            this.publish()
          }
        }),
      ),
    )

    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new AppOperationError(
        'unavailable',
        '部分端口转发规则未能完全停止，已取消删除操作。请先重试停止相关规则。',
      )
    }

    const removed = await this.dependencies.store.removeForConnection(connectionId)
    for (const ruleId of removed.ids) {
      const state = this.states.get(ruleId)
      if (!state) continue
      this.detachFacade(state)
      state.handle = null
      this.states.delete(ruleId)
    }
    if (removed.ids.length > 0) this.publish()
    return removed.ids
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (!this.loaded) return

    const targets = [...this.states.values()].filter(
      (state) => state.handle !== null || state.runtime.status !== 'stopped',
    )
    const outcomes = await Promise.allSettled(
      targets.map((state) =>
        this.exclusive(state, async () => {
          if (this.states.get(state.rule.id) !== state) return
          if (state.handle === null && state.runtime.status === 'stopped') return
          await this.stopRuleLocked(state, 'app-quit')
        }),
      ),
    )

    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new AppOperationError('unavailable', '退出时未能完全停止所有端口转发。')
    }
  }

  private createState(rule: PortForwardRule): RuleState {
    return {
      rule,
      runtime: stoppedRuntime(rule.id),
      handle: null,
      facade: null,
      unsubscribeClosed: null,
      generation: 0,
      queue: Promise.resolve(),
    }
  }

  private requireRule(id: string): RuleState {
    const state = this.states.get(id)
    if (!state) {
      throw new AppOperationError('not-found', '找不到该端口转发规则，可能已被删除。')
    }
    return state
  }

  private throwMissingRule(): never {
    throw new AppOperationError('not-found', '找不到该端口转发规则，可能已被删除。')
  }

  private isActive(state: RuleState): boolean {
    return (
      state.handle !== null ||
      state.runtime.status === 'starting' ||
      state.runtime.status === 'running' ||
      state.runtime.status === 'stopping' ||
      state.runtime.cleanupPending
    )
  }

  private assertNotBusy(state: RuleState, busyMessage: string): void {
    if (state.runtime.cleanupPending) {
      throw new AppOperationError(
        'conflict',
        '上一次停止未能完成资源清理，请先重试停止该规则。',
      )
    }
    if (this.isActive(state)) {
      throw new AppOperationError('conflict', busyMessage)
    }
  }

  private activeRuleCount(): number {
    let count = 0
    for (const state of this.states.values()) {
      if (this.isActive(state)) count += 1
    }
    return count
  }

  private async stopRuleLocked(
    state: RuleState,
    reason: PortForwardStopReason,
  ): Promise<PortForwardItem> {
    if (state.handle === null) {
      this.detachFacade(state)
      if (state.runtime.status !== 'stopped') {
        state.runtime = stoppedRuntime(state.rule.id, reason)
        this.publish()
      }
      return cloneItem(state)
    }

    const handle = state.handle
    state.runtime = { ...state.runtime, status: 'stopping', cleanupPending: false }
    this.publish()

    try {
      await handle.stop()
    } catch (error) {
      const failure = stopFailure(error)
      state.runtime = {
        ...state.runtime,
        status: 'error',
        failure,
        cleanupPending: true,
      }
      this.publish()
      throw new AppOperationError('unavailable', failure.message)
    }

    state.handle = null
    state.generation += 1
    this.detachFacade(state)
    state.runtime = stoppedRuntime(state.rule.id, reason)
    this.publish()
    return cloneItem(state)
  }

  private handleConnectionCount(state: RuleState, generation: number, count: number): void {
    if (this.states.get(state.rule.id) !== state || state.generation !== generation) return
    if (state.runtime.activeConnections === count) return
    state.runtime = { ...state.runtime, activeConnections: count }
    this.publish()
  }

  private handleUnexpectedFailure(
    state: RuleState,
    generation: number,
    error: ForwardRuntimeError,
  ): void {
    if (this.states.get(state.rule.id) !== state || state.generation !== generation) return
    if (state.runtime.status !== 'starting' && state.runtime.status !== 'running') return

    state.runtime = {
      ...state.runtime,
      status: 'error',
      failure: error.failure,
      cleanupPending: true,
    }
    this.publish()

    void this.exclusive(state, async () => {
      if (this.states.get(state.rule.id) !== state) return
      await this.recoverRuntime(state)
    }).catch(() => {
      // The error state, including cleanupPending, is already published.
    })
  }

  private async recoverRuntime(state: RuleState): Promise<void> {
    if (state.runtime.status !== 'error') return

    const handle = state.handle
    const failure = state.runtime.failure
    if (!handle) {
      state.runtime = { ...state.runtime, cleanupPending: false }
      this.publish()
      return
    }

    try {
      await handle.stop()
    } catch (error) {
      state.runtime = {
        ...state.runtime,
        status: 'error',
        failure: stopFailure(error),
        cleanupPending: true,
      }
      this.publish()
      return
    }

    state.handle = null
    state.generation += 1
    this.detachFacade(state)
    state.runtime = {
      ...state.runtime,
      status: 'error',
      boundAddress: null,
      boundPort: null,
      activeConnections: 0,
      startedAt: null,
      failure,
      cleanupPending: false,
    }
    this.publish()
  }

  private handleFacadeClosed(state: RuleState, facade: SshForwardingSession): void {
    if (this.states.get(state.rule.id) !== state || state.facade !== facade) return

    void this.exclusive(state, async () => {
      if (this.states.get(state.rule.id) !== state || state.facade !== facade) return

      if (state.handle === null) {
        this.detachFacade(state)
        if (
          state.runtime.status === 'starting' ||
          state.runtime.status === 'running' ||
          state.runtime.status === 'stopping'
        ) {
          state.runtime = stoppedRuntime(state.rule.id, 'session-ended')
          this.publish()
        }
        return
      }

      try {
        await this.stopRuleLocked(state, 'session-ended')
      } catch {
        // stopRuleLocked already published the cleanup-pending error state.
      }
    }).catch(() => {
      // State transitions are published before any rejection escapes.
    })
  }

  private detachFacade(state: RuleState): void {
    if (state.unsubscribeClosed) {
      try {
        state.unsubscribeClosed()
      } catch {
        // Listener removal must not block teardown.
      }
    }
    state.unsubscribeClosed = null
    state.facade = null
  }

  private snapshot(): PortForwardSnapshot {
    return {
      revision: this.revision,
      items: [...this.states.values()].map(cloneItem),
    }
  }

  private publish(): void {
    this.revision += 1
    if (!this.dependencies.emitUpdate) return
    try {
      this.dependencies.emitUpdate({ snapshot: this.snapshot() })
    } catch {
      // A failing listener must not break forwarding state transitions.
    }
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (!this.loadPromise) {
      this.loadPromise = this.load().catch((error: unknown) => {
        this.loadPromise = null
        throw error
      })
    }
    return this.loadPromise
  }

  private async load(): Promise<void> {
    const stored = await this.dependencies.store.list()
    this.states.clear()
    for (const rule of stored.rules) {
      this.states.set(rule.id, this.createState(rule))
    }
    this.loaded = true
  }

  private exclusive<T>(state: RuleState, operation: () => Promise<T>): Promise<T> {
    const run = state.queue.then(operation, operation)
    state.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
