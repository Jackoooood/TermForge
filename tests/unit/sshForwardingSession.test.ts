// @vitest-environment node

import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import {
  SshForwardingSessionHandle,
  type ForwardedTcpConnection,
  type SshForwardingClient,
} from '../../src/main/services/ssh/SshForwardingSession'

type Listener = (...args: unknown[]) => void

interface ForwardOutCall {
  srcAddress: string
  srcPort: number
  destAddress: string
  destPort: number
}

class FakeForwardClient implements SshForwardingClient {
  readonly listeners = new Map<string, Listener[]>()
  readonly forwardOutCalls: ForwardOutCall[] = []
  readonly forwardInCalls: Array<{ bindAddress: string; bindPort: number }> = []
  readonly unforwardInCalls: Array<{ bindAddress: string; bindPort: number }> = []
  error: Error | null = null
  deferForward = false
  pendingForward: ((error: Error | undefined, channel: ClientChannel) => void) | null = null

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  removeListener(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? []
    this.listeners.set(
      event,
      listeners.filter((item) => item !== listener),
    )
    return this
  }

  forwardOut(
    srcAddress: string,
    srcPort: number,
    destAddress: string,
    destPort: number,
    callback: (error: Error | undefined, channel: ClientChannel) => void,
  ): unknown {
    this.forwardOutCalls.push({ srcAddress, srcPort, destAddress, destPort })
    if (this.deferForward) {
      this.pendingForward = callback
      return undefined
    }
    if (this.error) {
      const error = this.error
      queueMicrotask(() => callback(error, undefined as unknown as ClientChannel))
      return undefined
    }
    const channel = new PassThrough()
    this.lastChannel = channel
    queueMicrotask(() => callback(undefined, channel as unknown as ClientChannel))
    return channel
  }

  forwardIn(
    bindAddress: string,
    bindPort: number,
    callback: (error: Error | undefined, actualPort: number) => void,
  ): unknown {
    this.forwardInCalls.push({ bindAddress, bindPort })
    if (this.error) {
      const error = this.error
      queueMicrotask(() => callback(error, bindPort))
      return undefined
    }
    queueMicrotask(() => callback(undefined, bindPort))
    return undefined
  }

  unforwardIn(
    bindAddress: string,
    bindPort: number,
    callback: (error: Error | undefined) => void,
  ): unknown {
    this.unforwardInCalls.push({ bindAddress, bindPort })
    if (this.error) {
      const error = this.error
      queueMicrotask(() => callback(error))
      return undefined
    }
    queueMicrotask(() => callback(undefined))
    return undefined
  }

  completeForward(): PassThrough {
    const pending = this.pendingForward
    this.pendingForward = null
    if (!pending) throw new Error('no deferred forward request')
    const channel = new PassThrough()
    this.lastChannel = channel
    pending(undefined, channel as unknown as ClientChannel)
    return channel
  }

