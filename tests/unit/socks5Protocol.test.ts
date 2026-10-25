// @vitest-environment node

import { duplexPair, type Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  SOCKS5_REPLY_ADDRESS_UNSUPPORTED,
  SOCKS5_REPLY_COMMAND_UNSUPPORTED,
  SOCKS5_REPLY_GENERAL_FAILURE,
  Socks5ProtocolError,
  startSocks5Handshake,
  type Socks5Handshake,
} from '../../src/main/services/portForward/socks5Protocol'
import { readExact } from './helpers/fakeForwardingSession'

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function ipv4Request(
  address: [number, number, number, number],
  port: number,
  options: { command?: number; reserved?: number } = {},
): Buffer {
  return Buffer.from([
    5,
    options.command ?? 1,
    options.reserved ?? 0,
    1,
    ...address,
    (port >> 8) & 0xff,
    port & 0xff,
  ])
}

function methodGreeting(methods: number[] = [0]): Buffer {
  return Buffer.from([5, methods.length, ...methods])
}

interface Harness {
  server: Duplex
  client: Duplex
  handshake: Socks5Handshake
  dispose(): void
}

function createHarness(options: { timeoutMs?: number; maxBytes?: number } = {}): Harness {
  const [server, client] = duplexPair()
  const handshake = startSocks5Handshake(server, {
    timeoutMs: options.timeoutMs ?? 1_000,
    maxBytes: options.maxBytes,
  })
  return {
    server,
    client,
    handshake,
    dispose: () => {
      handshake.dispose()
      server.destroy()
      client.destroy()
    },
  }
}

async function negotiateNoAuth(harness: Harness): Promise<void> {
  harness.client.write(methodGreeting())
  const reply = await readExact(harness.client, 2)
  expect([...reply]).toEqual([5, 0])
}

