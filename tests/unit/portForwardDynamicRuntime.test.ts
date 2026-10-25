// @vitest-environment node

import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { duplexPair, type Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { DynamicForwardRule } from '../../src/shared/types/portForward'
import type { ForwardRuntimeEvents } from '../../src/main/services/portForward/runtime'
import { startDynamicForward } from '../../src/main/services/portForward/dynamicForward'
import { PORT_FORWARD_LIMITS } from '../../src/shared/constants/portForward'
import {
  FakeForwardingSession,
  connectToPort,
  createEchoServer,
  readExact,
  unlimitedGate,
  waitFor,
} from './helpers/fakeForwardingSession'

const TIMESTAMP = '2026-10-23T08:00:00.000Z'

function dynamicRule(overrides: Partial<DynamicForwardRule> = {}): DynamicForwardRule {
  return {
    id: 'pf-dynamic-test',
    type: 'dynamic',
    name: 'dynamic test',
    connectionId: 'conn-prod-web-01',
    bindAddress: '127.0.0.1',
    bindPort: 0,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  }
}

function createEvents(): {
  counts: number[]
  failures: string[]
  events: ForwardRuntimeEvents
} {
  const counts: number[] = []
  const failures: string[] = []
  return {
    counts,
    failures,
    events: {
      onConnectionCountChange: (count) => counts.push(count),
      onUnexpectedFailure: (error) => failures.push(error.failure.code),
    },
  }
}

function greeting(): Buffer {
  return Buffer.from([5, 1, 0])
}

function ipv4Connect(address: [number, number, number, number], port: number): Buffer {
  return Buffer.from([5, 1, 0, 1, ...address, (port >> 8) & 0xff, port & 0xff])
}

function domainConnect(host: string, port: number): Buffer {
  const domain = Buffer.from(host, 'utf8')
  return Buffer.concat([
    Buffer.from([5, 1, 0, 3, domain.length]),
    domain,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ])
}

async function completeNoAuth(socket: Socket): Promise<void> {
  socket.write(greeting())
  expect([...(await readExact(socket, 2))]).toEqual([5, 0])
}

async function completeConnect(socket: Socket, request: Buffer): Promise<Buffer> {
  socket.write(request)
  return readExact(socket, 10)
}

function trackSocket(socket: Socket): Socket {
  socket.on('error', () => undefined)
  return socket
}

describe('dynamic SOCKS5 forwarding runtime', () => {
  it('forwards an IPv4 CONNECT channel to the requested target', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    facade.forwardOutHandler = async (_sourceAddress, _sourcePort, host, port) => {
      const socket = createConnection({ host, port })
      await once(socket, 'connect')
      return socket
    }
    const { counts, failures, events } = createEvents()
    const handle = await startDynamicForward({
      rule: dynamicRule(),
      facade,
      gate: unlimitedGate,
      events,
    })

    try {
      expect(handle.boundAddress).toBe('127.0.0.1')
      expect(handle.boundPort).toBeGreaterThan(0)

      const socket = trackSocket(await connectToPort(handle.boundPort))
      await completeNoAuth(socket)
      const reply = await completeConnect(socket, ipv4Connect([127, 0, 0, 1], echo.port))
      expect([...reply]).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])

      socket.write('through')
      expect((await readExact(socket, 7)).toString()).toBe('through')
      await waitFor(() => handle.activeConnections === 1)
      expect(facade.forwardOutCalls).toEqual([['127.0.0.1', 0, '127.0.0.1', echo.port]])

      socket.destroy()
      await waitFor(() => handle.activeConnections === 0)
    } finally {
      await handle.stop()
      await echo.close()
    }

    expect(counts).toContain(1)
    expect(counts.at(-1)).toBe(0)
    expect(failures).toEqual([])
  })

  it('preserves payload sent in the same packet as the domain CONNECT', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    facade.forwardOutHandler = async (_sourceAddress, _sourcePort, _host, port) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      await once(socket, 'connect')
      return socket
    }
    const { events } = createEvents()
    const handle = await startDynamicForward({
      rule: dynamicRule(),
      facade,
      gate: unlimitedGate,
      events,
    })

    try {
      const socket = trackSocket(await connectToPort(handle.boundPort))
      socket.write(
        Buffer.concat([
          greeting(),
          domainConnect('localhost', echo.port),
          Buffer.from('EARLY', 'utf8'),
        ]),
      )
      expect([...(await readExact(socket, 2))]).toEqual([5, 0])
      expect((await readExact(socket, 10))[1]).toBe(0)
      expect((await readExact(socket, 5)).toString()).toBe('EARLY')
      expect(facade.forwardOutCalls).toEqual([['127.0.0.1', 0, 'localhost', echo.port]])
      socket.destroy()
    } finally {
      await handle.stop()
      await echo.close()
    }
  })

  it('answers protocol errors on the wire while keeping the listener usable', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    facade.forwardOutHandler = async (_sourceAddress, _sourcePort, host, port) => {
      const socket = createConnection({ host, port })
      await once(socket, 'connect')
      return socket
    }
    const { events } = createEvents()
    const handle = await startDynamicForward({
      rule: dynamicRule(),
      facade,
      gate: unlimitedGate,
      events,
    })

    try {
      const rejected = trackSocket(await connectToPort(handle.boundPort))
      await completeNoAuth(rejected)
      const rejection = await completeConnect(
        rejected,
        Buffer.concat([Buffer.from([5, 2, 0, 1]), Buffer.from([10, 0, 0, 1, 0x1f, 0x90])]),
      )
      expect([...rejection]).toEqual([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])
      await once(rejected, 'close')
      await waitFor(() => handle.activeConnections === 0)

      const badAddressType = trackSocket(await connectToPort(handle.boundPort))
      await completeNoAuth(badAddressType)
      const addressReply = await completeConnect(badAddressType, Buffer.from([5, 1, 0, 9, 0, 0]))
      expect([...addressReply]).toEqual([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])
      await once(badAddressType, 'close')
      await waitFor(() => handle.activeConnections === 0)

      const accepted = trackSocket(await connectToPort(handle.boundPort))
      await completeNoAuth(accepted)
      expect((await completeConnect(accepted, ipv4Connect([127, 0, 0, 1], echo.port)))[1]).toBe(0)
      accepted.write('ok')
      expect((await readExact(accepted, 2)).toString()).toBe('ok')
      accepted.destroy()
    } finally {
      await handle.stop()
      await echo.close()
    }
  })

  it('replies with general failure when the SSH channel cannot be opened', async () => {
    const facade = new FakeForwardingSession()
    facade.forwardOutHandler = async () => {
      throw new Error('channel rejected')
    }
    const { events } = createEvents()
    const handle = await startDynamicForward({
      rule: dynamicRule(),
      facade,
      gate: unlimitedGate,
      events,
    })

    try {
      const socket = trackSocket(await connectToPort(handle.boundPort))
      await completeNoAuth(socket)
      const reply = await completeConnect(socket, ipv4Connect([127, 0, 0, 1], 9))
      expect([...reply]).toEqual([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])
      await waitFor(() => handle.activeConnections === 0)
    } finally {
      await handle.stop()
    }
  })

  it('closes a silent client after the handshake timeout without stopping the listener', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    facade.forwardOutHandler = async (_sourceAddress, _sourcePort, host, port) => {
      const socket = createConnection({ host, port })
      await once(socket, 'connect')
      return socket
    }
    const { events } = createEvents()
    const handle = await startDynamicForward({
      rule: dynamicRule(),
      facade,
      gate: unlimitedGate,
      events,
      handshakeTimeoutMs: 20,
    })

    try {
      const silent = trackSocket(await connectToPort(handle.boundPort))
      await once(silent, 'close')
      await waitFor(() => handle.activeConnections === 0)

      const socket = trackSocket(await connectToPort(handle.boundPort))
      await completeNoAuth(socket)
      expect((await completeConnect(socket, ipv4Connect([127, 0, 0, 1], echo.port)))[1]).toBe(0)
      socket.destroy()
    } finally {
      await handle.stop()
      await echo.close()
    }
  })

  it('enforces the per-rule connection cap and releases slots on close', async () => {
    const facade = new FakeForwardingSession()
    const peers: Duplex[] = []
    facade.forwardOutHandler = async () => {
      const [channel, peer] = duplexPair()
      peers.push(peer)
      return channel
    }
    const { events } = createEvents()
    const handle = await startDynamicForward({
      rule: dynamicRule(),
      facade,
      gate: unlimitedGate,
      events,
    })

    const sockets: Socket[] = []
    try {
      expect(PORT_FORWARD_LIMITS.maxConnectionsPerRule).toBe(64)
      for (let index = 0; index < PORT_FORWARD_LIMITS.maxConnectionsPerRule; index += 1) {
        const socket = trackSocket(await connectToPort(handle.boundPort))
        await completeNoAuth(socket)
        expect((await completeConnect(socket, ipv4Connect([127, 0, 0, 1], 9)))[1]).toBe(0)
        sockets.push(socket)
      }
      await waitFor(() => handle.activeConnections === PORT_FORWARD_LIMITS.maxConnectionsPerRule)

      const overflow = trackSocket(await connectToPort(handle.boundPort))
      await once(overflow, 'close')
      expect(handle.activeConnections).toBe(PORT_FORWARD_LIMITS.maxConnectionsPerRule)

      for (const socket of sockets) socket.destroy()
      await waitFor(() => handle.activeConnections === 0)

      const recovered = trackSocket(await connectToPort(handle.boundPort))
      await completeNoAuth(recovered)
      expect((await completeConnect(recovered, ipv4Connect([127, 0, 0, 1], 9)))[1]).toBe(0)
      recovered.destroy()
    } finally {
      for (const socket of sockets) socket.destroy()
      for (const peer of peers) peer.destroy()
      await handle.stop()
    }
  })

  it('stop closes the SOCKS listener and active connections', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    facade.forwardOutHandler = async (_sourceAddress, _sourcePort, host, port) => {
      const socket = createConnection({ host, port })
      await once(socket, 'connect')
      return socket
    }
    const { events } = createEvents()
    const handle = await startDynamicForward({
      rule: dynamicRule(),
      facade,
      gate: unlimitedGate,
      events,
    })
    const port = handle.boundPort

    const socket = trackSocket(await connectToPort(port))
    await completeNoAuth(socket)
    await completeConnect(socket, ipv4Connect([127, 0, 0, 1], echo.port))
    await waitFor(() => handle.activeConnections === 1)

    await handle.stop()
    await once(socket, 'close')
    await handle.stop()

    expect(handle.activeConnections).toBe(0)
    await expect(connectToPort(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    await echo.close()
  })
})
