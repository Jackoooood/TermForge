import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { PORT_FORWARD_LIMITS } from '../../../shared/constants/portForward'
import type { LocalForwardRule } from '../../../shared/types/portForward'
import type { SshForwardingSession } from '../ssh/SshForwardingSession'
import {
  type ForwardConnectionSlot,
  RuleConnectionTracker,
} from './connectionTracker'
import {
  ForwardRuntimeError,
  mapLocalBindFailure,
  openForwardChannel,
} from './forwardRuntimeErrors'
import type { ForwardRuntimeEvents, ForwardRuntimeHandle } from './runtime'
import { bridgeStreams } from './streamBridge'

export interface LocalForwardStartOptions {
  rule: LocalForwardRule
  facade: SshForwardingSession
  gate: { tryAcquire(): boolean; release(): void }
  events: ForwardRuntimeEvents
  connectTimeoutMs?: number
  stopTimeoutMs?: number
}

interface LocalConnection {
  socket: Socket
  channel: Duplex | null
  slot: ForwardConnectionSlot
  closed: boolean
}

function cleanupFailure(message: string): ForwardRuntimeError {
  return new ForwardRuntimeError({ code: 'cleanup-failed', message })
}

export async function startLocalForward(
  options: LocalForwardStartOptions,
): Promise<ForwardRuntimeHandle> {
  const { rule, facade, gate, events } = options
  const connectTimeoutMs = options.connectTimeoutMs ?? PORT_FORWARD_LIMITS.connectTimeoutMs
  const stopTimeoutMs = options.stopTimeoutMs ?? PORT_FORWARD_LIMITS.stopTimeoutMs

  const connections = new Set<LocalConnection>()
  const tracker = new RuleConnectionTracker(
    PORT_FORWARD_LIMITS.maxConnectionsPerRule,
    gate,
    (count) => events.onConnectionCountChange(count),
  )
  let stopRequested = false
  let stopped = false
  let stopInFlight: Promise<void> | null = null
  let started = false

  const server: Server = createServer({ pauseOnConnect: true }, (socket) => {
    socket.pause()
    socket.once('error', () => {
      try {
        socket.destroy()
      } catch {
        // Already closed.
      }
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

    const entry: LocalConnection = { socket, channel: null, slot, closed: false }
    connections.add(entry)

    const finalize = (): void => {
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
        socket.destroy()
      } catch {
        // Already closed.
      }
      slot.release()
    }

    socket.once('close', finalize)
    void openForwardChannel(
      facade,
      rule.targetHost,
      rule.targetPort,
      connectTimeoutMs,
    ).then(
      (channel) => {
        if (entry.closed || stopRequested) {
          try {
            channel.destroy()
          } catch {
            // The channel raced teardown.
          }
          finalize()
          return
        }
        entry.channel = channel
        bridgeStreams(socket, channel, finalize)
        socket.resume()
      },
      () => {
        // A single target failure resets only this connection; the listener
        // stays available for subsequent clients.
        finalize()
      },
    )
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
    throw cleanupFailure('本地监听已建立，但无法读取实际绑定端口。')
  }

  const boundAddress = address.address
  const boundPort = address.port

  const closeServer = (): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(cleanupFailure('停止本地监听超时，仍有连接未完全关闭。'))
      }, stopTimeoutMs)
      timer.unref?.()

      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (error && code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(cleanupFailure('无法完全关闭本地监听。'))
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
