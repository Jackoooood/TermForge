// @vitest-environment node

import { duplexPair } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { RemoteForwardRule } from '../../src/shared/types/portForward'
import type { ForwardRuntimeEvents } from '../../src/main/services/portForward/runtime'
import { startRemoteForward } from '../../src/main/services/portForward/remoteForward'
import {
  FakeForwardingSession,
  createEchoServer,
  readExact,
  unlimitedGate,
  waitFor,
} from './helpers/fakeForwardingSession'

const TIMESTAMP = '2026-10-23T08:00:00.000Z'

function remoteRule(overrides: Partial<RemoteForwardRule> = {}): RemoteForwardRule {
  return {
    id: 'pf-remote-test',
    type: 'remote',
    name: 'remote test',
    connectionId: 'conn-prod-web-01',
    bindAddress: '127.0.0.1',
    bindPort: 2201,
    targetHost: '127.0.0.1',
    targetPort: 9,
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

describe('remote forwarding runtime', () => {
  it('dispatches a matching inbound connection to the local target', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    const { counts, failures, events } = createEvents()
    const rule = remoteRule({ targetPort: echo.port })
    const handle = await startRemoteForward({
      rule,
      facade,
      gate: unlimitedGate,
      events,
    })

    try {
      expect(facade.forwardInCalls).toEqual([['127.0.0.1', rule.bindPort]])
      expect(handle.boundAddress).toBe('127.0.0.1')
      expect(handle.boundPort).toBe(rule.bindPort)

      const [channel, peer] = duplexPair()
      const incoming = facade.emitTcpConnection(
        {
          sourceAddress: '10.20.4.50',
          sourcePort: 51_000,
          destinationAddress: '127.0.0.1',
          destinationPort: rule.bindPort,
        },
        () => channel,
      )
      expect(incoming.accepted).toBe(true)
      expect(incoming.channel).toBe(channel)

      peer.write('remote')
      expect((await readExact(peer, 6)).toString()).toBe('remote')
      await waitFor(() => handle.activeConnections === 1)

      channel.destroy()
      peer.destroy()
      await waitFor(() => handle.activeConnections === 0)
    } finally {
      await handle.stop()
      await echo.close()
    }

    expect(counts).toContain(1)
    expect(counts.at(-1)).toBe(0)
    expect(failures).toEqual([])
  })

  it('rejects inbound connections for other remote endpoints', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    const { events } = createEvents()
    const rule = remoteRule({ targetPort: echo.port })
    const handle = await startRemoteForward({
      rule,
      facade,
      gate: unlimitedGate,
      events,
    })

    try {
      const mismatched = facade.emitTcpConnection({
        sourceAddress: '10.20.4.50',
        sourcePort: 51_001,
        destinationAddress: '127.0.0.1',
        destinationPort: rule.bindPort + 1,
      })
      expect(mismatched.accepted).toBe(false)
      expect(mismatched.rejected).toBe(true)
      expect(handle.activeConnections).toBe(0)
    } finally {
      await handle.stop()
      await echo.close()
    }
  })

  it('reports a remote bind failure and stops listening for inbound channels', async () => {
    const facade = new FakeForwardingSession()
    facade.forwardInHandler = async () => {
      throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' })
    }
    const { events } = createEvents()

    await expect(
      startRemoteForward({
        rule: remoteRule(),
        facade,
        gate: unlimitedGate,
        events,
      }),
    ).rejects.toMatchObject({
      name: 'ForwardRuntimeError',
      failure: { code: 'remote-bind-failed' },
    })

    const incoming = facade.emitTcpConnection({
      sourceAddress: '10.20.4.50',
      sourcePort: 51_002,
      destinationAddress: '127.0.0.1',
      destinationPort: 2201,
    })
    expect(incoming.rejected).toBe(true)
  })

  it('times out a hanging forwardIn and unbinds a listener that binds late', async () => {
    const facade = new FakeForwardingSession()
    let resolveBind: (port: number) => void = () => undefined
    const binding = new Promise<number>((resolve) => {
      resolveBind = resolve
    })
    facade.forwardInHandler = () => binding
    const { events } = createEvents()

    await expect(
      startRemoteForward({
        rule: remoteRule(),
        facade,
        gate: unlimitedGate,
        events,
        connectTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      name: 'ForwardRuntimeError',
      failure: { code: 'remote-bind-failed' },
    })

    resolveBind(2201)
    await waitFor(() => facade.unforwardInCalls.length === 1)
    expect(facade.unforwardInCalls[0]).toEqual(['127.0.0.1', 2201])
  })

  it('rejects a mismatched bound port and unbinds the actual port', async () => {
    const facade = new FakeForwardingSession()
    facade.forwardInHandler = async (_address, port) => port + 10
    const { events } = createEvents()

    await expect(
      startRemoteForward({
        rule: remoteRule(),
        facade,
        gate: unlimitedGate,
        events,
      }),
    ).rejects.toMatchObject({
      name: 'ForwardRuntimeError',
      failure: { code: 'remote-port-mismatch' },
    })

    await waitFor(() => facade.unforwardInCalls.length === 1)
    expect(facade.unforwardInCalls[0]).toEqual(['127.0.0.1', 2211])
  })

  it('stop tears down connections and unbinds the remote listener once', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    const { counts, events } = createEvents()
    const rule = remoteRule({ targetPort: echo.port })
    const handle = await startRemoteForward({
      rule,
      facade,
      gate: unlimitedGate,
      events,
    })

    const [channel, peer] = duplexPair()
    const incoming = facade.emitTcpConnection(
      {
        sourceAddress: '10.20.4.50',
        sourcePort: 51_003,
        destinationAddress: '127.0.0.1',
        destinationPort: rule.bindPort,
      },
      () => channel,
    )
    expect(incoming.accepted).toBe(true)
    peer.write('x')
    await readExact(peer, 1)
    await waitFor(() => handle.activeConnections === 1)

    await handle.stop()
    await handle.stop()
    peer.destroy()

    expect(facade.unforwardInCalls).toEqual([['127.0.0.1', rule.bindPort]])
    expect(channel.destroyed).toBe(true)
    expect(handle.activeConnections).toBe(0)
    expect(counts.at(-1)).toBe(0)

    const afterStop = facade.emitTcpConnection({
      sourceAddress: '10.20.4.50',
      sourcePort: 51_004,
      destinationAddress: '127.0.0.1',
      destinationPort: rule.bindPort,
    })
    expect(afterStop.rejected).toBe(true)
    await echo.close()
  })

  it('reports unbind failure and allows a retry', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    let failUnbind = true
    facade.unforwardInHandler = async () => {
      if (failUnbind) throw new Error('unbind failed')
    }
    const { events } = createEvents()
    const rule = remoteRule({ targetPort: echo.port })
    const handle = await startRemoteForward({
      rule,
      facade,
      gate: unlimitedGate,
      events,
    })

    try {
      await expect(handle.stop()).rejects.toMatchObject({
        name: 'ForwardRuntimeError',
        failure: { code: 'unbind-failed' },
      })
      expect(facade.unforwardInCalls).toHaveLength(1)

      failUnbind = false
      await handle.stop()
      expect(facade.unforwardInCalls).toHaveLength(2)
    } finally {
      await echo.close()
    }
  })

  it('skips unbind when the SSH session already closed', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    const { events } = createEvents()
    const rule = remoteRule({ targetPort: echo.port })
    const handle = await startRemoteForward({
      rule,
      facade,
      gate: unlimitedGate,
      events,
    })

    facade.close()
    await handle.stop()
    expect(facade.unforwardInCalls).toEqual([])
    await echo.close()
  })
})
