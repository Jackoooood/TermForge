import { StringDecoder } from 'node:string_decoder'
import { AppOperationError } from '../../errors'
import { DEFAULT_TERMINAL_SIZE } from '../../../shared/types/terminal'
import type {
  TerminalAck,
  TerminalExitEvent,
  TerminalExitInfo,
  TerminalExitReason,
  TerminalFailure,
  TerminalOpenResult,
  TerminalOutputEvent,
  TerminalShellSnapshot,
  TerminalShellStatus,
  TerminalSize,
  TerminalStatusEvent,
} from '../../../shared/types/terminal'

export const SHELL_TERM = 'xterm-256color'

const DEFAULT_OUTPUT_FLUSH_MS = 8
const DEFAULT_OPEN_TIMEOUT_MS = 15_000
const FLUSH_NOW_THRESHOLD = 64 * 1024
const OUTPUT_HIGH_WATERMARK = 1_000_000
const OUTPUT_LOW_WATERMARK = 250_000

type ChannelListener = (...args: unknown[]) => void

/**
 * The subset of an ssh2 ClientChannel this service depends on. Shell data is
 * always treated as bytes and decoded with a streaming UTF-8 decoder so a
 * multi-byte character split across packets is never corrupted.
 */
export interface SshChannelLike {
  on(event: string, listener: ChannelListener): this
  removeListener(event: string, listener: ChannelListener): this
  write(data: string | Buffer, encoding?: BufferEncoding): boolean
  setWindow(rows: number, cols: number, height: number, width: number): void
  close(): void
  end(): void
  destroy(): void
  pause(): void
  resume(): void
}

export interface SshShellClientLike {
  shell(
    window: { term: string; cols: number; rows: number },
    callback: (error: Error | null | undefined, channel: SshChannelLike) => void,
  ): unknown
}

interface ShellRuntime {
  sessionId: string
  status: TerminalShellStatus
  size: TerminalSize
  channel: SshChannelLike | null
  decoder: StringDecoder | null
  listeners: Array<[string, ChannelListener]>
  pending: string[]
  pendingChars: number
  flushTimer: NodeJS.Timeout | null
  paused: boolean
  failure: TerminalFailure | null
  exit: TerminalExitEvent | null
  exitEmitted: boolean
  openSettled: boolean
  openTimer: NodeJS.Timeout | null
  abortOpen: ((message: string) => void) | null
}

export interface ShellChannelManagerDependencies {
  emitOutput: (event: TerminalOutputEvent) => void
  emitStatus: (event: TerminalStatusEvent) => void
  emitExit: (event: TerminalExitEvent) => void
  outputFlushMs?: number
  openTimeoutMs?: number
}

function makeTimer(callback: () => void, delay: number): NodeJS.Timeout {
  const timer = setTimeout(callback, delay)
  timer.unref?.()
  return timer
}

function copySize(size: TerminalSize): TerminalSize {
  return { cols: size.cols, rows: size.rows }
}

function copyExit(exit: TerminalExitInfo): TerminalExitInfo {
  return { code: exit.code, signal: exit.signal, reason: exit.reason }
}

/**
 * Owns exactly one interactive PTY channel per SSH session. The manager never
 * knows about credentials or how the SSH transport was established; SshService
 * validates that a session is connected before handing over its client.
 */
export class ShellChannelManager {
  private readonly runtimes = new Map<string, ShellRuntime>()
  private readonly outputFlushMs: number
  private readonly openTimeoutMs: number

  constructor(private readonly dependencies: ShellChannelManagerDependencies) {
    this.outputFlushMs = dependencies.outputFlushMs ?? DEFAULT_OUTPUT_FLUSH_MS
    this.openTimeoutMs = dependencies.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
  }

