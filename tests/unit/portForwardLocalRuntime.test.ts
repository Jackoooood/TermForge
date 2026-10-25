// @vitest-environment node

import { createConnection, createServer } from 'node:net'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { LocalForwardRule } from '../../src/shared/types/portForward'
import type { ForwardRuntimeEvents } from '../../src/main/services/portForward/runtime'
import { startLocalForward } from '../../src/main/services/portForward/localForward'
import {
  FakeForwardingSession,
  connectToPort,
  createEchoServer,
  readExact,
  unlimitedGate,
  waitFor,
} from './helpers/fakeForwardingSession'

const TIMESTAMP = '2026-10-23T08:00:00.000Z'

function localRule(overrides: Partial<LocalForwardRule> = {}): LocalForwardRule {
  return {
    id: 'pf-local-test',
    type: 'local',
    name: 'local test',
    connectionId: 'conn-prod-web-01',
    bindAddress: '127.0.0.1',
    bindPort: 0,
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

describe('local forwarding runtime', () => {
  it('listens on the requested address and forwards bytes through forwardOut', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    facade.forwardOutHandler = async (_sourceAddress, _sourcePort, host, port) => {
      const socket = createConnection({ host, port })
      await once(socket, 'connect')
      return socket
    }
    const { counts, failures, events } = createEvents()
    const handle = await startLocalForward({
      rule: localRule({ targetPort: echo.port }),
      facade,
      gate: unlimitedGate,
      events,
    })

    try {
      expect(handle.boundAddress).toBe('127.0.0.1')
      expect(handle.boundPort).toBeGreaterThan(0)

      const client = await connectToPort(handle.boundPort)
      try {
        client.write('hello')
        expect((await readExact(client, 5)).toString()).toBe('hello')
        expect(facade.forwardOutCalls).toEqual([['127.0.0.1', 0, '127.0.0.1', echo.port]])
        await waitFor(() => handle.activeConnections === 1)
      } finally {
        client.destroy()
      }

      await waitFor(() => handle.activeConnections === 0)
    } finally {
      await handle.stop()
      await echo.close()
    }

    expect(counts).toContain(1)
    expect(counts.at(-1)).toBe(0)
    expect(failures).toEqual([])
  })

  it('keeps the listener available when one target channel fails', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    let attempts = 0
    facade.forwardOutHandler = async (_sourceAddress, _sourcePort, host, port) => {
      attempts += 1
      if (attempts === 1) throw new Error('channel rejected')
      const socket = createConnection({ host, port })
      await once(socket, 'connect')
      return socket
    }
    const { failures, events } = createEvents()
    const handle = await startLocalForward({
      rule: localRule({ targetPort: echo.port }),
      facade,
      gate: unlimitedGate,
      events,
    })

    try {
      const failed = await connectToPort(handle.boundPort)
      failed.on('error', () => undefined)
      await once(failed, 'close')

      const client = await connectToPort(handle.boundPort)
      try {
        client.write('retry')
        expect((await readExact(client, 5)).toString()).toBe('retry')
      } finally {
        client.destroy()
      }
      expect(attempts).toBe(2)
      expect(failures).toEqual([])
    } finally {
      await handle.stop()
      await echo.close()
    }
  })

  it('reports a bind failure without leaving a listener behind', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve))
    const address = blocker.address()
    if (typeof address !== 'object' || address === null) throw new Error('missing address')

    const { events } = createEvents()
    try {
      await expect(
        startLocalForward({
          rule: localRule({ bindPort: address.port }),
          facade: new FakeForwardingSession(),
          gate: unlimitedGate,
          events,
        }),
      ).rejects.toMatchObject({
        name: 'ForwardRuntimeError',
        failure: { code: 'bind-failed' },
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('stop closes the listener and every active connection exactly once', async () => {
    const echo = await createEchoServer()
    const facade = new FakeForwardingSession()
    facade.forwardOutHandler = async (_sourceAddress, _sourcePort, host, port) => {
      const socket = createConnection({ host, port })
      await once(socket, 'connect')
      return socket
    }
    const { counts, events } = createEvents()
    const handle = await startLocalForward({
      rule: localRule({ targetPort: echo.port }),
      facade,
      gate: unlimitedGate,
      events,
    })
    const port = handle.boundPort

    const client = await connectToPort(port)
    client.on('error', () => undefined)
    client.write('ping')
    await readExact(client, 4)
    await waitFor(() => handle.activeConnections === 1)

    await handle.stop()
    await once(client, 'close')
    await handle.stop()

    expect(handle.activeConnections).toBe(0)
    expect(counts.at(-1)).toBe(0)
    await expect(connectToPort(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    await echo.close()
  })
})
