import type { Duplex } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { AppOperationError } from '../../errors'

export interface SshForwardingClient {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  forwardOut(
    srcAddress: string,
    srcPort: number,
    destAddress: string,
    destPort: number,
    callback: (error: Error | undefined, channel: ClientChannel) => void,
  ): unknown
  forwardIn(
    bindAddress: string,
    bindPort: number,
    callback: (error: Error | undefined, actualPort: number) => void,
  ): unknown
  unforwardIn(
    bindAddress: string,
    bindPort: number,
    callback: (error: Error | undefined) => void,
  ): unknown
}

export interface ForwardedTcpConnection {
  sourceAddress: string
  sourcePort: number
  destinationAddress: string
  destinationPort: number
  /** Must be called synchronously while the `tcp connection` event is handled. */
  accept(): Duplex
  reject(): void
}

export type ForwardedTcpConnectionListener = (connection: ForwardedTcpConnection) => void

/**
 * The only main-process surface for SSH-level forwarding. It deliberately
 * exposes streams and bound endpoints, never the underlying ssh2 Client or any
 * credentials/configuration.
 */
export interface SshForwardingSession {
  readonly sessionId: string
  readonly closed: boolean
  forwardOut(
    srcAddress: string,
    srcPort: number,
    destAddress: string,
    destPort: number,
  ): Promise<Duplex>
  forwardIn(bindAddress: string, bindPort: number): Promise<number>
  unforwardIn(bindAddress: string, bindPort: number): Promise<void>
  onTcpConnection(listener: ForwardedTcpConnectionListener): () => void
  onClosed(listener: () => void): () => void
}

interface SshForwardingSessionOptions {
  sessionId: string
  client: SshForwardingClient
}

interface TcpConnectionDetails {
  sourceAddress: string
  sourcePort: number
  destinationAddress: string
  destinationPort: number
}

function unavailable(): AppOperationError {
  return new AppOperationError('unavailable', 'SSH 会话已结束，端口转发已停止。')
}

function parseTcpConnectionDetails(value: unknown): TcpConnectionDetails | null {
  if (typeof value !== 'object' || value === null) return null
  const details = value as Record<string, unknown>
  if (
    typeof details.srcIP !== 'string' ||
    !Number.isInteger(details.srcPort) ||
    typeof details.destIP !== 'string' ||
    !Number.isInteger(details.destPort)
  ) {
    return null
  }
  const sourcePort = details.srcPort as number
  const destinationPort = details.destPort as number
  if (sourcePort < 0 || sourcePort > 65_535) return null
  if (destinationPort < 0 || destinationPort > 65_535) return null
  return {
    sourceAddress: details.srcIP,
    sourcePort,
    destinationAddress: details.destIP,
    destinationPort,
  }
}

export class SshForwardingSessionHandle implements SshForwardingSession {
  readonly sessionId: string

  private readonly client: SshForwardingClient
  private readonly tcpListeners = new Set<ForwardedTcpConnectionListener>()
  private readonly closedListeners = new Set<() => void>()
  private isClosed = false

  constructor(options: SshForwardingSessionOptions) {
    this.sessionId = options.sessionId
    this.client = options.client
    this.client.on('tcp connection', this.handleTcpConnection)
  }

  get closed(): boolean {
    return this.isClosed
  }

  forwardOut(
    srcAddress: string,
    srcPort: number,
    destAddress: string,
    destPort: number,
  ): Promise<Duplex> {
    if (this.isClosed) return Promise.reject(unavailable())

    return new Promise<Duplex>((resolve, reject) => {
      let settled = false
      try {
        this.client.forwardOut(srcAddress, srcPort, destAddress, destPort, (error, channel) => {
          if (settled) return
          settled = true
          if (this.isClosed) {
            if (!error) channel.destroy()
            reject(unavailable())
            return
          }
          if (error) {
            reject(error)
            return
          }
          resolve(channel)
        })
      } catch (error) {
        settled = true
        reject(error)
      }
    })
  }

  forwardIn(bindAddress: string, bindPort: number): Promise<number> {
    if (this.isClosed) return Promise.reject(unavailable())

    return new Promise<number>((resolve, reject) => {
      let settled = false
      try {
        this.client.forwardIn(bindAddress, bindPort, (error, actualPort) => {
          if (settled) return
          settled = true
          if (this.isClosed) {
            reject(unavailable())
            return
          }
          if (error) {
            reject(error)
            return
          }
          resolve(actualPort)
        })
      } catch (error) {
        settled = true
        reject(error)
      }
    })
  }

  unforwardIn(bindAddress: string, bindPort: number): Promise<void> {
    if (this.isClosed) return Promise.reject(unavailable())

    return new Promise<void>((resolve, reject) => {
      let settled = false
      try {
        this.client.unforwardIn(bindAddress, bindPort, (error) => {
          if (settled) return
          settled = true
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      } catch (error) {
        settled = true
        reject(error)
      }
    })
  }

  onTcpConnection(listener: ForwardedTcpConnectionListener): () => void {
    if (this.isClosed) return () => {}
    this.tcpListeners.add(listener)
    return () => {
      this.tcpListeners.delete(listener)
    }
  }

  onClosed(listener: () => void): () => void {
    if (this.isClosed) {
      listener()
      return () => {}
    }
    this.closedListeners.add(listener)
    return () => {
      this.closedListeners.delete(listener)
    }
  }

  /** Called by SshService when the owning session reaches a terminal state. */
  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    try {
      this.client.removeListener('tcp connection', this.handleTcpConnection)
    } catch {
      // The client may already be destroyed; the facade is still closed.
    }

    const closedListeners = [...this.closedListeners]
    this.tcpListeners.clear()
    this.closedListeners.clear()

    for (const listener of closedListeners) {
      try {
        listener()
      } catch {
        // Teardown must complete even if a listener fails.
      }
    }
  }

  private readonly handleTcpConnection = (...args: unknown[]): void => {
    if (this.isClosed) return
    const [rawDetails, rawAccept, rawReject] = args
    const rejectRaw = typeof rawReject === 'function' ? (rawReject as () => void) : null
    const details = parseTcpConnectionDetails(rawDetails)
    if (!details || typeof rawAccept !== 'function' || !rejectRaw) {
      safeReject(rejectRaw)
      return
    }

    let decided = false
    const reject = (): void => {
      if (decided) return
      decided = true
      safeReject(rejectRaw)
    }
    const accept = (): Duplex => {
      if (decided) {
        throw new AppOperationError('conflict', '该入站转发连接已被处理。')
      }
      decided = true
      return (rawAccept as () => ClientChannel)()
    }

    const connection: ForwardedTcpConnection = { ...details, accept, reject }
    for (const listener of [...this.tcpListeners]) {
      try {
        listener(connection)
      } catch {
        reject()
      }
    }
    if (!decided) reject()
  }
}

function safeReject(reject: (() => void) | null): void {
  if (!reject) return
  try {
    reject()
  } catch {
    // The SSH client may have already dropped the incoming channel.
  }
}
