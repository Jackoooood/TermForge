// @vitest-environment node

import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectConfig, ClientChannel, SFTPWrapper } from 'ssh2'
import type {
  ConnectionCatalog,
  ConnectionProfile,
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalShellSnapshot,
} from '@shared/types'
import type { HostKeyRecord, HostKeyVerdict, PresentedHostKey } from '@shared/types/hostKey'
import type { SshConnectResult, SshJumpHop } from '@shared/types/ssh'
import type { ConnectionStore } from '../../src/main/storage/connectionRepository'
import type { HostKeyStore } from '../../src/main/storage/hostKeyRepository'
import {
  SshService,
  type SshClientLike,
  type SshServiceDependencies,
} from '../../src/main/services/ssh/SshService'
import type { SshChannelLike } from '../../src/main/services/terminal/ShellChannelManager'
import type {
  ResolvedSshAuth,
  SshCredentialResolver,
} from '../../src/main/services/ssh/credentialResolver'
import { SshFailureError } from '../../src/main/services/ssh/sshFailure'
import { parseHostKeyBlob } from '../../src/main/services/ssh/hostKeyBlob'

const NOW = new Date('2026-10-22T08:00:00.000Z')
const SECRET = 'correct horse battery staple'

function connection(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'conn-prod-web-01',
    name: 'prod-web-01',
    host: '10.20.4.11',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    groupId: 'production',
    tagIds: [],
    jumpConnectionIds: [],
    favorite: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  }
}

