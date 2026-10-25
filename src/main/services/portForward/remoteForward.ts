import { createConnection, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { PORT_FORWARD_LIMITS } from '../../../shared/constants/portForward'
import { canonicalizeIpLiteral } from '../../../shared/portForward/address'
import type { RemoteForwardRule } from '../../../shared/types/portForward'
import type { ForwardedTcpConnection, SshForwardingSession } from '../ssh/SshForwardingSession'
import { type ForwardConnectionSlot, RuleConnectionTracker } from './connectionTracker'
import {
  ForwardRuntimeError,
  ForwardTimeoutError,
  mapRemoteBindFailure,
  withTimeout,
} from './forwardRuntimeErrors'
import type { ForwardRuntimeEvents, ForwardRuntimeHandle } from './runtime'
import { bridgeStreams } from './streamBridge'

export interface RemoteForwardStartOptions {
  rule: RemoteForwardRule
  facade: SshForwardingSession
  gate: { tryAcquire(): boolean; release(): void }
  events: ForwardRuntimeEvents
  connectTimeoutMs?: number
  stopTimeoutMs?: number
}

interface RemoteConnection {
  channel: Duplex
  socket: Socket | null
  slot: ForwardConnectionSlot
  closed: boolean
}

function matchesEndpoint(
  connection: ForwardedTcpConnection,
  address: string,
  port: number,
): boolean {
  if (connection.destinationPort !== port) return false
  if (connection.destinationAddress === address) return true
  const expected = canonicalizeIpLiteral(address)
  const actual = canonicalizeIpLiteral(connection.destinationAddress)
  return expected !== null && expected === actual
}

function sessionEnded(): ForwardRuntimeError {
  return new ForwardRuntimeError({
    code: 'session-ended',
    message: 'SSH 会话已结束，远程监听已失效。',
  })
}

export async function startRemoteForward(
  options: RemoteForwardStartOptions,
): Promise<ForwardRuntimeHandle> {
  const { rule, facade, gate, events } = options
  const connectTimeoutMs = options.connectTimeoutMs ?? PORT_FORWARD_LIMITS.connectTimeoutMs
  const stopTimeoutMs = options.stopTimeoutMs ?? PORT_FORWARD_LIMITS.stopTimeoutMs

  const connections = new Set<RemoteConnection>()
  const tracker = new RuleConnectionTracker(
    PORT_FORWARD_LIMITS.maxConnectionsPerRule,
    gate,
    (count) => events.onConnectionCountChange(count),
  )
  let stopRequested = false
  let stopped = false
  let stopInFlight: Promise<void> | null = null
  let unbound = false
  let boundPort = rule.bindPort

  const handleIncoming = (connection: ForwardedTcpConnection): void => {
    if (stopRequested) return
    if (!matchesEndpoint(connection, rule.bindAddress, boundPort)) return

    const slot = tracker.tryAcquire()
    if (!slot) {
      connection.reject()
      return
    }

    let channel: Duplex
    try {
      channel = connection.accept()
    } catch {
      slot.release()
      return
    }

    const entry: RemoteConnection = { channel, socket: null, slot, closed: false }
    connections.add(entry)
    channel.pause()
    channel.once('error', () => undefined)

    const finalize = (): void => {
      if (entry.closed) return
      entry.closed = true
      connections.delete(entry)
      try {
        entry.channel.destroy()
      } catch {
        // Already closed.
      }
      if (entry.socket) {
        try {
          entry.socket.destroy()
        } catch {
          // Already closed.
        }
      }
      slot.release()
    }

    channel.once('close', finalize)

    let socket: Socket
    try {
      socket = createConnection({ host: rule.targetHost, port: rule.targetPort })
    } catch {
      finalize()
      return
    }
    entry.socket = socket
    socket.pause()
    socket.setTimeout(connectTimeoutMs, () => {
      socket.destroy()
    })
    socket.once('error', () => {
      socket.destroy()
    })
    socket.once('close', finalize)
    socket.once('connect', () => {
      if (entry.closed || stopRequested) {
        socket.destroy()
        return
      }
      socket.setTimeout(0)
      bridgeStreams(channel, socket, finalize)
      channel.resume()
    })
  }

  const unsubscribe = facade.onTcpConnection(handleIncoming)

  let actualPort: number
  try {
    const binding = facade.forwardIn(rule.bindAddress, rule.bindPort)
    try {
      actualPort = await withTimeout(binding, connectTimeoutMs, {
        code: 'remote-bind-failed',
        message: `远程监听 ${rule.bindAddress}:${rule.bindPort} 超时。`,
      })
    } catch (error) {
      if (error instanceof ForwardTimeoutError) {
        // A late successful bind must not leave an orphaned remote listener.
        void binding.then(
          (port) => {
            if (!facade.closed) {
              void facade.unforwardIn(rule.bindAddress, port).catch(() => undefined)
            }
          },
          () => undefined,
        )
      }
      throw normalizeStartError(error, rule, facade)
    }
  } catch (error) {
    unsubscribe()
    throw error
  }

  if (actualPort !== rule.bindPort) {
    if (!facade.closed) {
      void facade.unforwardIn(rule.bindAddress, actualPort).catch(() => undefined)
    }
    unsubscribe()
    throw new ForwardRuntimeError({
      code: 'remote-port-mismatch',
      message: `远程服务器返回的监听端口（${actualPort}）与请求端口（${rule.bindPort}）不一致。`,
    })
  }

  if (facade.closed) {
    unsubscribe()
    throw sessionEnded()
  }
  boundPort = actualPort

  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (stopInFlight) return stopInFlight

    stopInFlight = (async () => {
      stopRequested = true
      unsubscribe()
      for (const entry of [...connections]) {
        try {
          entry.channel.destroy()
        } catch {
          // Already closed.
        }
        if (entry.socket) {
          try {
            entry.socket.destroy()
          } catch {
            // Already closed.
          }
        }
        entry.slot.release()
        connections.delete(entry)
      }
      tracker.releaseAll()

      if (unbound) return
      if (facade.closed) {
        // The SSH transport owns the remote listener; it disappeared with the
        // session, so there is nothing left to unbind.
        unbound = true
        return
      }

      try {
        await withTimeout(facade.unforwardIn(rule.bindAddress, boundPort), stopTimeoutMs, {
          code: 'unbind-failed',
          message: `解除远程监听 ${rule.bindAddress}:${boundPort} 超时。`,
        })
        unbound = true
      } catch (error) {
        if (facade.closed) {
          unbound = true
          return
        }
        if (error instanceof ForwardRuntimeError) throw error
        throw new ForwardRuntimeError({
          code: 'unbind-failed',
          message: `无法解除远程监听 ${rule.bindAddress}:${boundPort}，请检查 SSH 连接状态。`,
        })
      }
    })()

    return stopInFlight.then(
      () => {
        stopped = true
      },
      (error: unknown) => {
        stopInFlight = null
        throw error
      },
    )
  }

  return {
    boundAddress: rule.bindAddress,
    boundPort,
    get activeConnections() {
      return tracker.activeConnections
    },
    stop,
  }
}

function normalizeStartError(
  error: unknown,
  rule: RemoteForwardRule,
  facade: SshForwardingSession,
): ForwardRuntimeError {
  if (facade.closed) return sessionEnded()
  if (error instanceof ForwardRuntimeError) return error
  return new ForwardRuntimeError(mapRemoteBindFailure(error, rule.bindAddress, rule.bindPort))
}
