import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { PORT_FORWARD_LIMITS } from '../../../shared/constants/portForward'
import { isLoopbackAddress } from '../../../shared/portForward/address'
import type { DynamicForwardRule } from '../../../shared/types/portForward'
import type { SshForwardingSession } from '../ssh/SshForwardingSession'
import { type ForwardConnectionSlot, RuleConnectionTracker } from './connectionTracker'
import {
  ForwardRuntimeError,
  mapLocalBindFailure,
  openForwardChannel,
} from './forwardRuntimeErrors'
import type { ForwardRuntimeEvents, ForwardRuntimeHandle } from './runtime'
import {
  SOCKS5_REPLY_GENERAL_FAILURE,
  Socks5ProtocolError,
  encodeSocks5Reply,
  startSocks5Handshake,
} from './socks5Protocol'
import { bridgeStreams } from './streamBridge'

export interface DynamicForwardStartOptions {
  rule: DynamicForwardRule
  facade: SshForwardingSession
  gate: { tryAcquire(): boolean; release(): void }
  events: ForwardRuntimeEvents
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
  stopTimeoutMs?: number
}

interface DynamicConnection {
  socket: Socket
  channel: Duplex | null
  slot: ForwardConnectionSlot
  closed: boolean
}

function cleanupFailure(message: string): ForwardRuntimeError {
  return new ForwardRuntimeError({ code: 'cleanup-failed', message })
}

export async function startDynamicForward(
  options: DynamicForwardStartOptions,
): Promise<ForwardRuntimeHandle> {
  const { rule, facade, gate, events } = options
  const connectTimeoutMs = options.connectTimeoutMs ?? PORT_FORWARD_LIMITS.connectTimeoutMs
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? PORT_FORWARD_LIMITS.handshakeTimeoutMs
  const stopTimeoutMs = options.stopTimeoutMs ?? PORT_FORWARD_LIMITS.stopTimeoutMs

  const connections = new Set<DynamicConnection>()
  const tracker = new RuleConnectionTracker(
    PORT_FORWARD_LIMITS.maxConnectionsPerRule,
    gate,
    (count) => events.onConnectionCountChange(count),
  )
  let stopRequested = false
  let stopped = false
  let stopInFlight: Promise<void> | null = null
  let started = false

  const endWithResponse = (entry: DynamicConnection, response: Buffer | null): void => {
    if (entry.closed) return
    const socket = entry.socket
    if (socket.destroyed || !socket.writable) {
      socket.destroy()
      return
    }
    try {
      if (response) socket.end(response)
      else socket.end()
    } catch {
      socket.destroy()
      return
    }
    // A peer that never closes must not pin the connection slot forever.
    const timer = setTimeout(() => {
      if (!socket.destroyed) socket.destroy()
    }, 1_000)
    timer.unref?.()
  }

  const handleConnection = async (entry: DynamicConnection): Promise<void> => {
    let handshake: ReturnType<typeof startSocks5Handshake> | null = null
    try {
      handshake = startSocks5Handshake(entry.socket, { timeoutMs: handshakeTimeoutMs })
      const { request, leftover } = await handshake.done
      if (entry.closed || stopRequested) return

      const channel = await openForwardChannel(
        facade,
        request.targetHost,
        request.targetPort,
        connectTimeoutMs,
      )
      if (entry.closed || stopRequested) {
        channel.destroy()
        return
      }

      entry.channel = channel
      if (!entry.socket.writable || entry.socket.destroyed) {
        channel.destroy()
        return
      }

      entry.socket.write(encodeSocks5Reply(0))
      if (leftover.length > 0) entry.socket.unshift(leftover)
      bridgeStreams(entry.socket, channel, () => finalize(entry))
    } catch (error) {
      if (entry.closed) return
      if (error instanceof Socks5ProtocolError) {
        if (error.response) {
          // The handshake already queued the protocol reply; end the socket so
          // it flushes instead of resetting the connection.
          endWithResponse(entry, null)
        } else {
          entry.socket.destroy()
        }
        return
      }
      endWithResponse(entry, encodeSocks5Reply(SOCKS5_REPLY_GENERAL_FAILURE))
    }
  }

  const finalize = (entry: DynamicConnection): void => {
    if (entry.closed) return
    entry.closed = true
    connections.delete(entry)
    if (entry.channel) {
      try {
        entry.channel.destroy()
      } catch {
        // Already closed.
      }
    }
    try {
      entry.socket.destroy()
    } catch {
      // Already closed.
    }
    entry.slot.release()
  }

  const server: Server = createServer({ pauseOnConnect: true }, (socket) => {
    socket.once('error', () => {
      socket.destroy()
    })

    if (stopRequested) {
      socket.destroy()
      return
    }
    const slot = tracker.tryAcquire()
    if (!slot) {
      socket.destroy()
      return
    }

    const entry: DynamicConnection = { socket, channel: null, slot, closed: false }
    connections.add(entry)
    socket.once('close', () => finalize(entry))
    void handleConnection(entry)
  })

  server.on('error', (error) => {
    if (!started || stopRequested) return
    events.onUnexpectedFailure(
      new ForwardRuntimeError(mapLocalBindFailure(error, rule.bindAddress, rule.bindPort)),
    )
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => {
        server.removeListener('listening', onListening)
        reject(new ForwardRuntimeError(mapLocalBindFailure(error, rule.bindAddress, rule.bindPort)))
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host: rule.bindAddress, port: rule.bindPort })
    })
  } catch (error) {
    try {
      server.close()
    } catch {
      // The socket never reached the listening state.
    }
    throw error
  }
  started = true

  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    try {
      server.close()
    } catch {
      // No listener was established.
    }
    throw cleanupFailure('动态转发监听已建立，但无法读取实际绑定端口。')
  }
  if (!isLoopbackAddress(address.address)) {
    try {
      server.close()
    } catch {
      // The socket is already being closed.
    }
    throw new ForwardRuntimeError({
      code: 'bind-failed',
      message: '动态转发只允许绑定本机回环地址。',
    })
  }

  const boundAddress = address.address
  const boundPort = address.port

  const closeServer = (): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(cleanupFailure('停止动态转发监听超时，仍有连接未完全关闭。'))
      }, stopTimeoutMs)
      timer.unref?.()

      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (error && code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(cleanupFailure('无法完全关闭动态转发监听。'))
          return
        }
        resolve()
      }

      try {
        server.close(finish)
      } catch (error) {
        finish(error as Error)
      }
    })
  }

  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (stopInFlight) return stopInFlight

    stopInFlight = (async () => {
      stopRequested = true
      for (const entry of [...connections]) {
        entry.socket.destroy()
        if (entry.channel) {
          try {
            entry.channel.destroy()
          } catch {
            // Already closed.
          }
        }
        entry.slot.release()
        connections.delete(entry)
        entry.closed = true
      }
      tracker.releaseAll()
      await closeServer()
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
    boundAddress,
    boundPort,
    get activeConnections() {
      return tracker.activeConnections
    },
    stop,
  }
}
