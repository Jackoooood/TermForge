// @vitest-environment node

import { once } from 'node:events'
import { createConnection, createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type {
  DynamicForwardRule,
  LocalForwardCreateInput,
  LocalForwardRule,
  PortForwardCreateInput,
  PortForwardItem,
  PortForwardRule,
  PortForwardSnapshot,
  PortForwardStoreState,
  PortForwardUpdateInput,
  RemoteForwardRule,
} from '../../src/shared/types/portForward'
import type { SshSessionSnapshot } from '../../src/shared/types/ssh'
import { SEED_CONNECTION_CATALOG } from '../../src/shared/fixtures/connectionSeed'
import {
  PortForwardService,
  type PortForwardServiceDependencies,
} from '../../src/main/services/portForward/PortForwardService'
import type { PortForwardStore } from '../../src/main/storage/portForwardRepository'
import {
  FakeForwardingSession,
  connectToPort,
  createEchoServer,
  getFreeLoopbackPort,
  readExact,
  waitFor,
} from './helpers/fakeForwardingSession'

const TIMESTAMP = '2026-10-23T08:00:00.000Z'
const UPDATED_TIMESTAMP = '2026-10-23T09:00:00.000Z'
const CONNECTION_A = 'conn-prod-web-01'
const CONNECTION_B = 'conn-prod-db-01'

function localRule(id: string, overrides: Partial<LocalForwardRule> = {}): LocalForwardRule {
  return {
    id,
    type: 'local',
    name: id,
    connectionId: CONNECTION_A,
    bindAddress: '127.0.0.1',
    bindPort: 1_000,
    targetHost: '127.0.0.1',
    targetPort: 5_432,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  }
}

function remoteRule(id: string, overrides: Partial<RemoteForwardRule> = {}): RemoteForwardRule {
  return {
    id,
    type: 'remote',
    name: id,
    connectionId: CONNECTION_A,
    bindAddress: '127.0.0.1',
    bindPort: 2_000,
    targetHost: '127.0.0.1',
    targetPort: 5_432,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  }
}

function dynamicRule(
  id: string,
  overrides: Partial<DynamicForwardRule> = {},
): DynamicForwardRule {
  return {
    id,
    type: 'dynamic',
    name: id,
    connectionId: CONNECTION_A,
    bindAddress: '127.0.0.1',
    bindPort: 1_080,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  }
}

function makeSession(overrides: Partial<SshSessionSnapshot> = {}): SshSessionSnapshot {
  return {
    clientId: 'client-1',
    sessionId: 'ssh-1',
    connectionId: CONNECTION_A,
    connectionName: 'prod-web-01',
    host: '10.20.4.11',
    port: 22,
    username: 'deploy',
    authMethod: 'privateKey',
    status: 'connected',
    jumps: [],
    activeHop: null,
    createdAt: TIMESTAMP,
    connectedAt: TIMESTAMP,
    hostKey: null,
    error: null,
    ...overrides,
  }
}

class MemoryPortForwardStore implements PortForwardStore {
  rules: PortForwardRule[]
  readonly createCalls: PortForwardCreateInput[] = []
  readonly removeCalls: string[] = []
  readonly removeForConnectionCalls: string[] = []
  private nextId = 1

  constructor(rules: PortForwardRule[] = []) {
    this.rules = structuredClone(rules)
  }

  async list(): Promise<PortForwardStoreState> {
    return { rules: structuredClone(this.rules) }
  }

  async create(input: PortForwardCreateInput): Promise<PortForwardRule> {
    this.createCalls.push(structuredClone(input))
    const base = {
      id: `pf-test-${this.nextId++}`,
      name: input.name,
      connectionId: input.connectionId,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    }
    const rule: PortForwardRule =
      input.type === 'dynamic'
        ? {
            ...base,
            type: 'dynamic',
            bindAddress: '127.0.0.1',
            bindPort: input.bindPort,
          }
        : {
            ...base,
            type: input.type,
            bindAddress: input.bindAddress ?? '127.0.0.1',
            bindPort: input.bindPort,
            targetHost: input.targetHost,
            targetPort: input.targetPort,
          }
    this.rules.push(rule)
    return structuredClone(rule)
  }

  async update(id: string, input: PortForwardUpdateInput): Promise<PortForwardRule> {
    const index = this.rules.findIndex((rule) => rule.id === id)
    const existing = this.rules[index]
    if (!existing) throw new Error('missing rule')

    let updated: PortForwardRule
    if (existing.type === 'dynamic') {
      if (input.type !== 'dynamic') throw new Error('type mismatch')
      updated = {
        ...existing,
        name: input.name,
        bindPort: input.bindPort,
        updatedAt: UPDATED_TIMESTAMP,
      }
    } else {
      if (input.type === 'dynamic') throw new Error('type mismatch')
      updated = {
        ...existing,
        name: input.name,
        bindAddress: input.bindAddress ?? '127.0.0.1',
        bindPort: input.bindPort,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        updatedAt: UPDATED_TIMESTAMP,
      }
    }
    this.rules[index] = updated
    return structuredClone(updated)
  }

  async remove(id: string): Promise<{ id: string }> {
    this.removeCalls.push(id)
    this.rules = this.rules.filter((rule) => rule.id !== id)
    return { id }
  }

  async removeForConnection(connectionId: string): Promise<{ ids: string[] }> {
    this.removeForConnectionCalls.push(connectionId)
    const ids = this.rules
      .filter((rule) => rule.connectionId === connectionId)
      .map((rule) => rule.id)
    this.rules = this.rules.filter((rule) => rule.connectionId !== connectionId)
    return { ids }
  }
}

class Harness {
  readonly store: MemoryPortForwardStore
  readonly snapshots: PortForwardSnapshot[] = []
  readonly facades = new Map<string, FakeForwardingSession>()
  readonly ssh: {
    getStatus: Mock<PortForwardServiceDependencies['ssh']['getStatus']>
    acquireForwardingSession: Mock<
      PortForwardServiceDependencies['ssh']['acquireForwardingSession']
    >
  }
  readonly connections: {
    list: Mock<PortForwardServiceDependencies['connections']['list']>
  }
  readonly service: PortForwardService

  constructor(
    rules: PortForwardRule[] = [],
    sessionConnections: Record<string, string> = {},
  ) {
    this.store = new MemoryPortForwardStore(rules)
    this.ssh = {
      getStatus: vi.fn(async (sessionId: string) =>
        makeSession({
          sessionId,
          connectionId: sessionConnections[sessionId] ?? CONNECTION_A,
        }),
      ),
      acquireForwardingSession: vi.fn((sessionId: string) => this.facadeFor(sessionId)),
    }
    this.connections = {
      list: vi.fn(async () => SEED_CONNECTION_CATALOG),
    }
    this.service = new PortForwardService({
      store: this.store,
      connections: this.connections,
      ssh: this.ssh,
      emitUpdate: (event) => this.snapshots.push(event.snapshot),
      now: () => new Date(TIMESTAMP),
    })
  }

  facadeFor(sessionId = 'ssh-1'): FakeForwardingSession {
    let facade = this.facades.get(sessionId)
    if (!facade) {
      facade = new FakeForwardingSession(sessionId)
      this.facades.set(sessionId, facade)
    }
    return facade
  }

  latestItem(ruleId: string): PortForwardItem | undefined {
    return this.snapshots.at(-1)?.items.find((item) => item.rule.id === ruleId)
  }

  async shutdownQuietly(): Promise<void> {
    try {
      await this.service.shutdown()
    } catch {
      // Tests may intentionally leave cleanup-pending state behind.
    }
  }
}

const harnesses: Harness[] = []

function createHarness(
  rules: PortForwardRule[] = [],
  sessionConnections: Record<string, string> = {},
): Harness {
  const harness = new Harness(rules, sessionConnections)
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.shutdownQuietly()
  }
})

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('port forward service', () => {
  it('lists persisted rules as stopped without touching SSH', async () => {
    const harness = createHarness([localRule('pf-local-1'), remoteRule('pf-remote-1')])

    const snapshot = await harness.service.list()

    expect(snapshot.revision).toBe(0)
    expect(snapshot.items).toHaveLength(2)
    for (const item of snapshot.items) {
      expect(item.runtime).toMatchObject({
        status: 'stopped',
        sessionId: null,
        boundAddress: null,
        boundPort: null,
        activeConnections: 0,
        lastStopReason: null,
        failure: null,
        cleanupPending: false,
      })
    }
    expect(harness.ssh.getStatus).not.toHaveBeenCalled()
    expect(harness.ssh.acquireForwardingSession).not.toHaveBeenCalled()
  })

  it('creates, updates and removes rules through the store and publishes snapshots', async () => {
    const harness = createHarness()
    const input: LocalForwardCreateInput = {
      type: 'local',
      name: 'docs preview',
      connectionId: CONNECTION_A,
      bindPort: 1_234,
      targetHost: '127.0.0.1',
      targetPort: 3_000,
    }

    const created = await harness.service.create(input)
    expect(created.runtime.status).toBe('stopped')
    expect(harness.store.createCalls).toHaveLength(1)
    expect(harness.snapshots.at(-1)?.items).toHaveLength(1)

    const updated = await harness.service.update(created.rule.id, {
      type: 'local',
      name: 'docs preview v2',
      bindAddress: '127.0.0.1',
      bindPort: 1_235,
      targetHost: '127.0.0.1',
      targetPort: 3_001,
    })
    expect(updated.rule.name).toBe('docs preview v2')
    expect(harness.snapshots.at(-1)?.items[0]?.rule.name).toBe('docs preview v2')

    await expect(harness.service.remove(created.rule.id)).resolves.toEqual({
      id: created.rule.id,
    })
    expect(harness.store.removeCalls).toEqual([created.rule.id])
    expect((await harness.service.list()).items).toEqual([])
  })

  it('rejects creating a rule for an unknown connection', async () => {
    const harness = createHarness()
    await expect(
      harness.service.create({
        type: 'local',
        name: 'orphan',
        connectionId: 'conn-missing',
        bindPort: 1_234,
        targetHost: '127.0.0.1',
        targetPort: 3_000,
      }),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(harness.store.createCalls).toEqual([])
  })

  it('binds a local listener only after a connected session and reports the actual port', async () => {
    const port = await getFreeLoopbackPort()
    const harness = createHarness([localRule('pf-local-run', { bindPort: port })])
    const facade = harness.facadeFor('ssh-1')

    const started = await harness.service.start({ ruleId: 'pf-local-run', sessionId: 'ssh-1' })

    expect(harness.ssh.getStatus).toHaveBeenCalledWith('ssh-1')
    expect(harness.ssh.acquireForwardingSession).toHaveBeenCalledWith('ssh-1')
    expect(started.runtime).toMatchObject({
      status: 'running',
      sessionId: 'ssh-1',
      boundAddress: '127.0.0.1',
      boundPort: port,
      startedAt: TIMESTAMP,
      cleanupPending: false,
    })
    expect(
      harness.snapshots.some((snapshot) =>
        snapshot.items.some((item) => item.runtime.status === 'starting'),
      ),
    ).toBe(true)

    const probe = await connectToPort(port)
    probe.destroy()

    const stopped = await harness.service.stop('pf-local-run')
    expect(stopped.runtime).toMatchObject({
      status: 'stopped',
      boundAddress: null,
      boundPort: null,
      lastStopReason: 'user',
    })
    expect(harness.latestItem('pf-local-run')?.runtime.status).toBe('stopped')
    expect(facade.closed).toBe(false)
    await expect(connectToPort(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('runs a dynamic SOCKS5 rule through the service and reports the bound port', async () => {
    const port = await getFreeLoopbackPort()
    const echo = await createEchoServer()
    const harness = createHarness([dynamicRule('pf-dynamic-run', { bindPort: port })])
    const facade = harness.facadeFor('ssh-1')
    facade.forwardOutHandler = async (srcAddress, srcPort, destAddress, destPort) => {
      expect([srcAddress, srcPort, destAddress, destPort]).toEqual([
        '127.0.0.1',
        0,
        'example.internal',
        echo.port,
      ])
      const upstream = createConnection({ host: '127.0.0.1', port: echo.port })
      await once(upstream, 'connect')
      return upstream
    }

    try {
      const started = await harness.service.start({
        ruleId: 'pf-dynamic-run',
        sessionId: 'ssh-1',
      })
      expect(started.runtime).toMatchObject({
        status: 'running',
        boundAddress: '127.0.0.1',
        boundPort: port,
        startedAt: TIMESTAMP,
      })

      const client = await connectToPort(port)
      client.write(Buffer.from([0x05, 0x01, 0x00]))
      expect((await readExact(client, 2)).toString('hex')).toBe('0500')

      const host = Buffer.from('example.internal')
      const request = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([(echo.port >> 8) & 0xff, echo.port & 0xff]),
      ])
      client.write(request)
      expect((await readExact(client, 10)).toString('hex')).toBe('05000001000000000000')

      client.write(Buffer.from('ping'))
      expect((await readExact(client, 4)).toString('utf8')).toBe('ping')

      const stopped = await harness.service.stop('pf-dynamic-run')
      expect(stopped.runtime).toMatchObject({
        status: 'stopped',
        boundAddress: null,
        boundPort: null,
        lastStopReason: 'user',
      })
      await waitFor(() => client.destroyed)
      await expect(connectToPort(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    } finally {
      await echo.close()
    }
  })

  it('reports a local bind failure as an error state instead of a false running state', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) =>
      blocker.listen({ host: '127.0.0.1', port: 0 }, resolve),
    )
    const address = blocker.address()
    if (typeof address !== 'object' || address === null) throw new Error('missing address')
    const harness = createHarness([localRule('pf-local-busy', { bindPort: address.port })])

    try {
      const result = await harness.service.start({
        ruleId: 'pf-local-busy',
        sessionId: 'ssh-1',
      })
      expect(result.runtime.status).toBe('error')
      expect(result.runtime.failure).toMatchObject({ code: 'bind-failed' })
      expect(harness.latestItem('pf-local-busy')?.runtime.status).toBe('error')

      const cleared = await harness.service.stop('pf-local-busy')
      expect(cleared.runtime.status).toBe('stopped')
    } finally {
      await closeServer(blocker)
    }
  })

  it('requires explicit exposure confirmation for non-loopback local binds', async () => {
    const harness = createHarness([
      localRule('pf-local-exposed', { bindAddress: '0.0.0.0', bindPort: 1_500 }),
    ])

    await expect(
      harness.service.start({ ruleId: 'pf-local-exposed', sessionId: 'ssh-1' }),
    ).rejects.toMatchObject({ code: 'permission-denied' })

    expect(harness.ssh.getStatus).not.toHaveBeenCalled()
    expect(harness.ssh.acquireForwardingSession).not.toHaveBeenCalled()
    expect((await harness.service.list()).items[0]?.runtime.status).toBe('stopped')
  })

  it('rejects disconnected sessions and sessions for a different connection', async () => {
    const harness = createHarness([remoteRule('pf-remote-preflight')])
    harness.ssh.getStatus.mockResolvedValueOnce(makeSession({ status: 'disconnected' }))
    await expect(
      harness.service.start({ ruleId: 'pf-remote-preflight', sessionId: 'ssh-1' }),
    ).rejects.toMatchObject({ code: 'unavailable' })

    harness.ssh.getStatus.mockResolvedValueOnce(makeSession({ connectionId: CONNECTION_B }))
    await expect(
      harness.service.start({ ruleId: 'pf-remote-preflight', sessionId: 'ssh-1' }),
    ).rejects.toMatchObject({ code: 'conflict' })

    expect(harness.ssh.acquireForwardingSession).not.toHaveBeenCalled()
  })

  it('stops a running rule when its SSH session closes without rebinding it', async () => {
    const harness = createHarness([remoteRule('pf-remote-session')])
    const facade = harness.facadeFor('ssh-1')
    await harness.service.start({ ruleId: 'pf-remote-session', sessionId: 'ssh-1' })

    facade.close()

    await waitFor(() => harness.latestItem('pf-remote-session')?.runtime.status === 'stopped')
    expect(harness.latestItem('pf-remote-session')?.runtime).toMatchObject({
      lastStopReason: 'session-ended',
      cleanupPending: false,
      sessionId: null,
    })
    expect(facade.unforwardInCalls).toEqual([])
    expect(harness.ssh.acquireForwardingSession).toHaveBeenCalledTimes(1)
  })

  it('turns an unbind failure into cleanupPending and blocks edit, delete and restart until retry', async () => {
    const harness = createHarness([remoteRule('pf-remote-unbind')])
    const facade = harness.facadeFor('ssh-1')
    let failUnbind = true
    facade.unforwardInHandler = async () => {
      if (failUnbind) throw new Error('unbind failed')
    }
    await harness.service.start({ ruleId: 'pf-remote-unbind', sessionId: 'ssh-1' })

    await expect(harness.service.stop('pf-remote-unbind')).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(harness.latestItem('pf-remote-unbind')?.runtime).toMatchObject({
      status: 'error',
      cleanupPending: true,
      failure: { code: 'unbind-failed' },
    })
    await expect(
      harness.service.update('pf-remote-unbind', {
        type: 'remote',
        name: 'changed',
        bindAddress: '127.0.0.1',
        bindPort: 2_000,
        targetHost: '127.0.0.1',
        targetPort: 5_432,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(harness.service.remove('pf-remote-unbind')).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(
      harness.service.start({ ruleId: 'pf-remote-unbind', sessionId: 'ssh-1' }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(harness.store.removeCalls).toEqual([])

    failUnbind = false
    const stopped = await harness.service.stop('pf-remote-unbind')
    expect(stopped.runtime.status).toBe('stopped')
    expect(stopped.runtime.cleanupPending).toBe(false)
    await expect(harness.service.remove('pf-remote-unbind')).resolves.toEqual({
      id: 'pf-remote-unbind',
    })
  })

  it('aborts connection cascade removal when any rule cannot stop, then retries', async () => {
    const harness = createHarness(
      [
        remoteRule('pf-a-1', { bindPort: 2_101 }),
        remoteRule('pf-a-2', { bindPort: 2_102 }),
        remoteRule('pf-b-1', { bindPort: 2_103, connectionId: CONNECTION_B }),
      ],
      { 'ssh-A': CONNECTION_A, 'ssh-B': CONNECTION_B },
    )
    const facadeA = harness.facadeFor('ssh-A')
    const facadeB = harness.facadeFor('ssh-B')
    let failingPort: number | null = 2_102
    facadeA.unforwardInHandler = async (_address, port) => {
      if (port === failingPort) throw new Error('unbind failed')
    }

    await harness.service.start({ ruleId: 'pf-a-1', sessionId: 'ssh-A' })
    await harness.service.start({ ruleId: 'pf-a-2', sessionId: 'ssh-A' })
    await harness.service.start({ ruleId: 'pf-b-1', sessionId: 'ssh-B' })

    await expect(
      harness.service.getConnectionRemovalImpact(CONNECTION_A),
    ).resolves.toEqual({
      connectionId: CONNECTION_A,
      portForwardRuleCount: 2,
      runningPortForwardCount: 2,
    })

    await expect(
      harness.service.removeForConnection(CONNECTION_A),
    ).rejects.toMatchObject({ code: 'unavailable' })

    expect(harness.store.removeForConnectionCalls).toEqual([])
    expect((await harness.service.list()).items).toHaveLength(3)
    expect(harness.latestItem('pf-a-1')?.runtime.status).toBe('stopped')
    expect(harness.latestItem('pf-a-2')?.runtime).toMatchObject({
      status: 'error',
      cleanupPending: true,
      failure: { code: 'unbind-failed' },
    })
    expect(harness.latestItem('pf-b-1')?.runtime.status).toBe('running')

    failingPort = null
    const removed = await harness.service.removeForConnection(CONNECTION_A)
    expect(removed.sort()).toEqual(['pf-a-1', 'pf-a-2'])
    expect(harness.store.removeForConnectionCalls).toEqual([CONNECTION_A])
    expect((await harness.service.list()).items.map((item) => item.rule.id)).toEqual([
      'pf-b-1',
    ])
    expect(harness.latestItem('pf-b-1')?.runtime.status).toBe('running')
    expect(facadeB.unforwardInCalls).toEqual([])
    await expect(
      harness.service.getConnectionRemovalImpact(CONNECTION_A),
    ).resolves.toEqual({
      connectionId: CONNECTION_A,
      portForwardRuleCount: 0,
      runningPortForwardCount: 0,
    })
  })

  it('enforces the active-rule limit and shuts every listener down on exit', async () => {
    const rules = Array.from({ length: 33 }, (_, index) =>
      remoteRule(`pf-limit-${index}`, { bindPort: 3_000 + index }),
    )
    const harness = createHarness(rules)
    const facade = harness.facadeFor('ssh-1')

    for (let index = 0; index < 32; index += 1) {
      await harness.service.start({
        ruleId: `pf-limit-${index}`,
        sessionId: 'ssh-1',
      })
    }
    await expect(
      harness.service.start({ ruleId: 'pf-limit-32', sessionId: 'ssh-1' }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' })

    await harness.service.shutdown()

    expect(facade.unforwardInCalls).toHaveLength(32)
    const items = (await harness.service.list()).items
    expect(items).toHaveLength(33)
    for (const item of items.slice(0, 32)) {
      expect(item.runtime.status).toBe('stopped')
      expect(item.runtime.lastStopReason).toBe('app-quit')
    }
    expect(items[32]?.runtime).toMatchObject({
      status: 'stopped',
      lastStopReason: null,
    })
    await expect(
      harness.service.start({ ruleId: 'pf-limit-0', sessionId: 'ssh-1' }),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('does not report a successful shutdown when a listener cannot be cleaned up', async () => {
    const harness = createHarness([remoteRule('pf-remote-shutdown')])
    const facade = harness.facadeFor('ssh-1')
    facade.unforwardInHandler = async () => {
      throw new Error('unbind failed')
    }
    await harness.service.start({ ruleId: 'pf-remote-shutdown', sessionId: 'ssh-1' })

    await expect(harness.service.shutdown()).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(harness.latestItem('pf-remote-shutdown')?.runtime).toMatchObject({
      status: 'error',
      cleanupPending: true,
    })
  })
})