function hostKeyBlob(algorithm = 'ssh-ed25519'): Buffer {
  const type = Buffer.from(algorithm, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(type.length, 0)
  return Buffer.concat([length, type, Buffer.from('test-key-material', 'ascii')])
}

type Listener = (...args: unknown[]) => void

interface ShellRequest {
  term: string
  cols: number
  rows: number
}

class FakeChannel implements SshChannelLike {
  readonly listeners = new Map<string, Listener[]>()
  readonly written: string[] = []
  readonly windows: Array<[number, number, number, number]> = []
  paused = false
  resumed = 0
  closed = false
  ended = false
  destroyed = false

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

  write(data: string | Buffer): boolean {
    this.written.push(typeof data === 'string' ? data : data.toString('utf8'))
    return true
  }

  setWindow(rows: number, cols: number, height: number, width: number): void {
    this.windows.push([rows, cols, height, width])
  }

  close(): void {
    this.closed = true
  }

  end(): void {
    this.ended = true
  }

  destroy(): void {
    this.destroyed = true
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.resumed += 1
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

class FakeClient implements SshClientLike {
  readonly listeners = new Map<string, Listener[]>()
  readonly shellRequests: ShellRequest[] = []
  readonly channels: FakeChannel[] = []
  readonly forwards: Array<{ srcIP: string; srcPort: number; dstIP: string; dstPort: number }> = []
  readonly forwardChannels: FakeChannel[] = []
  readonly inboundForwards: Array<{ remoteAddr: string; remotePort: number }> = []
  readonly inboundUnforwards: Array<{ remoteAddr: string; remotePort: number }> = []
  config: ConnectConfig | null = null
  ended = false
  destroyed = false
  shellError: Error | null = null
  deferShell = false
  pendingShell: ((error: Error | null | undefined, channel: SshChannelLike) => void) | null = null
  forwardError: Error | null = null
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

  connect(config: ConnectConfig): void {
    this.config = config
  }

  end(): this {
    this.ended = true
    this.emit('close')
    return this
  }

  destroy(): this {
    this.destroyed = true
    this.emit('close')
    return this
  }

  shell(
    window: ShellRequest,
    callback: (error: Error | null | undefined, channel: SshChannelLike) => void,
  ): unknown {
    this.shellRequests.push({ ...window })
    if (this.deferShell) {
      this.pendingShell = callback
      return undefined
    }
    if (this.shellError) {
      queueMicrotask(() => callback(this.shellError, undefined as unknown as SshChannelLike))
      return undefined
    }
    const channel = new FakeChannel()
    this.channels.push(channel)
    queueMicrotask(() => callback(null, channel))
    return channel
  }

  sftp(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): unknown {
    queueMicrotask(() =>
      callback(
        new Error('SFTP is not configured for this test client'),
        undefined as unknown as SFTPWrapper,
      ),
    )
    return undefined
  }

  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, channel: ClientChannel) => void,
  ): unknown {
    this.forwards.push({ srcIP, srcPort, dstIP, dstPort })
    if (this.deferForward) {
      this.pendingForward = callback
      return undefined
    }
    if (this.forwardError) {
      const error = this.forwardError
      queueMicrotask(() => callback(error, undefined as unknown as ClientChannel))
      return undefined
    }
    const channel = new FakeChannel()
    this.forwardChannels.push(channel)
    queueMicrotask(() => callback(undefined, channel as unknown as ClientChannel))
    return channel
  }

  completeForward(error: Error | null = null): void {
    const pending = this.pendingForward
    this.pendingForward = null
    if (!pending) throw new Error('no deferred forward request')
    if (error) {
      pending(error, undefined as unknown as ClientChannel)
      return
    }
    const channel = new FakeChannel()
    this.forwardChannels.push(channel)
    pending(undefined, channel as unknown as ClientChannel)
  }

  forwardIn(
    remoteAddr: string,
    remotePort: number,
    callback: (error: Error | undefined, actualPort: number) => void,
  ): unknown {
    this.inboundForwards.push({ remoteAddr, remotePort })
    queueMicrotask(() => callback(undefined, remotePort))
    return undefined
  }

  unforwardIn(
    remoteAddr: string,
    remotePort: number,
    callback: (error: Error | undefined) => void,
  ): unknown {
    this.inboundUnforwards.push({ remoteAddr, remotePort })
    queueMicrotask(() => callback(undefined))
    return undefined
  }

  completeShell(error: Error | null = null): void {
    const pending = this.pendingShell
    this.pendingShell = null
    if (!pending) throw new Error('no deferred shell request')
    if (error) {
      pending(error, undefined as unknown as SshChannelLike)
      return
    }
    const channel = new FakeChannel()
    this.channels.push(channel)
    pending(null, channel)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  ready(): void {
    this.emit('ready')
  }

  fail(error: unknown): void {
    this.emit('error', error)
  }
}

interface HarnessOptions {
  profiles?: ConnectionProfile[]
  verdict?: HostKeyVerdict
  auth?: ResolvedSshAuth | Error
  verifyImpl?: (presented: PresentedHostKey) => Promise<HostKeyVerdict>
  resolveImpl?: (connection: ConnectionProfile) => Promise<ResolvedSshAuth>
  hostKeyTimeoutMs?: number
  maxActiveSessions?: number
  shellOpenTimeoutMs?: number
  shellOutputFlushMs?: number
}

type ChallengeRecord = PresentedHostKey & { hop?: SshJumpHop }

function createHarness(options: HarnessOptions = {}) {
  const profiles = options.profiles ?? [connection()]
  const verdict = options.verdict ?? 'trusted'
  const auth = options.auth ?? { method: 'password', password: SECRET }

  const clients: FakeClient[] = []
  const statuses: SshConnectResult['session'][] = []
  const challenges: ChallengeRecord[] = []
  const terminalStatuses: TerminalShellSnapshot[] = []
  const terminalOutputs: TerminalOutputEvent[] = []
  const terminalExits: TerminalExitEvent[] = []
  const terminated: string[] = []
  let lastChallenge: { requestId: string; sessionId: string } | null = null

  const list = vi.fn(async (): Promise<ConnectionCatalog> => ({
    tags: [],
    connections: profiles,
    groups: [],
  }))
  const connections = {
    list,
    create: async () => {
      throw new Error('unused')
    },
    update: async () => {
      throw new Error('unused')
    },
    remove: async () => {
      throw new Error('unused')
    },
    setFavorite: async () => {
      throw new Error('unused')
    },
  } satisfies ConnectionStore

  const verify = vi.fn(
    options.verifyImpl ?? (async (_presented: PresentedHostKey): Promise<HostKeyVerdict> => verdict),
  )
  const trust = vi.fn(async (presented: PresentedHostKey): Promise<HostKeyRecord> => ({
    ...presented,
    trustedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }))
  const hostKeys: HostKeyStore = {
    list: async () => [],
    verify,
    trust,
    remove: async () => false,
  }

  const resolve = vi.fn(
    options.resolveImpl ??
      (async (_connection: ConnectionProfile): Promise<ResolvedSshAuth> => {
        if (auth instanceof Error) throw auth
        return auth
      }),
  )
  const saveCredential = vi.fn(async () => {})
  const credentialResolver: SshCredentialResolver = { resolve, saveCredential }

  const dependencies: SshServiceDependencies = {
    connections,
    hostKeys,
    credentialResolver,
    createClient: () => {
      const client = new FakeClient()
      clients.push(client)
      return client
    },
    emitStatus: (event) => {
      statuses.push(structuredClone(event.session))
    },
    emitHostKeyRequest: (event) => {
      challenges.push({
        host: event.challenge.host,
        port: event.challenge.port,
        algorithm: event.challenge.algorithm,
        fingerprint: event.challenge.fingerprint,
        ...(event.challenge.hop ? { hop: event.challenge.hop } : {}),
      })
      lastChallenge = { requestId: event.challenge.requestId, sessionId: event.challenge.sessionId }
    },
    emitTerminalOutput: (event) => {
      terminalOutputs.push(structuredClone(event))
    },
    emitTerminalStatus: (event) => {
      terminalStatuses.push(structuredClone(event))
    },
    emitTerminalExit: (event) => {
      terminalExits.push(structuredClone(event))
    },
    onSessionTerminated: (sessionId) => {
      terminated.push(sessionId)
    },
    now: () => NOW,
    hostKeyTimeoutMs: options.hostKeyTimeoutMs ?? 30_000,
    disconnectGraceMs: 20,
    maxActiveSessions: options.maxActiveSessions ?? 32,
    shellOpenTimeoutMs: options.shellOpenTimeoutMs ?? 1_000,
    shellOutputFlushMs: options.shellOutputFlushMs ?? 1,
  }

  const service = new SshService(dependencies)

  async function waitForClient(index = 0): Promise<FakeClient> {
    await vi.waitFor(() => expect(clients[index]?.config).toBeTruthy())
    return clients[index] as FakeClient
  }

  function invokeVerifier(client: FakeClient): ReturnType<typeof vi.fn> {
    // ssh2 emits this error synchronously from inside the verifier callback.
    const verifyCallback = vi.fn((accepted: boolean) => {
      if (!accepted) client.fail(new Error('Host denied (verification failed)'))
    })
    const verifier = client.config?.hostVerifier as unknown as (
      key: Buffer,
      callback: (accepted: boolean) => void,
    ) => void
    expect(verifier).toBeTypeOf('function')
    verifier(hostKeyBlob(), verifyCallback)
    return verifyCallback
  }

  return {
    service,
    profiles,
    clients,
    statuses,
    challenges,
    terminalStatuses,
    terminalOutputs,
    terminalExits,
    terminated,
    list,
    verify,
    trust,
    resolve,
    saveCredential,
    waitForClient,
    invokeVerifier,
    get lastChallenge(): { requestId: string; sessionId: string } {
      if (!lastChallenge) throw new Error('no host-key challenge emitted')
      return lastChallenge
    },
    lastStatus: () => statuses.at(-1),
  }
}

async function connectTrusted(
  harness: ReturnType<typeof createHarness>,
  clientId = 'sshtab-test',
  clientIndex = 0,
) {
  const promise = harness.service.connect(harness.profiles[0]!.id, clientId)
  const client = await harness.waitForClient(clientIndex)
  const verifier = harness.invokeVerifier(client)
  await vi.waitFor(() => expect(verifier).toHaveBeenCalledWith(true))
  client.ready()
  return { result: await promise, client }
}

describe('SshService connection lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('builds a password ConnectConfig from resolved credentials and reaches connected', async () => {
    const harness = createHarness({
      auth: { method: 'password', password: SECRET },
    })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()

    expect(client.config).toMatchObject({
      host: '10.20.4.11',
      port: 22,
      username: 'deploy',
      password: SECRET,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
      readyTimeout: 90_000,
    })
    expect(client.config).not.toHaveProperty('privateKey')
    expect(client.config).not.toHaveProperty('agent')

    const verifier = harness.invokeVerifier(client)
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledWith(true))
    expect(harness.trust).not.toHaveBeenCalled()
    client.ready()

    const result = await promise
    expect(result.reused).toBe(false)
    expect(result.session).toMatchObject({
      connectionId: 'conn-prod-web-01',
      status: 'connected',
      connectedAt: NOW.toISOString(),
      error: null,
    })
    expect(harness.statuses.map((session) => session.status)).toEqual([
      'connecting',
      'authenticating',
      'connected',
    ])
    expect(JSON.stringify(harness.statuses)).not.toContain(SECRET)
  })

  it('builds a private-key ConnectConfig including the passphrase', async () => {
    const privateKey = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key\n', 'utf8')
    const harness = createHarness({
      profiles: [connection({ authMethod: 'privateKey', credentialRef: 'C:\\keys\\id_ed25519' })],
      auth: { method: 'privateKey', privateKey, passphrase: 'key-passphrase' },
    })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()

    expect(client.config?.privateKey).toBe(privateKey)
    expect(client.config?.passphrase).toBe('key-passphrase')
    expect(client.config).not.toHaveProperty('password')
    expect(client.config).not.toHaveProperty('agent')

    const verifier = harness.invokeVerifier(client)
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledWith(true))
    client.ready()
    await promise

    const serialized = JSON.stringify(harness.statuses)
    expect(serialized).not.toContain('secret-key')
    expect(serialized).not.toContain('key-passphrase')
  })

  it('builds an agent ConnectConfig when the resolver located the system agent', async () => {
    const harness = createHarness({
      profiles: [connection({ authMethod: 'sshAgent', credentialRef: undefined })],
      auth: { method: 'sshAgent', agent: '\\\\.\\pipe\\openssh-ssh-agent' },
    })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()

    expect(client.config?.agent).toBe('\\\\.\\pipe\\openssh-ssh-agent')
    expect(client.config).not.toHaveProperty('password')
    expect(client.config).not.toHaveProperty('privateKey')

    const verifier = harness.invokeVerifier(client)
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledWith(true))
    client.ready()
    await promise
  })

  it('surfaces missing credentials as an actionable error without creating a client', async () => {
    const harness = createHarness({
      auth: new SshFailureError('credential-required', 'password'),
    })

    const result = await harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    expect(result.session.status).toBe('error')
    expect(result.session.error).toMatchObject({
      code: 'credential-required',
      credentialKind: 'password',
    })
    expect(harness.clients).toHaveLength(0)
    expect(harness.statuses.map((session) => session.status)).toEqual(['connecting', 'error'])
  })

  it('rejects invalid, unknown and excess connection requests before creating clients', async () => {
    const harness = createHarness({ maxActiveSessions: 1 })
    await expect(harness.service.connect('../bad', 'sshtab-test')).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(
      harness.service.connect('conn-does-not-exist', 'sshtab-test'),
    ).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(
      harness.service.connect(harness.profiles[0]!.id, 'not-a-client-id'),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    const second = connection({ id: 'conn-stage-api', name: 'stage-api' })
    harness.profiles.push(second)
    await connectTrusted(harness)
    await expect(harness.service.connect(second.id, 'sshtab-second')).rejects.toMatchObject({
      code: 'limit-exceeded',
    })
    expect(harness.clients).toHaveLength(1)
  })

  it('reuses one main-process session for duplicate client requests', async () => {
    const harness = createHarness()
    const { result } = await connectTrusted(harness)

    const duplicate = await harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    expect(duplicate.reused).toBe(true)
    expect(duplicate.session.sessionId).toBe(result.session.sessionId)
    expect(duplicate.session.clientId).toBe('sshtab-test')
    expect(harness.clients).toHaveLength(1)
    expect(harness.list).toHaveBeenCalledTimes(2)
  })

  it('creates independent transports for the same profile in different tabs', async () => {
    const harness = createHarness()
    const { result: first, client: firstClient } = await connectTrusted(harness, 'sshtab-one')
    const { result: second, client: secondClient } = await connectTrusted(harness, 'sshtab-two', 1)

    expect(first.session.sessionId).not.toBe(second.session.sessionId)
    expect(first.session.clientId).toBe('sshtab-one')
    expect(second.session.clientId).toBe('sshtab-two')
    expect(first.session.connectionId).toBe(second.session.connectionId)
    expect(harness.clients).toHaveLength(2)
    expect(firstClient).not.toBe(secondClient)

    firstClient.emit('close')
    expect(harness.lastStatus()).toMatchObject({
      clientId: 'sshtab-one',
      sessionId: first.session.sessionId,
      status: 'disconnected',
    })
    await expect(harness.service.getStatus(second.session.sessionId)).resolves.toMatchObject({
      status: 'connected',
    })
    expect(secondClient.ended || secondClient.destroyed).toBe(false)
  })

  it('maps remote close and network interruption to readable disconnected states', async () => {
    const harness = createHarness()
    const { result, client } = await connectTrusted(harness)

    client.emit('close')
    expect(harness.lastStatus()).toMatchObject({
      sessionId: result.session.sessionId,
      status: 'disconnected',
      error: { code: 'remote-closed' },
    })
    await expect(harness.service.getStatus(result.session.sessionId)).resolves.toMatchObject({
      status: 'disconnected',
    })
  })

  it('never forwards raw ssh2 error text or secrets to the renderer snapshot', async () => {
    const harness = createHarness()
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledWith(true))

    client.fail(
      new Error(
        `Permission denied for deploy@10.20.4.11 while using password ${SECRET} and key supersecret`,
      ),
    )
    await promise

    const snapshot = harness.lastStatus()
    expect(snapshot?.status).toBe('error')
    expect(snapshot?.error?.message).not.toContain(SECRET)
    expect(snapshot?.error?.message).not.toContain('Permission denied')
    expect(snapshot?.error?.message).not.toContain('10.20.4.11')
  })
})