describe('SOCKS5 protocol', () => {
  it('parses a fragmented no-auth IPv4 CONNECT request', async () => {
    const harness = createHarness()
    try {
      harness.client.write(Buffer.from([5, 1]))
      await tick()
      harness.client.write(Buffer.from([0]))
      expect([...(await readExact(harness.client, 2))]).toEqual([5, 0])

      const request = ipv4Request([10, 0, 0, 5], 8_080)
      harness.client.write(request.subarray(0, 3))
      await tick()
      harness.client.write(request.subarray(3, 7))
      await tick()
      harness.client.write(request.subarray(7))

      const result = await harness.handshake.done
      expect(result.request).toEqual({
        addressType: 'ipv4',
        targetHost: '10.0.0.5',
        targetPort: 8_080,
      })
      expect(result.leftover).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  it('preserves payload coalesced after a domain CONNECT request', async () => {
    const harness = createHarness()
    try {
      const domain = Buffer.from('example.com', 'utf8')
      const request = Buffer.concat([
        methodGreeting(),
        Buffer.from([5, 1, 0, 3, domain.length]),
        domain,
        Buffer.from([0x00, 0x50]),
        Buffer.from('EARLY_DATA', 'utf8'),
      ])
      harness.client.write(request)

      expect([...(await readExact(harness.client, 2))]).toEqual([5, 0])
      const result = await harness.handshake.done
      expect(result.request).toEqual({
        addressType: 'domain',
        targetHost: 'example.com',
        targetPort: 80,
      })
      expect(result.leftover.toString('utf8')).toBe('EARLY_DATA')
    } finally {
      harness.dispose()
    }
  })

  it('parses an IPv6 CONNECT request', async () => {
    const harness = createHarness()
    try {
      await negotiateNoAuth(harness)
      harness.client.write(
        Buffer.from([
          5,
          1,
          0,
          4,
          0x20,
          0x01,
          0x0d,
          0xb8,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          1,
          0x01,
          0xbb,
        ]),
      )

      const result = await harness.handshake.done
      expect(result.request).toEqual({
        addressType: 'ipv6',
        targetHost: '2001:db8::1',
        targetPort: 443,
      })
    } finally {
      harness.dispose()
    }
  })

  it('rejects BIND with the command-not-supported reply code', async () => {
    const harness = createHarness()
    try {
      const rejection = expect(harness.handshake.done).rejects.toMatchObject({
        name: 'Socks5ProtocolError',
        response: expect.any(Buffer),
      })
      await negotiateNoAuth(harness)
      harness.client.write(ipv4Request([10, 0, 0, 5], 8_080, { command: 2 }))

      const reply = await readExact(harness.client, 10)
      expect([...reply]).toEqual([5, SOCKS5_REPLY_COMMAND_UNSUPPORTED, 0, 1, 0, 0, 0, 0, 0, 0])
      await rejection
      await expect(harness.handshake.done).rejects.toBeInstanceOf(Socks5ProtocolError)
      expect(harness.server.listenerCount('data')).toBe(0)
    } finally {
      harness.dispose()
    }
  })

  it('rejects an unsupported address type with the address-not-supported reply code', async () => {
    const harness = createHarness()
    try {
      const rejection = expect(harness.handshake.done).rejects.toMatchObject({
        name: 'Socks5ProtocolError',
      })
      await negotiateNoAuth(harness)
      harness.client.write(Buffer.from([5, 1, 0, 9, 0, 0]))

      const reply = await readExact(harness.client, 10)
      expect([...reply]).toEqual([5, SOCKS5_REPLY_ADDRESS_UNSUPPORTED, 0, 1, 0, 0, 0, 0, 0, 0])
      await rejection
    } finally {
      harness.dispose()
    }
  })

  it('replies 0xff when the client only offers unsupported auth methods', async () => {
    const harness = createHarness()
    try {
      const rejection = expect(harness.handshake.done).rejects.toMatchObject({
        name: 'Socks5ProtocolError',
      })
      harness.client.write(methodGreeting([2]))

      const reply = await readExact(harness.client, 2)
      expect([...reply]).toEqual([5, 0xff])
      await rejection
    } finally {
      harness.dispose()
    }
  })

  it('uses general failure for invalid reserved fields and zero target port', async () => {
    const reserved = createHarness()
    try {
      const rejection = expect(reserved.handshake.done).rejects.toMatchObject({
        name: 'Socks5ProtocolError',
      })
      await negotiateNoAuth(reserved)
      reserved.client.write(ipv4Request([10, 0, 0, 5], 8_080, { reserved: 1 }))
      expect([...(await readExact(reserved.client, 10))][1]).toBe(
        SOCKS5_REPLY_GENERAL_FAILURE,
      )
      await rejection
    } finally {
      reserved.dispose()
    }

    const zeroPort = createHarness()
    try {
      const rejection = expect(zeroPort.handshake.done).rejects.toMatchObject({
        name: 'Socks5ProtocolError',
      })
      await negotiateNoAuth(zeroPort)
      zeroPort.client.write(ipv4Request([10, 0, 0, 5], 0))
      expect([...(await readExact(zeroPort.client, 10))][1]).toBe(
        SOCKS5_REPLY_GENERAL_FAILURE,
      )
      await rejection
    } finally {
      zeroPort.dispose()
    }
  })

  it('rejects an empty domain and removes its data listener', async () => {
    const harness = createHarness()
    try {
      const rejection = expect(harness.handshake.done).rejects.toMatchObject({
        name: 'Socks5ProtocolError',
      })
      await negotiateNoAuth(harness)
      harness.client.write(Buffer.from([5, 1, 0, 3, 0, 0x00, 0x50]))

      const reply = await readExact(harness.client, 10)
      expect(reply[1]).toBe(SOCKS5_REPLY_GENERAL_FAILURE)
      await rejection
      expect(harness.server.listenerCount('data')).toBe(0)
    } finally {
      harness.dispose()
    }
  })

  it('closes without a SOCKS reply for an unsupported protocol version', async () => {
    const harness = createHarness()
    try {
      const rejection = expect(harness.handshake.done).rejects.toMatchObject({
        name: 'Socks5ProtocolError',
      })
      harness.client.write(Buffer.from([4, 1, 0]))
      await rejection
      await tick()
      expect(harness.client.read()).toBeNull()
      expect(harness.server.listenerCount('data')).toBe(0)
    } finally {
      harness.dispose()
    }
  })

  it('times out a silent client and cleans up its listeners', async () => {
    const harness = createHarness({ timeoutMs: 20 })
    try {
      const rejection = expect(harness.handshake.done).rejects.toMatchObject({
        name: 'Socks5ProtocolError',
        timedOut: true,
        response: null,
      })
      await rejection
      expect(harness.server.listenerCount('data')).toBe(0)
      expect(harness.client.read()).toBeNull()
    } finally {
      harness.dispose()
    }
  })

  it('fails safely when handshake bytes exceed the configured limit', async () => {
    const harness = createHarness({ maxBytes: 16, timeoutMs: 1_000 })
    try {
      const rejection = expect(harness.handshake.done).rejects.toMatchObject({
        name: 'Socks5ProtocolError',
      })
      harness.client.write(Buffer.alloc(32, 0x05))

      const reply = await readExact(harness.client, 10)
      expect(reply[1]).toBe(SOCKS5_REPLY_GENERAL_FAILURE)
      await rejection
    } finally {
      harness.dispose()
    }
  })
})