  async open(
    sessionId: string,
    client: SshShellClientLike,
    size: TerminalSize,
  ): Promise<TerminalOpenResult> {
    const existing = this.runtimes.get(sessionId)
    if (existing) {
      if (existing.status === 'open' || existing.status === 'opening') {
        if (existing.status === 'open' && !this.sameSize(existing.size, size)) {
          existing.size = copySize(size)
          this.applyWindow(existing)
        } else if (existing.status === 'opening') {
          existing.size = copySize(size)
        }
        return {
          sessionId,
          status: existing.status,
          size: copySize(existing.size),
          reused: true,
        }
      }
      if (existing.status === 'closing') {
        throw new AppOperationError('conflict', '远程 Shell 正在关闭，请稍后再试。')
      }
      this.releaseRuntime(existing)
    }

    const runtime = this.createRuntime(sessionId, size)
    this.runtimes.set(sessionId, runtime)
    this.publishStatus(runtime)

    return new Promise<TerminalOpenResult>((resolve, reject) => {
      runtime.abortOpen = (message) => {
        if (runtime.openSettled) return
        this.settleOpen(runtime)
        reject(new AppOperationError('unavailable', message))
      }

      runtime.openTimer = makeTimer(() => {
        if (runtime.openSettled) return
        this.settleOpen(runtime)
        this.failOpening(runtime, '打开远程 Shell 超时，请检查服务器 Shell 配置后重试。')
        reject(new AppOperationError('unavailable', '打开远程 Shell 超时，请稍后重试。'))
      }, this.openTimeoutMs)

      try {
        client.shell({ term: SHELL_TERM, cols: size.cols, rows: size.rows }, (error, channel) => {
          if (runtime.openSettled) {
            this.safeCloseChannel(channel)
            return
          }
          this.settleOpen(runtime)

          if (error || !channel) {
            this.failOpening(runtime, '无法在 SSH 会话上打开远程 Shell。')
            reject(new AppOperationError('unavailable', '无法打开远程 Shell，请稍后重试。'))
            return
          }
          if (runtime.status !== 'opening') {
            this.safeCloseChannel(channel)
            reject(new AppOperationError('unavailable', 'SSH 会话已断开，远程 Shell 未启动。'))
            return
          }

          runtime.channel = channel
          this.attachChannel(runtime, channel)
          runtime.status = 'open'
          this.applyWindow(runtime)
          this.publishStatus(runtime)
          resolve({
            sessionId,
            status: 'open',
            size: copySize(runtime.size),
            reused: false,
          })
        })
      } catch {
        if (!runtime.openSettled) {
          this.settleOpen(runtime)
          this.failOpening(runtime, '无法在 SSH 会话上打开远程 Shell。')
          reject(new AppOperationError('unavailable', '无法打开远程 Shell，请稍后重试。'))
        }
      }
    })
  }

  write(sessionId: string, data: string): TerminalAck {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      throw new AppOperationError('conflict', '远程 Shell 尚未打开。')
    }
    if (runtime.status === 'opening') {
      throw new AppOperationError('conflict', '远程 Shell 尚未就绪，请稍后再输入。')
    }
    if (runtime.status !== 'open' || !runtime.channel) {
      throw new AppOperationError('conflict', '远程 Shell 已关闭，无法写入输入。')
    }