  lastChannel: PassThrough | null = null

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

function createSession(client = new FakeForwardClient()) {
  return {
    client,
    session: new SshForwardingSessionHandle({ sessionId: 'ssh-abc', client }),
  }
}

function tcpArgs(details: Record<string, unknown> = {}) {
  const channel = new PassThrough()
  const accept = vi.fn(() => channel)
  const reject = vi.fn()
  return {
    channel,
    accept,
    reject,
    args: [
      {
        srcIP: '203.0.113.7',
        srcPort: 51_234,
        destIP: '127.0.0.1',
        destPort: 8080,
        ...details,
      },
      accept,
      reject,
    ] as const,
  }
}

describe('SshForwardingSession facade', () => {
  it('passes the four explicit forwardOut parameters through in order', async () => {
    const { client, session } = createSession()
    const channel = await session.forwardOut('127.0.0.1', 0, '10.0.0.9', 80)

    expect(client.forwardOutCalls).toEqual([
      { srcAddress: '127.0.0.1', srcPort: 0, destAddress: '10.0.0.9', destPort: 80 },
    ])
    expect(channel).toBe(client.lastChannel)
  })

  it('propagates channel-open and bind errors', async () => {
    const { client, session } = createSession()
    client.error = new Error('channel open failed')
    await expect(session.forwardOut('127.0.0.1', 0, '10.0.0.9', 80)).rejects.toThrow(
      'channel open failed',
    )
    await expect(session.forwardIn('127.0.0.1', 8080)).rejects.toThrow('channel open failed')
    await expect(session.unforwardIn('127.0.0.1', 8080)).rejects.toThrow('channel open failed')

    expect(client.forwardInCalls).toEqual([{ bindAddress: '127.0.0.1', bindPort: 8080 }])
    expect(client.unforwardInCalls).toEqual([{ bindAddress: '127.0.0.1', bindPort: 8080 }])
  })

  it('binds and unbinds remote listeners with the requested address and port', async () => {
    const { client, session } = createSession()
    await expect(session.forwardIn('127.0.0.1', 8080)).resolves.toBe(8080)
    await expect(session.unforwardIn('127.0.0.1', 8080)).resolves.toBeUndefined()
    expect(client.forwardInCalls).toEqual([{ bindAddress: '127.0.0.1', bindPort: 8080 }])
    expect(client.unforwardInCalls).toEqual([{ bindAddress: '127.0.0.1', bindPort: 8080 }])
  })

  it('dispatches tcp connections and lets exactly one listener accept', () => {
    const { client, session } = createSession()
    const accepted = vi.fn()
    session.onTcpConnection((connection) => {
      expect(connection).toMatchObject({
        sourceAddress: '203.0.113.7',
        sourcePort: 51_234,
        destinationAddress: '127.0.0.1',
        destinationPort: 8080,
      })
      accepted(connection.accept())
    })

    const { channel, accept, reject, args } = tcpArgs()
    client.emit('tcp connection', ...args)
    expect(accept).toHaveBeenCalledTimes(1)
    expect(reject).not.toHaveBeenCalled()
    expect(accepted).toHaveBeenCalledWith(channel)

    const second = tcpArgs()
    client.emit('tcp connection', ...second.args)
    expect(second.accept).toHaveBeenCalledTimes(1)
  })

  it('rejects unhandled, malformed, undecided and throwing tcp connections', () => {
    const { client, session } = createSession()

    const unhandled = tcpArgs()
    client.emit('tcp connection', ...unhandled.args)
    expect(unhandled.reject).toHaveBeenCalledTimes(1)

    const malformed = tcpArgs({ srcPort: 'not-a-port' })
    client.emit('tcp connection', ...malformed.args)
    expect(malformed.reject).toHaveBeenCalledTimes(1)

    const undecided = tcpArgs()
    const unsubscribe = session.onTcpConnection(() => undefined)
    client.emit('tcp connection', ...undecided.args)
    expect(undecided.reject).toHaveBeenCalledTimes(1)
    unsubscribe()

    const throwing = tcpArgs()
    session.onTcpConnection(() => {
      throw new Error('dispatch failed')
    })
    client.emit('tcp connection', ...throwing.args)
    expect(throwing.reject).toHaveBeenCalledTimes(1)

    const doubleDecide = tcpArgs()
    let connection: ForwardedTcpConnection | null = null
    session.onTcpConnection((incoming) => {
      connection = incoming
      incoming.accept()
    })
    client.emit('tcp connection', ...doubleDecide.args)
    expect(() => connection?.accept()).toThrow(/已被处理/)
  })

  it('stops dispatching and rejects new work after close, exactly once', async () => {
    const { client, session } = createSession()
    const onClosed = vi.fn()
    const onTcp = vi.fn()
    session.onClosed(onClosed)
    session.onTcpConnection(onTcp)

    session.close()
    session.close()
    expect(session.closed).toBe(true)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(client.listeners.get('tcp connection')).toEqual([])

    const lateClosed = vi.fn()
    session.onClosed(lateClosed)
    expect(lateClosed).toHaveBeenCalledTimes(1)

    await expect(session.forwardOut('127.0.0.1', 0, '10.0.0.9', 80)).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(session.forwardIn('127.0.0.1', 8080)).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(session.unforwardIn('127.0.0.1', 8080)).rejects.toMatchObject({
      code: 'unavailable',
    })

    const { args, accept, reject } = tcpArgs()
    client.emit('tcp connection', ...args)
    expect(accept).not.toHaveBeenCalled()
    expect(reject).not.toHaveBeenCalled()
    expect(onTcp).not.toHaveBeenCalled()
  })

  it('destroys a channel that arrives after the session closed', async () => {
    const { client, session } = createSession()
    client.deferForward = true
    const pending = session.forwardOut('127.0.0.1', 0, '10.0.0.9', 80)

    session.close()
    const channel = client.completeForward()
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    expect(channel.destroyed).toBe(true)
  })
})