describe('SshService host key verification', () => {
  it('waits for an explicit decision on a first-seen key and never auto-trusts', async () => {
    const harness = createHarness({ verdict: 'unknown' })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)

    const result = await promise
    expect(result.session.status).toBe('awaiting-host-key')
    expect(harness.challenges).toHaveLength(1)
    expect(harness.challenges[0]).toMatchObject({
      host: '10.20.4.11',
      port: 22,
      algorithm: 'ssh-ed25519',
    })
    expect(harness.challenges[0]?.fingerprint).toMatch(/^SHA256:/)
    expect(verifier).not.toHaveBeenCalled()
    expect(harness.trust).not.toHaveBeenCalled()

    const ack = await harness.service.respondToHostKey(harness.lastChallenge.requestId, true)
    expect(ack).toEqual({ requestId: harness.lastChallenge.requestId, accepted: true })
    expect(harness.trust).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '10.20.4.11',
        port: 22,
        fingerprint: harness.challenges[0]?.fingerprint,
      }),
    )
    expect(verifier).toHaveBeenCalledWith(true)

    await expect(harness.service.getStatus(result.session.sessionId)).resolves.toMatchObject({
      status: 'authenticating',
      hostKey: { fingerprint: harness.challenges[0]?.fingerprint },
    })

    client.ready()
    await vi.waitFor(() => expect(harness.lastStatus()).toMatchObject({ status: 'connected' }))
  })

  it('rejects a first-seen key without writing trust when the user refuses', async () => {
    const harness = createHarness({ verdict: 'unknown' })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)
    await promise

    const ack = await harness.service.respondToHostKey(harness.lastChallenge.requestId, false)
    expect(ack.accepted).toBe(false)
    expect(verifier).toHaveBeenCalledWith(false)
    expect(harness.trust).not.toHaveBeenCalled()
    expect(harness.lastStatus()).toMatchObject({
      status: 'error',
      error: { code: 'host-key-rejected' },
    })
    expect(client.destroyed).toBe(true)
  })

  it('accepts a trusted key without a confirmation prompt', async () => {
    const harness = createHarness({ verdict: 'trusted' })
    const { result } = await connectTrusted(harness)

    expect(harness.challenges).toHaveLength(0)
    expect(harness.trust).not.toHaveBeenCalled()
    expect(result.session.status).toBe('connected')
    expect(result.session.hostKey?.algorithm).toBe('ssh-ed25519')
  })

  it('blocks a changed key and keeps the existing trust decision', async () => {
    const harness = createHarness({ verdict: 'changed' })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)
    const result = await promise

    expect(verifier).toHaveBeenCalledWith(false)
    expect(result.session.status).toBe('error')
    expect(result.session.error?.code).toBe('host-key-changed')
    expect(harness.challenges).toHaveLength(0)
    expect(harness.trust).not.toHaveBeenCalled()
    expect(client.destroyed).toBe(true)
  })

  it('fails closed when host-key storage cannot be read', async () => {
    const harness = createHarness()
    harness.verify.mockRejectedValueOnce(new Error('disk unavailable'))
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)
    const result = await promise

    expect(verifier).toHaveBeenCalledWith(false)
    expect(result.session.error?.code).toBe('host-key-storage-failed')
    expect(harness.challenges).toHaveLength(0)
  })

  it('cancels the connection when a trust decision cannot be persisted', async () => {
    const harness = createHarness({ verdict: 'unknown' })
    harness.trust.mockRejectedValueOnce(new Error('write failure'))
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)
    await promise

    await expect(
      harness.service.respondToHostKey(harness.lastChallenge.requestId, true),
    ).rejects.toMatchObject({ code: 'storage-write-failed' })
    expect(verifier).toHaveBeenCalledWith(false)
    expect(harness.lastStatus()).toMatchObject({
      status: 'error',
      error: { code: 'host-key-storage-failed' },
    })
    await expect(
      harness.service.respondToHostKey(harness.lastChallenge.requestId, true),
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('times out an unanswered first-seen key and refuses a later stale answer', async () => {
    const harness = createHarness({ verdict: 'unknown', hostKeyTimeoutMs: 15 })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)
    await promise

    await vi.waitFor(
      () =>
        expect(harness.lastStatus()).toMatchObject({
          status: 'error',
          error: { code: 'host-key-timeout' },
        }),
      { timeout: 1_000, interval: 10 },
    )
    expect(verifier).toHaveBeenCalledWith(false)
    await expect(
      harness.service.respondToHostKey(harness.lastChallenge.requestId, true),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(harness.trust).not.toHaveBeenCalled()
  })

  it('fails closed on a malformed host-key blob', async () => {
    const harness = createHarness()
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = vi.fn()
    const verifierFn = client.config?.hostVerifier as unknown as (
      key: Buffer,
      callback: (accepted: boolean) => void,
    ) => void
    verifierFn(Buffer.from('not-a-key'), verifier)

    const result = await promise
    expect(verifier).toHaveBeenCalledWith(false)
    expect(result.session.error?.code).toBe('host-key-verification-failed')
    expect(harness.challenges).toHaveLength(0)
  })

  it('cancels a pending host-key prompt on disconnect without trusting the key', async () => {
    const harness = createHarness({ verdict: 'unknown' })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)
    const result = await promise

    await expect(harness.service.disconnect(result.session.sessionId)).resolves.toMatchObject({
      status: 'disconnected',
    })
    expect(verifier).toHaveBeenCalledWith(false)
    expect(harness.trust).not.toHaveBeenCalled()
    await expect(
      harness.service.respondToHostKey(harness.lastChallenge.requestId, true),
    ).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('SshService teardown and cancellation', () => {
  it('exposes the client to SFTP only while connected and notifies teardown once', async () => {
    const harness = createHarness()
    const { result, client } = await connectTrusted(harness)

    expect(harness.service.getSftpClient(result.session.sessionId)).toBe(client)
    expect(() => harness.service.getSftpClient('../bad-session')).toThrowError(/会话 ID 格式无效/)
    expect(() => harness.service.getSftpClient('ssh-missing')).toThrowError(/找不到该 SSH 会话/)
    expect(harness.terminated).toEqual([])

    await harness.service.disconnect(result.session.sessionId)
    expect(harness.terminated).toEqual([result.session.sessionId])
    expect(() => harness.service.getSftpClient(result.session.sessionId)).toThrowError(/已断开/)

    await harness.service.disconnect(result.session.sessionId)
    expect(harness.terminated).toEqual([result.session.sessionId])
  })

  it('refuses SFTP access before the SSH session reaches connected', async () => {
    const harness = createHarness({ verdict: 'unknown' })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    harness.invokeVerifier(client)
    const result = await promise

    expect(result.session.status).toBe('awaiting-host-key')
    expect(() => harness.service.getSftpClient(result.session.sessionId)).toThrowError(
      /尚未连接完成/,
    )
    expect(harness.terminated).toEqual([])

    await harness.service.disconnect(result.session.sessionId)
    expect(harness.terminated).toEqual([result.session.sessionId])
  })

  it('disconnects an established session and releases the ssh2 client', async () => {
    const harness = createHarness()
    const { result, client } = await connectTrusted(harness)

    const snapshot = await harness.service.disconnect(result.session.sessionId)
    expect(snapshot).toMatchObject({
      status: 'disconnected',
      connectedAt: result.session.connectedAt,
    })
    expect(snapshot.error).toBeNull()
    expect(client.ended).toBe(true)
    await expect(harness.service.getStatus(result.session.sessionId)).resolves.toMatchObject({
      status: 'disconnected',
    })
  })

  it('cancels only the targeted in-flight attempt and is idempotent', async () => {
    const harness = createHarness()
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-a')
    const client = await harness.waitForClient()

    const ack = await harness.service.cancelConnect('sshtab-a')
    expect(ack.cancelled).toBe(true)
    expect(ack.session).toMatchObject({
      clientId: 'sshtab-a',
      status: 'disconnected',
      error: { code: 'cancelled' },
    })
    expect(client.destroyed).toBe(true)
    await expect(promise).resolves.toMatchObject({
      session: { status: 'disconnected', error: { code: 'cancelled' } },
    })

    const repeated = await harness.service.cancelConnect('sshtab-a')
    expect(repeated.cancelled).toBe(false)
    expect(repeated.session).toMatchObject({
      sessionId: ack.session?.sessionId,
      status: 'disconnected',
      error: { code: 'cancelled' },
    })

    // A late ready event from the aborted transport must not revive the tab.
    client.ready()
    await expect(harness.service.getStatus(ack.session!.sessionId)).resolves.toMatchObject({
      status: 'disconnected',
      error: { code: 'cancelled' },
    })

    await expect(harness.service.cancelConnect('sshtab-missing')).resolves.toEqual({
      cancelled: false,
      session: null,
    })
    await expect(harness.service.cancelConnect('bad tab')).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('cancels while credentials are still being resolved without creating a client', async () => {
    let releaseAuth!: (auth: ResolvedSshAuth) => void
    const authGate = new Promise<ResolvedSshAuth>((resolve) => {
      releaseAuth = resolve
    })
    const harness = createHarness({ resolveImpl: () => authGate })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    await vi.waitFor(() => expect(harness.resolve).toHaveBeenCalled())

    const ack = await harness.service.cancelConnect('sshtab-test')
    expect(ack).toMatchObject({ cancelled: true, session: { status: 'disconnected' } })
    expect(harness.clients).toHaveLength(0)

    releaseAuth({ method: 'password', password: SECRET })
    await expect(promise).resolves.toMatchObject({
      session: { status: 'disconnected', error: { code: 'cancelled' } },
    })
    expect(harness.clients).toHaveLength(0)
  })

  it('cancels a pending host-key prompt without trusting the key', async () => {
    const harness = createHarness({ verdict: 'unknown' })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)
    const result = await promise
    expect(result.session.status).toBe('awaiting-host-key')

    const ack = await harness.service.cancelConnect('sshtab-test')
    expect(ack.cancelled).toBe(true)
    expect(ack.session).toMatchObject({
      status: 'disconnected',
      error: { code: 'cancelled' },
    })
    expect(verifier).toHaveBeenCalledWith(false)
    expect(harness.trust).not.toHaveBeenCalled()
    await expect(
      harness.service.respondToHostKey(harness.lastChallenge.requestId, true),
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('never tears down an established connection through cancelConnect', async () => {
    const harness = createHarness()
    const { result, client } = await connectTrusted(harness)

    const ack = await harness.service.cancelConnect('sshtab-test')
    expect(ack.cancelled).toBe(false)
    expect(ack.session).toMatchObject({
      sessionId: result.session.sessionId,
      status: 'connected',
    })
    expect(client.ended).toBe(false)
    expect(client.destroyed).toBe(false)
    await expect(harness.service.getStatus(result.session.sessionId)).resolves.toMatchObject({
      status: 'connected',
    })
  })

  it('cancels only the requested tab and leaves another session untouched', async () => {
    const harness = createHarness()
    const first = harness.service.connect(harness.profiles[0]!.id, 'sshtab-a')
    const second = harness.service.connect(harness.profiles[0]!.id, 'sshtab-b')
    const firstClient = await harness.waitForClient(0)
    const secondClient = await harness.waitForClient(1)

    const ack = await harness.service.cancelConnect('sshtab-a')
    expect(ack.cancelled).toBe(true)
    expect(firstClient.destroyed).toBe(true)
    expect(secondClient.destroyed).toBe(false)
    await expect(first).resolves.toMatchObject({
      session: { clientId: 'sshtab-a', status: 'disconnected' },
    })

    const verifier = harness.invokeVerifier(secondClient)
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledWith(true))
    secondClient.ready()
    await expect(second).resolves.toMatchObject({
      session: { clientId: 'sshtab-b', status: 'connected' },
    })
  })

  it('closes every live session on window close and keeps the service reusable', async () => {
    const harness = createHarness({ verdict: 'unknown' })
    const promise = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const verifier = harness.invokeVerifier(client)
    const result = await promise

    harness.service.cancelAll()
    expect(verifier).toHaveBeenCalledWith(false)
    expect(harness.lastStatus()).toMatchObject({
      status: 'disconnected',
      error: { code: 'cancelled' },
    })
    expect(client.destroyed).toBe(true)
    await expect(harness.service.getStatus(result.session.sessionId)).resolves.toMatchObject({
      status: 'disconnected',
    })
  })

  it('dispose aborts clients and makes the service unusable', async () => {
    const harness = createHarness()
    const { result, client } = await connectTrusted(harness)

    harness.service.dispose()
    harness.service.dispose()
    expect(client.destroyed).toBe(true)
    expect(() => harness.service.getStatus(result.session.sessionId)).toThrowError(/应用正在退出/)
    await expect(
      harness.service.connect(harness.profiles[0]!.id, 'sshtab-test'),
    ).rejects.toMatchObject({
      code: 'internal',
    })
  })

  it('validates and routes saved credentials through the resolver', async () => {
    const harness = createHarness()

    await expect(
      harness.service.saveCredential({
        connectionId: harness.profiles[0]!.id,
        kind: 'password',
        secret: SECRET,
      }),
    ).resolves.toEqual({ connectionId: harness.profiles[0]!.id, kind: 'password' })
    expect(harness.saveCredential).toHaveBeenCalledWith(harness.profiles[0], 'password', SECRET)

    await expect(
      harness.service.saveCredential({
        connectionId: 'conn-missing',
        kind: 'password',
        secret: SECRET,
      }),
    ).rejects.toMatchObject({ code: 'not-found' })
    await expect(
      harness.service.saveCredential({
        connectionId: harness.profiles[0]!.id,
        kind: 'password',
        secret: '',
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })
})

describe('SshService interactive shell', () => {
  async function openShellFor(
    harness: ReturnType<typeof createHarness>,
    sessionId: string,
    size: { cols: number; rows: number } = { cols: 100, rows: 40 },
  ) {
    const pending = harness.service.openShell(sessionId, size)
    await vi.waitFor(() => expect(harness.clients[0]?.channels.length).toBe(1))
    await pending
    return harness.clients[0]!.channels[0]!
  }

  it('opens one xterm-256color PTY with an explicit cols/rows request', async () => {
    const harness = createHarness()
    const { result, client } = await connectTrusted(harness)

    const channel = await openShellFor(harness, result.session.sessionId)

    expect(client.shellRequests).toEqual([{ term: 'xterm-256color', cols: 100, rows: 40 }])
    expect(channel.windows[0]).toEqual([40, 100, 0, 0])
    expect(harness.terminalStatuses.map((snapshot) => snapshot.status)).toEqual(['opening', 'open'])
    await expect(harness.service.getShellStatus(result.session.sessionId)).resolves.toMatchObject({
      status: 'open',
      size: { cols: 100, rows: 40 },
    })
  })

  it('reuses the PTY, routes input and keeps setWindow in rows/cols order', async () => {
    const harness = createHarness()
    const { result } = await connectTrusted(harness)
    const channel = await openShellFor(harness, result.session.sessionId)

    const reused = await harness.service.openShell(result.session.sessionId, {
      cols: 90,
      rows: 30,
    })
    expect(reused).toMatchObject({ reused: true, status: 'open', size: { cols: 90, rows: 30 } })
    expect(harness.clients[0]?.shellRequests).toHaveLength(1)
    expect(channel.windows.at(-1)).toEqual([30, 90, 0, 0])

    await expect(harness.service.writeShell(result.session.sessionId, 'pwd\r')).resolves.toEqual({
      sessionId: result.session.sessionId,
    })
    expect(channel.written).toEqual(['pwd\r'])

    await harness.service.resizeShell(result.session.sessionId, { cols: 120, rows: 50 })
    expect(channel.windows.at(-1)).toEqual([50, 120, 0, 0])
    await expect(
      harness.service.writeShell(result.session.sessionId, 'x'.repeat(65_537)),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(channel.written).toEqual(['pwd\r'])
  })

  it('decodes split UTF-8 data and tags every output event with the session id', async () => {
    const harness = createHarness()
    const { result } = await connectTrusted(harness)
    const channel = await openShellFor(harness, result.session.sessionId)
    const bytes = Buffer.from('你好，终端', 'utf8')

    channel.emit('data', bytes.subarray(0, 4))
    channel.emit('data', bytes.subarray(4))

    await vi.waitFor(() =>
      expect(harness.terminalOutputs.map((event) => event.data).join('')).toBe('你好，终端'),
    )
    expect(
      harness.terminalOutputs.every((event) => event.sessionId === result.session.sessionId),
    ).toBe(true)
  })

  it('reports remote exit, channel errors and local close exactly once', async () => {
    const first = createHarness()
    const firstSession = await connectTrusted(first)
    const firstChannel = await openShellFor(first, firstSession.result.session.sessionId)

    firstChannel.emit('exit', 0, undefined)
    await vi.waitFor(() =>
      expect(first.terminalStatuses.at(-1)).toMatchObject({
        status: 'exited',
        exit: { code: 0, reason: 'remote-exit' },
      }),
    )
    expect(first.terminalExits).toEqual([
      {
        sessionId: firstSession.result.session.sessionId,
        code: 0,
        signal: null,
        reason: 'remote-exit',
      },
    ])
    firstChannel.emit('close')
    expect(first.terminalExits).toHaveLength(1)

    const second = createHarness()
    const secondSession = await connectTrusted(second)
    const secondChannel = await openShellFor(second, secondSession.result.session.sessionId)
    secondChannel.emit('error', new Error('channel failure'))
    await vi.waitFor(() =>
      expect(second.terminalStatuses.at(-1)).toMatchObject({
        status: 'error',
        failure: { code: 'shell-error' },
      }),
    )
    expect(second.terminalExits.at(-1)).toMatchObject({ reason: 'error' })

    const third = createHarness()
    const thirdSession = await connectTrusted(third)
    const thirdChannel = await openShellFor(third, thirdSession.result.session.sessionId)
    await third.service.closeShell(thirdSession.result.session.sessionId)
    expect(thirdChannel.closed).toBe(true)
    expect(third.terminalStatuses.at(-1)).toMatchObject({ status: 'closed' })
    expect(third.terminalExits.at(-1)).toMatchObject({ reason: 'local-close' })
  })

  it('opens a replacement shell after the previous shell exited', async () => {
    const harness = createHarness()
    const { result, client } = await connectTrusted(harness)
    const first = await openShellFor(harness, result.session.sessionId)
    first.emit('exit', 0, undefined)
    await vi.waitFor(() => expect(harness.terminalStatuses.at(-1)?.status).toBe('exited'))

    const second = await harness.service.openShell(result.session.sessionId, {
      cols: 80,
      rows: 24,
    })
    expect(second.reused).toBe(false)
    expect(client.shellRequests).toHaveLength(2)
    await vi.waitFor(() => expect(harness.terminalStatuses.at(-1)?.status).toBe('open'))
    expect(client.channels[1]?.windows[0]).toEqual([24, 80, 0, 0])
  })

  it('fails shell open, closes it on SSH disconnect and rejects later input', async () => {
    const harness = createHarness()
    const { result, client } = await connectTrusted(harness)
    client.shellError = new Error('no shell available')
    await expect(
      harness.service.openShell(result.session.sessionId, { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(harness.terminalStatuses.at(-1)).toMatchObject({
      status: 'error',
      failure: { code: 'shell-open-failed' },
    })
    expect(harness.terminalExits).toHaveLength(0)

    client.shellError = null
    const channel = await openShellFor(harness, result.session.sessionId)
    await harness.service.disconnect(result.session.sessionId)
    expect(channel.closed).toBe(true)
    expect(harness.terminalStatuses.at(-1)).toMatchObject({
      status: 'closed',
      failure: { code: 'ssh-disconnected' },
    })
    expect(harness.terminalExits.at(-1)).toMatchObject({ reason: 'ssh-closed' })
    await expect(
      harness.service.openShell(result.session.sessionId, { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('validates size, input and session state before touching a channel', async () => {
    const harness = createHarness()
    const { result } = await connectTrusted(harness)

    await expect(
      harness.service.openShell(result.session.sessionId, { cols: 0, rows: 24 }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      harness.service.openShell(result.session.sessionId, { cols: 80.5, rows: 24 }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      harness.service.openShell('../bad-session', { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(harness.service.writeShell(result.session.sessionId, 'x')).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(
      harness.service.resizeShell(result.session.sessionId, { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(harness.clients[0]?.shellRequests).toHaveLength(0)
    expect(harness.clients[0]?.channels).toHaveLength(0)
  })

  it('times out an unanswered shell request and closes a late channel', async () => {
    const harness = createHarness({ shellOpenTimeoutMs: 20 })
    const { result, client } = await connectTrusted(harness)
    client.deferShell = true

    await expect(
      harness.service.openShell(result.session.sessionId, { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(harness.terminalStatuses.at(-1)).toMatchObject({
      status: 'error',
      failure: { code: 'shell-open-failed' },
    })

    client.completeShell()
    expect(client.channels[0]?.closed).toBe(true)
    expect(harness.terminalStatuses.at(-1)?.status).toBe('error')
    expect(harness.terminalExits).toHaveLength(0)
  })

  it('keeps the SFTP session alive when only the interactive shell exits', async () => {
    const harness = createHarness()
    const { result } = await connectTrusted(harness)
    const channel = await openShellFor(harness, result.session.sessionId)

    channel.emit('exit', 0, undefined)
    await vi.waitFor(() => expect(harness.terminalStatuses.at(-1)?.status).toBe('exited'))
    expect(harness.terminated).toEqual([])
    expect(harness.service.getSftpClient(result.session.sessionId)).toBeTruthy()

    harness.service.dispose()
    expect(harness.terminated).toEqual([result.session.sessionId])
  })

  it('disposes open channels with the SSH service', async () => {
    const harness = createHarness()
    const { result } = await connectTrusted(harness)
    const channel = await openShellFor(harness, result.session.sessionId)

    harness.service.dispose()
    expect(channel.closed).toBe(true)
  })
})

describe('host key blob parsing', () => {
  it('computes the OpenSSH SHA256 fingerprint over the exact blob', () => {
    const blob = hostKeyBlob()
    const expected = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
    expect(parseHostKeyBlob(blob)).toEqual({
      algorithm: 'ssh-ed25519',
      fingerprint: `SHA256:${expected}`,
    })
  })

  it('keeps the raw ssh-rsa type for RSA host keys', () => {
    expect(parseHostKeyBlob(hostKeyBlob('ssh-rsa')).algorithm).toBe('ssh-rsa')
  })

  it('rejects unsupported algorithms and malformed blobs', () => {
    expectFailureCode(() => parseHostKeyBlob(hostKeyBlob('ssh-dss')), 'host-key-unsupported')
    expectFailureCode(
      () => parseHostKeyBlob(Buffer.from([0, 0, 0])),
      'host-key-verification-failed',
    )
  })
})

function expectFailureCode(operation: () => unknown, code: string): void {
  try {
    operation()
  } catch (error) {
    expect(error).toMatchObject({ failure: { code } })
    return
  }
  throw new Error(`expected operation to fail with ${code}`)
}

function hopConnection(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return connection({
    id: 'conn-bastion-1',
    name: 'bastion-1',
    host: '10.20.0.9',
    username: 'jump',
    ...overrides,
  })
}

async function completeChainClient(
  harness: ReturnType<typeof createHarness>,
  index: number,
): Promise<FakeClient> {
  const client = await harness.waitForClient(index)
  const verifier = harness.invokeVerifier(client)
  await vi.waitFor(() => expect(verifier).toHaveBeenCalledWith(true))
  client.ready()
  return client
}

describe('SshService jump chains', () => {
  it('keeps direct connections free of forwardOut traffic and hop state', async () => {
    const harness = createHarness()
    const { client } = await connectTrusted(harness)

    expect(client.forwards).toEqual([])
    expect(harness.statuses.every((session) => session.jumps.length === 0)).toBe(true)
    expect(harness.statuses.every((session) => session.activeHop === null)).toBe(true)
  })

  it('dials a single hop directly and reaches the target through forwardOut', async () => {
    const target = connection({ jumpConnectionIds: ['conn-bastion-1'] })
    const bastion = hopConnection()
    const harness = createHarness({ profiles: [target, bastion] })

    const promise = harness.service.connect(target.id, 'sshtab-test')
    const hopClient = await harness.waitForClient(0)

    expect(hopClient.config).toMatchObject({
      host: '10.20.0.9',
      port: 22,
      username: 'jump',
      password: SECRET,
    })
    expect(hopClient.config).not.toHaveProperty('sock')

    const activeStatus = harness.statuses.find(
      (session) =>
        session.status === 'authenticating' && session.activeHop?.connectionId === 'conn-bastion-1',
    )
    expect(activeStatus).toBeTruthy()

    const hopVerifier = harness.invokeVerifier(hopClient)
    await vi.waitFor(() => expect(hopVerifier).toHaveBeenCalledWith(true))
    // The hop key is verified against the hop endpoint and never becomes the
    // target's identity.
    expect(harness.verify).toHaveBeenCalledWith(
      expect.objectContaining({ host: '10.20.0.9', port: 22 }),
    )
    expect(harness.lastStatus()?.hostKey).toBeNull()

    hopClient.ready()

    const targetClient = await harness.waitForClient(1)
    expect(hopClient.forwards).toEqual([
      { srcIP: '127.0.0.1', srcPort: 0, dstIP: '10.20.4.11', dstPort: 22 },
    ])
    expect(targetClient.config).toMatchObject({
      host: '10.20.4.11',
      port: 22,
      username: 'deploy',
      password: SECRET,
    })
    expect(targetClient.config?.sock).toBe(hopClient.forwardChannels[0])

    const targetVerifier = harness.invokeVerifier(targetClient)
    await vi.waitFor(() => expect(targetVerifier).toHaveBeenCalledWith(true))
    targetClient.ready()

    const result = await promise
    expect(result.session.status).toBe('connected')
    expect(result.session.activeHop).toBeNull()
    expect(result.session.jumps).toEqual([
      {
        index: 1,
        connectionId: 'conn-bastion-1',
        name: 'bastion-1',
        host: '10.20.0.9',
        port: 22,
        username: 'jump',
        authMethod: 'password',
      },
    ])
    expect(result.session.hostKey).toMatchObject({ host: '10.20.4.11', port: 22 })
  })

  it('chains two hops, each dialed through the previous forward channel', async () => {
    const target = connection({ jumpConnectionIds: ['conn-hop-1', 'conn-hop-2'] })
    const hop1 = hopConnection({ id: 'conn-hop-1', name: 'hop-1', host: '10.20.0.10' })
    const hop2 = hopConnection({ id: 'conn-hop-2', name: 'hop-2', host: '10.20.0.11' })
    const harness = createHarness({ profiles: [target, hop1, hop2] })

    const promise = harness.service.connect(target.id, 'sshtab-test')
    const hop1Client = await harness.waitForClient(0)
    expect(hop1Client.config).not.toHaveProperty('sock')
    const hop1Verifier = harness.invokeVerifier(hop1Client)
    await vi.waitFor(() => expect(hop1Verifier).toHaveBeenCalledWith(true))
    hop1Client.ready()

    const hop2Client = await harness.waitForClient(1)
    expect(hop1Client.forwards).toEqual([
      { srcIP: '127.0.0.1', srcPort: 0, dstIP: '10.20.0.11', dstPort: 22 },
    ])
    expect(hop2Client.config?.sock).toBe(hop1Client.forwardChannels[0])
    const hop2Verifier = harness.invokeVerifier(hop2Client)
    await vi.waitFor(() => expect(hop2Verifier).toHaveBeenCalledWith(true))
    hop2Client.ready()

    const targetClient = await harness.waitForClient(2)
    expect(hop2Client.forwards).toEqual([
      { srcIP: '127.0.0.1', srcPort: 0, dstIP: '10.20.4.11', dstPort: 22 },
    ])
    expect(targetClient.config?.sock).toBe(hop2Client.forwardChannels[0])

    const targetVerifier = harness.invokeVerifier(targetClient)
    await vi.waitFor(() => expect(targetVerifier).toHaveBeenCalledWith(true))
    targetClient.ready()

    const result = await promise
    expect(result.session.status).toBe('connected')
    expect(result.session.jumps.map((hop) => [hop.index, hop.name])).toEqual([
      [1, 'hop-1'],
      [2, 'hop-2'],
    ])
    // Every endpoint is verified independently.
    expect(harness.verify.mock.calls.map((call) => call[0].host)).toEqual([
      '10.20.0.10',
      '10.20.0.11',
      '10.20.4.11',
    ])
  })

  it('challenges every endpoint separately: trusting a hop never trusts the target', async () => {
    const target = connection({ jumpConnectionIds: ['conn-bastion-1'] })
    const bastion = hopConnection()
    const harness = createHarness({ profiles: [target, bastion], verdict: 'unknown' })

    const promise = harness.service.connect(target.id, 'sshtab-test')
    const hopClient = await harness.waitForClient(0)
    const hopVerifier = harness.invokeVerifier(hopClient)
    const result = await promise

    expect(result.session.status).toBe('awaiting-host-key')
    expect(result.session.hostKey).toBeNull()
    expect(harness.challenges).toHaveLength(1)
    expect(harness.challenges[0]).toMatchObject({
      host: '10.20.0.9',
      port: 22,
      hop: { index: 1, connectionId: 'conn-bastion-1', name: 'bastion-1' },
    })
    expect(hopVerifier).not.toHaveBeenCalled()

    const sessionId = result.session.sessionId
    await harness.service.respondToHostKey(harness.lastChallenge.requestId, true)
    expect(hopVerifier).toHaveBeenCalledWith(true)
    expect(harness.trust).toHaveBeenCalledWith(expect.objectContaining({ host: '10.20.0.9' }))
    const afterHop = await harness.service.getStatus(sessionId)
    expect(afterHop.status).toBe('authenticating')
    expect(afterHop.hostKey).toBeNull()

    hopClient.ready()
    const targetClient = await harness.waitForClient(1)
    const targetVerifier = harness.invokeVerifier(targetClient)
    await vi.waitFor(() => expect(harness.challenges).toHaveLength(2))
    expect(harness.challenges[1]).toMatchObject({ host: '10.20.4.11', port: 22 })
    expect(harness.challenges[1]?.hop).toBeUndefined()

    await harness.service.respondToHostKey(harness.lastChallenge.requestId, true)
    expect(targetVerifier).toHaveBeenCalledWith(true)
    expect(harness.trust.mock.calls.map((call) => call[0]?.host)).toEqual([
      '10.20.0.9',
      '10.20.4.11',
    ])

    const connectedStatus = await harness.service.getStatus(sessionId)
    expect(connectedStatus.hostKey).toMatchObject({ host: '10.20.4.11' })

    targetClient.ready()
    await vi.waitFor(() => expect(harness.lastStatus()).toMatchObject({ status: 'connected' }))
  })

  it('attributes a hop credential failure to that hop and never dials the target', async () => {
    const target = connection({ jumpConnectionIds: ['conn-bastion-1'] })
    const bastion = hopConnection()
    const harness = createHarness({
      profiles: [target, bastion],
      resolveImpl: async (profile) => {
        if (profile.id === 'conn-bastion-1') {
          throw new SshFailureError('authentication-failed', 'password')
        }
        return { method: 'password', password: SECRET }
      },
    })

    const result = await harness.service.connect(target.id, 'sshtab-test')
    expect(result.session.status).toBe('error')
    expect(result.session.error).toMatchObject({
      code: 'authentication-failed',
      credentialKind: 'password',
      hop: { index: 1, connectionId: 'conn-bastion-1', name: 'bastion-1' },
    })
    expect(harness.clients).toHaveLength(0)
  })

  it('blocks the chain when the hop host key changed and never dials the target', async () => {
    const target = connection({ jumpConnectionIds: ['conn-bastion-1'] })
    const bastion = hopConnection()
    const harness = createHarness({
      profiles: [target, bastion],
      verifyImpl: async (presented) => (presented.host === '10.20.0.9' ? 'changed' : 'trusted'),
    })

    const promise = harness.service.connect(target.id, 'sshtab-test')
    const hopClient = await harness.waitForClient(0)
    const hopVerifier = harness.invokeVerifier(hopClient)
    const result = await promise

    expect(hopVerifier).toHaveBeenCalledWith(false)
    expect(result.session.status).toBe('error')
    expect(result.session.error).toMatchObject({
      code: 'host-key-changed',
      hop: { index: 1, connectionId: 'conn-bastion-1' },
    })
    expect(harness.clients).toHaveLength(1)
    expect(hopClient.destroyed).toBe(true)
  })

  it('attributes a forward failure while dialing the target to the target, then cleans up', async () => {
    const target = connection({ jumpConnectionIds: ['conn-bastion-1'] })
    const bastion = hopConnection()
    const harness = createHarness({ profiles: [target, bastion] })

    const promise = harness.service.connect(target.id, 'sshtab-test')
    const hopClient = await harness.waitForClient(0)
    hopClient.forwardError = new SshFailureError('connection-refused')
    const hopVerifier = harness.invokeVerifier(hopClient)
    await vi.waitFor(() => expect(hopVerifier).toHaveBeenCalledWith(true))
    hopClient.ready()

    const result = await promise
    expect(result.session.status).toBe('error')
    expect(result.session.error).toMatchObject({ code: 'connection-refused' })
    expect(result.session.error?.hop).toBeUndefined()
    expect(harness.clients).toHaveLength(1)
    expect(hopClient.destroyed).toBe(true)
  })

  it('attributes a forward failure while dialing a later hop to that hop', async () => {
    const target = connection({ jumpConnectionIds: ['conn-hop-1', 'conn-hop-2'] })
    const hop1 = hopConnection({ id: 'conn-hop-1', name: 'hop-1', host: '10.20.0.10' })
    const hop2 = hopConnection({ id: 'conn-hop-2', name: 'hop-2', host: '10.20.0.11' })
    const harness = createHarness({ profiles: [target, hop1, hop2] })

    const promise = harness.service.connect(target.id, 'sshtab-test')
    const hop1Client = await harness.waitForClient(0)
    hop1Client.forwardError = new SshFailureError('network-error')
    const hop1Verifier = harness.invokeVerifier(hop1Client)
    await vi.waitFor(() => expect(hop1Verifier).toHaveBeenCalledWith(true))
    hop1Client.ready()

    const result = await promise
    expect(result.session.status).toBe('error')
    expect(result.session.error).toMatchObject({
      code: 'network-error',
      hop: { index: 2, connectionId: 'conn-hop-2', name: 'hop-2' },
    })
    expect(harness.clients).toHaveLength(1)
    expect(hop1Client.destroyed).toBe(true)
  })

  it('fails with the hop context when a hop drops while the target is still connecting', async () => {
    const target = connection({ jumpConnectionIds: ['conn-bastion-1'] })
    const bastion = hopConnection()
    const harness = createHarness({ profiles: [target, bastion] })

    const promise = harness.service.connect(target.id, 'sshtab-test')
    const hopClient = await harness.waitForClient(0)
    const hopVerifier = harness.invokeVerifier(hopClient)
    await vi.waitFor(() => expect(hopVerifier).toHaveBeenCalledWith(true))
    hopClient.ready()

    const targetClient = await harness.waitForClient(1)
    hopClient.destroy()

    const result = await promise
    expect(result.session.status).toBe('error')
    expect(result.session.error).toMatchObject({
      code: 'network-error',
      hop: { index: 1, connectionId: 'conn-bastion-1' },
    })
    expect(targetClient.destroyed).toBe(true)
  })

  it('tears a chain down from the target backwards and leaves no orphan clients', async () => {
    const target = connection({ jumpConnectionIds: ['conn-bastion-1'] })
    const bastion = hopConnection()
    const harness = createHarness({ profiles: [target, bastion] })

    const promise = harness.service.connect(target.id, 'sshtab-test')
    const hopClient = await completeChainClient(harness, 0)
    const targetClient = await completeChainClient(harness, 1)
    const result = await promise
    expect(result.session.status).toBe('connected')

    const targetEnd = vi.spyOn(targetClient, 'end')
    const hopEnd = vi.spyOn(hopClient, 'end')

    await expect(harness.service.disconnect(result.session.sessionId)).resolves.toMatchObject({
      status: 'disconnected',
      error: null,
    })
    expect(targetEnd).toHaveBeenCalledTimes(1)
    expect(hopEnd).toHaveBeenCalledTimes(1)
    expect(targetEnd.mock.invocationCallOrder[0]).toBeLessThan(hopEnd.mock.invocationCallOrder[0])
    expect(harness.terminated).toEqual([result.session.sessionId])
    expect(hopClient.destroyed).toBe(false)
    expect(targetClient.destroyed).toBe(false)
  })

  it('keeps concurrent sessions for the same connection independent', async () => {
    const target = connection({ jumpConnectionIds: ['conn-bastion-1'] })
    const bastion = hopConnection()
    const harness = createHarness({ profiles: [target, bastion] })

    const first = harness.service.connect(target.id, 'sshtab-a')
    const firstHop = await completeChainClient(harness, 0)
    const firstTarget = await completeChainClient(harness, 1)
    const firstResult = await first

    const second = harness.service.connect(target.id, 'sshtab-b')
    const secondHop = await completeChainClient(harness, 2)
    const secondTarget = await completeChainClient(harness, 3)
    const secondResult = await second

    expect(harness.clients).toHaveLength(4)
    expect(firstResult.session.sessionId).not.toBe(secondResult.session.sessionId)

    await harness.service.disconnect(firstResult.session.sessionId)
    expect(firstHop.ended).toBe(true)
    expect(firstTarget.ended).toBe(true)
    expect(secondHop.ended).toBe(false)
    expect(secondTarget.ended).toBe(false)
    await expect(harness.service.getStatus(secondResult.session.sessionId)).resolves.toMatchObject({
      status: 'connected',
    })
  })
})

describe('SshService forwarding facade lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('only exposes forwarding for connected sessions and closes the facade once', async () => {
    const harness = createHarness()
    const connecting = harness.service.connect(harness.profiles[0]!.id, 'sshtab-test')
    const client = await harness.waitForClient()
    const sessionId = harness.statuses[0]!.sessionId

    expect(() => harness.service.acquireForwardingSession('ssh-missing')).toThrow(/找不到/)
    expect(() => harness.service.acquireForwardingSession(sessionId)).toThrow(/尚未连接完成/)

    const verifier = harness.invokeVerifier(client)
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledWith(true))
    client.ready()
    await connecting

    const forwarding = harness.service.acquireForwardingSession(sessionId)
    expect(forwarding.sessionId).toBe(sessionId)
    expect(harness.service.acquireForwardingSession(sessionId)).toBe(forwarding)

    const channel = await forwarding.forwardOut('127.0.0.1', 0, '10.20.4.50', 5432)
    expect(client.forwards).toEqual([
      { srcIP: '127.0.0.1', srcPort: 0, dstIP: '10.20.4.50', dstPort: 5432 },
    ])
    expect(channel).toBe(client.forwardChannels[0])

    const closed = vi.fn()
    forwarding.onClosed(closed)
    await harness.service.disconnect(sessionId)

    expect(forwarding.closed).toBe(true)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(() => harness.service.acquireForwardingSession(sessionId)).toThrow(/已断开/)
  })
})