    try {
      runtime.channel.write(data)
    } catch {
      throw new AppOperationError('internal', '无法向远程 Shell 写入输入。')
    }
    return { sessionId }
  }

  resize(sessionId: string, size: TerminalSize): TerminalAck {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      throw new AppOperationError('conflict', '远程 Shell 尚未打开。')
    }
    if (runtime.status === 'opening') {
      runtime.size = copySize(size)
      return { sessionId }
    }
    if (runtime.status !== 'open') {
      throw new AppOperationError('conflict', '远程 Shell 已关闭，无法调整终端尺寸。')
    }
    runtime.size = copySize(size)
    this.applyWindow(runtime)
    return { sessionId }
  }

  close(sessionId: string): TerminalShellSnapshot {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      return this.idleSnapshot(sessionId)
    }
    if (runtime.status === 'open' || runtime.status === 'opening') {
      if (runtime.status === 'open') {
        runtime.status = 'closing'
        this.publishStatus(runtime)
      }
      this.finalize(runtime, {
        status: 'closed',
        reason: 'local-close',
        failure: null,
        emitExit: true,
      })
    }
    return this.snapshot(runtime)
  }

  getStatus(sessionId: string): TerminalShellSnapshot {
    const runtime = this.runtimes.get(sessionId)
    return runtime ? this.snapshot(runtime) : this.idleSnapshot(sessionId)
  }

  /** Called when the owning SSH transport goes away (disconnect, error, window close). */
  closeForSession(
    sessionId: string,
    reason: Extract<TerminalExitReason, 'ssh-closed'>,
    failure: TerminalFailure,
  ): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    if (runtime.status === 'closed' || runtime.status === 'exited' || runtime.status === 'error') {
      return
    }
    this.finalize(runtime, {
      status: 'closed',
      reason,
      failure,
      emitExit: true,
    })
  }

  /** Stops tracking a session whose SSH record was discarded. */
  forget(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    this.disposeRuntime(runtime)
    this.runtimes.delete(sessionId)
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      this.disposeRuntime(runtime)
    }
    this.runtimes.clear()
  }

  private createRuntime(sessionId: string, size: TerminalSize): ShellRuntime {
    return {
      sessionId,
      status: 'opening',
      size: copySize(size),
      channel: null,
      decoder: new StringDecoder('utf8'),
      listeners: [],
      pending: [],
      pendingChars: 0,
      flushTimer: null,
      paused: false,
      failure: null,
      exit: null,
      exitEmitted: false,
      openSettled: false,
      openTimer: null,
      abortOpen: null,
    }
  }

  private attachChannel(runtime: ShellRuntime, channel: SshChannelLike): void {
    const onData: ChannelListener = (data) => this.handleData(runtime, data)
    const onExit: ChannelListener = (code, signal) => this.handleExit(runtime, code, signal)
    const onClose: ChannelListener = () => this.handleClose(runtime)
    const onError: ChannelListener = () => this.handleChannelError(runtime)

    runtime.listeners = [
      ['data', onData],
      ['exit', onExit],
      ['close', onClose],
      ['error', onError],
    ]
    for (const [event, listener] of runtime.listeners) {
      channel.on(event, listener)
    }
  }

  private handleData(runtime: ShellRuntime, raw: unknown): void {
    if (runtime.status !== 'open' || !runtime.channel || !runtime.decoder) return

    let buffer: Buffer
    if (typeof raw === 'string') {
      buffer = Buffer.from(raw, 'utf8')
    } else if (Buffer.isBuffer(raw)) {
      buffer = raw
    } else if (raw instanceof Uint8Array) {
      buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
    } else {
      return
    }

    const text = runtime.decoder.write(buffer)
    if (!text) return
    this.enqueueOutput(runtime, text)
  }

  private enqueueOutput(runtime: ShellRuntime, text: string): void {
    runtime.pending.push(text)
    runtime.pendingChars += text.length

    if (runtime.pendingChars >= OUTPUT_HIGH_WATERMARK && !runtime.paused) {
      try {
        runtime.channel?.pause()
        runtime.paused = true
      } catch {
        // The channel may already be closing; the final flush still runs.
      }
    }

    if (runtime.pendingChars >= FLUSH_NOW_THRESHOLD) {
      this.flushOutput(runtime)
      return
    }
    if (!runtime.flushTimer) {
      runtime.flushTimer = makeTimer(() => {
        runtime.flushTimer = null
        this.flushOutput(runtime)
      }, this.outputFlushMs)
    }
  }

  private flushOutput(runtime: ShellRuntime): void {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer)
      runtime.flushTimer = null
    }
    if (runtime.pending.length > 0) {
      const data = runtime.pending.join('')
      runtime.pending = []
      runtime.pendingChars = 0
      try {
        this.dependencies.emitOutput({ sessionId: runtime.sessionId, data })
      } catch {
        // A destroyed window must not break shell teardown.
      }
    }
    if (runtime.paused && runtime.pendingChars <= OUTPUT_LOW_WATERMARK) {
      try {
        runtime.channel?.resume()
      } catch {
        // Best effort; the channel is finalized below if it is gone.
      }
      runtime.paused = false
    }
  }

  private handleExit(runtime: ShellRuntime, rawCode: unknown, rawSignal: unknown): void {
    if (runtime.status === 'closed' || runtime.status === 'exited' || runtime.status === 'error') {
      return
    }
    this.finalize(runtime, {
      status: 'exited',
      reason: 'remote-exit',
      failure: null,
      emitExit: true,
      exit: {
        code: typeof rawCode === 'number' ? rawCode : null,
        signal: typeof rawSignal === 'string' ? rawSignal : null,
      },
    })
  }

  private handleClose(runtime: ShellRuntime): void {
    if (runtime.status === 'closed' || runtime.status === 'exited' || runtime.status === 'error') {
      return
    }
    this.finalize(runtime, {
      status: 'closed',
      reason: 'remote-close',
      failure: null,
      emitExit: true,
    })
  }

  private handleChannelError(runtime: ShellRuntime): void {
    if (runtime.status === 'closed' || runtime.status === 'exited' || runtime.status === 'error') {
      return
    }
    this.finalize(runtime, {
      status: 'error',
      reason: 'error',
      failure: {
        code: 'shell-error',
        message: '远程 Shell 通道发生错误，会话已关闭该 Shell。',
      },
      emitExit: true,
    })
  }

  private failOpening(runtime: ShellRuntime, message: string): void {
    if (runtime.status !== 'opening') return
    this.finalize(runtime, {
      status: 'error',
      reason: 'error',
      failure: { code: 'shell-open-failed', message },
      emitExit: false,
    })
  }

  private finalize(
    runtime: ShellRuntime,
    options: {
      status: Extract<TerminalShellStatus, 'closed' | 'exited' | 'error'>
      reason: TerminalExitReason
      failure: TerminalFailure | null
      emitExit: boolean
      exit?: { code: number | null; signal: string | null }
    },
  ): void {
    if (runtime.status === 'closed' || runtime.status === 'exited' || runtime.status === 'error') {
      return
    }

    const abortOpen = runtime.abortOpen
    runtime.abortOpen = null
    if (abortOpen) abortOpen('远程 Shell 已关闭。')

    if (runtime.openTimer) {
      clearTimeout(runtime.openTimer)
      runtime.openTimer = null
    }
    runtime.openSettled = true

    if (runtime.decoder) {
      const tail = runtime.decoder.end()
      if (tail) {
        runtime.pending.push(tail)
        runtime.pendingChars += tail.length
      }
      runtime.decoder = null
    }
    this.flushOutput(runtime)

    const channel = runtime.channel
    if (channel) {
      for (const [event, listener] of runtime.listeners) {
        try {
          channel.removeListener(event, listener)
        } catch {
          // Listener cleanup is best effort on an already-dead channel.
        }
      }
      this.safeCloseChannel(channel)
    }
    runtime.listeners = []
    runtime.channel = null
    runtime.paused = false
    runtime.status = options.status
    runtime.failure = options.failure

    if (options.exit) {
      runtime.exit = {
        sessionId: runtime.sessionId,
        code: options.exit.code,
        signal: options.exit.signal,
        reason: options.reason,
      }
    } else if (options.reason === 'local-close' || options.reason === 'ssh-closed') {
      runtime.exit = {
        sessionId: runtime.sessionId,
        code: runtime.exit?.code ?? null,
        signal: runtime.exit?.signal ?? null,
        reason: options.reason,
      }
    }

    this.publishStatus(runtime)

    if (options.emitExit && !runtime.exitEmitted) {
      runtime.exitEmitted = true
      const exit: TerminalExitEvent = {
        sessionId: runtime.sessionId,
        code: runtime.exit?.code ?? null,
        signal: runtime.exit?.signal ?? null,
        reason: options.reason,
      }
      try {
        this.dependencies.emitExit(exit)
      } catch {
        // Transport failures are handled by the window/main-process boundary.
      }
    }
  }

  private applyWindow(runtime: ShellRuntime): void {
    if (!runtime.channel) return
    try {
      runtime.channel.setWindow(runtime.size.rows, runtime.size.cols, 0, 0)
    } catch {
      // A concurrent close is surfaced through the channel's close event.
    }
  }

  private publishStatus(runtime: ShellRuntime): void {
    try {
      this.dependencies.emitStatus(this.snapshot(runtime))
    } catch {
      // The main-process state remains authoritative.
    }
  }

  private snapshot(runtime: ShellRuntime): TerminalShellSnapshot {
    return {
      sessionId: runtime.sessionId,
      status: runtime.status,
      size: copySize(runtime.size),
      failure: runtime.failure ? { ...runtime.failure } : null,
      exit: runtime.exit ? copyExit(runtime.exit) : null,
    }
  }

  private idleSnapshot(sessionId: string): TerminalShellSnapshot {
    return {
      sessionId,
      status: 'idle',
      size: copySize(DEFAULT_TERMINAL_SIZE),
      failure: null,
      exit: null,
    }
  }

  private sameSize(left: TerminalSize, right: TerminalSize): boolean {
    return left.cols === right.cols && left.rows === right.rows
  }

  private settleOpen(runtime: ShellRuntime): void {
    runtime.openSettled = true
    runtime.abortOpen = null
    if (runtime.openTimer) {
      clearTimeout(runtime.openTimer)
      runtime.openTimer = null
    }
  }

  private releaseRuntime(runtime: ShellRuntime): void {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer)
      runtime.flushTimer = null
    }
    if (runtime.openTimer) {
      clearTimeout(runtime.openTimer)
      runtime.openTimer = null
    }
    runtime.abortOpen = null
    runtime.pending = []
    runtime.pendingChars = 0
  }

  private disposeRuntime(runtime: ShellRuntime): void {
    const abortOpen = runtime.abortOpen
    runtime.abortOpen = null
    if (abortOpen) abortOpen('远程 Shell 已关闭。')
    if (runtime.openTimer) {
      clearTimeout(runtime.openTimer)
      runtime.openTimer = null
    }
    this.settleOpen(runtime)
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer)
      runtime.flushTimer = null
    }
    if (runtime.decoder) {
      runtime.decoder.end()
      runtime.decoder = null
    }
    const channel = runtime.channel
    if (channel) {
      for (const [event, listener] of runtime.listeners) {
        try {
          channel.removeListener(event, listener)
        } catch {
          // Best effort during application shutdown.
        }
      }
      this.safeCloseChannel(channel)
    }
    runtime.listeners = []
    runtime.channel = null
    runtime.pending = []
    runtime.pendingChars = 0
  }

  private safeCloseChannel(channel: SshChannelLike | null | undefined): void {
    if (!channel) return
    try {
      channel.close()
    } catch {
      try {
        channel.destroy()
      } catch {
        // The channel is already gone.
      }
    }
  }
}
