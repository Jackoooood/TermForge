// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import type { SshClientLike } from '../../src/main/services/ssh/SshService'
import { SftpService } from '../../src/main/services/sftp/SftpService'
import { AppOperationError } from '../../src/main/errors'
import { MAX_REMOTE_TEXT_FILE_BYTES } from '../../src/shared/sftp/remoteText'

const NOW = new Date('2026-10-22T08:00:00.000Z')
const SESSION_A = 'ssh-session-a'
const SESSION_B = 'ssh-session-b'

type Listener = (...args: unknown[]) => void
type ReaddirCallback = (error: unknown, entries?: FileEntryWithStats[]) => void
type LstatCallback = (error: unknown, stats?: Stats) => void
type DoneCallback = (error?: unknown) => void

class FakeSftp {
  readonly listeners = new Map<string, Listener[]>()
  readonly dirs = new Map<string, FileEntryWithStats[] | Error>()
  readonly statEntries = new Map<string, Stats | Error>()
  readonly readFiles = new Map<string, Buffer>()
  readonly calls = {
    readdir: [] as string[],
    lstat: [] as string[],
    realpath: [] as string[],
    mkdir: [] as string[],
    rename: [] as Array<[string, string]>,
    unlink: [] as string[],
    rmdir: [] as string[],
    readStreams: [] as string[],
    writeStreams: [] as Array<[string, unknown]>,
    writeFiles: [] as Array<[string, Buffer, unknown]>,
  }

  homePath = '/home/deploy'
  realpathError: unknown = null
  mkdirError: unknown = null
  renameError: unknown = null
  renameErrors: unknown[] = []
  unlinkError: unknown = null
  rmdirError: unknown = null
  writeFileError: unknown = null
  ended = 0
  destroyed = 0

  deferReaddir = false
  pendingReaddir: ReaddirCallback | null = null
  deferLstat = false
  pendingLstat: LstatCallback | null = null
  deferMkdir = false
  pendingMkdir: DoneCallback | null = null

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((item) => item !== listener),
    )
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  end(): void {
    this.ended += 1
    this.emit('close')
  }

  destroy(): void {
    this.destroyed += 1
    this.emit('close')
  }

  realpath(path: string, callback: (error: unknown, resolved?: string) => void): void {
    this.calls.realpath.push(path)
    queueMicrotask(() => {
      if (this.realpathError) callback(this.realpathError)
      else callback(null, this.homePath)
    })
  }

  readdir(path: string, callback: ReaddirCallback): void {
    this.calls.readdir.push(path)
    if (this.deferReaddir) {
      this.pendingReaddir = callback
      return
    }
    queueMicrotask(() => deliver(this.dirs.get(path), callback))
  }

  lstat(path: string, callback: LstatCallback): void {
    this.calls.lstat.push(path)
    if (this.deferLstat) {
      this.pendingLstat = callback
      return
    }
    queueMicrotask(() => deliver(this.statEntries.get(path), callback))
  }

  mkdir(path: string, callback: DoneCallback): void {
    this.calls.mkdir.push(path)
    if (this.deferMkdir) {
      this.pendingMkdir = callback
      return
    }
    queueMicrotask(() => callback(this.mkdirError))
  }

  rename(source: string, target: string, callback: DoneCallback): void {
    this.calls.rename.push([source, target])
    const scripted = this.renameErrors.length > 0 ? this.renameErrors.shift() : undefined
    queueMicrotask(() => callback(scripted !== undefined ? scripted : this.renameError))
  }

  createReadStream(path: string): PassThrough {
    this.calls.readStreams.push(path)
    const stream = new PassThrough()
    const data = this.readFiles.get(path)
    if (data) {
      queueMicrotask(() => {
        stream.write(data)
        stream.end()
      })
    }
    return stream
  }

  writeFile(path: string, data: Buffer, options: unknown, callback: DoneCallback): void {
    this.calls.writeFiles.push([path, data, options])
    queueMicrotask(() => callback(this.writeFileError))
  }

  createWriteStream(path: string, options?: unknown): PassThrough {
    this.calls.writeStreams.push([path, options])
    return new PassThrough()
  }

  unlink(path: string, callback: DoneCallback): void {
    this.calls.unlink.push(path)
    queueMicrotask(() => callback(this.unlinkError))
  }

  rmdir(path: string, callback: DoneCallback): void {
    this.calls.rmdir.push(path)
    queueMicrotask(() => callback(this.rmdirError))
  }

  completeReaddir(error: unknown = null, entries: FileEntryWithStats[] = []): void {
    const callback = this.pendingReaddir
    this.pendingReaddir = null
    this.deferReaddir = false
    if (!callback) throw new Error('no pending readdir')
    callback(error, entries)
  }

  completeLstat(error: unknown = null, stats?: Stats): void {
    const callback = this.pendingLstat
    this.pendingLstat = null
    this.deferLstat = false
    if (!callback) throw new Error('no pending lstat')
    callback(error, stats)
  }

  completeMkdir(error: unknown = null): void {
    const callback = this.pendingMkdir
    this.pendingMkdir = null
    this.deferMkdir = false
    if (!callback) throw new Error('no pending mkdir')
    callback(error)
  }
}

function deliver<T>(
  value: Error | T | undefined,
  callback: (error: unknown, result?: T) => void,
): void {
  if (value === undefined) callback({ code: 2 })
  else if (value instanceof Error) callback(value)
  else callback(null, value)
}

class FakeClient {
  readonly wrappers: FakeSftp[] = []
  sftpCalls = 0
  defer = false
  sftpError: Error | null = null
  homePath = '/home/deploy'
  pending: ((error: Error | undefined, sftp: SFTPWrapper) => void) | null = null

  sftp(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): unknown {
    this.sftpCalls += 1
    if (this.defer) {
      this.pending = callback
      return undefined
    }
    queueMicrotask(() => {
      if (this.sftpError) {
        callback(this.sftpError, undefined as unknown as SFTPWrapper)
        return
      }
      callback(undefined, this.newWrapper() as unknown as SFTPWrapper)
    })
    return undefined
  }

  complete(error: Error | null = null): FakeSftp | null {
    const callback = this.pending
    this.pending = null
    this.defer = false
    if (!callback) throw new Error('no pending sftp request')
    if (error) {
      callback(error, undefined as unknown as SFTPWrapper)
      return null
    }
    const wrapper = this.newWrapper()
    callback(undefined, wrapper as unknown as SFTPWrapper)
    return wrapper
  }

  private newWrapper(): FakeSftp {
    const wrapper = new FakeSftp()
    wrapper.homePath = this.homePath
    this.wrappers.push(wrapper)
    return wrapper
  }
}

function createHarness(options: { openTimeoutMs?: number; operationTimeoutMs?: number } = {}) {
  const clients = new Map<string, FakeClient>()
  const acquireClient = vi.fn((sessionId: string): SshClientLike => {
    const client = clients.get(sessionId)
    if (!client) {
      throw new AppOperationError('unavailable', 'SSH 连接不可用。')
    }
    return client as unknown as SshClientLike
  })
  const service = new SftpService({
    acquireClient,
    now: () => NOW,
    openTimeoutMs: options.openTimeoutMs ?? 1_000,
    operationTimeoutMs: options.operationTimeoutMs ?? 1_000,
  })
  return { service, clients, acquireClient }
}

function addClient(
  clients: Map<string, FakeClient>,
  sessionId: string,
  client = new FakeClient(),
): FakeClient {
  clients.set(sessionId, client)
  return client
}

function remoteStats(
  kind: 'directory' | 'file' | 'symlink',
  options: { size?: number; mtime?: number; mode?: number } = {},
): Stats {
  const type = kind === 'directory' ? 0o040000 : kind === 'symlink' ? 0o120000 : 0o100000
  const bits = options.mode ?? (kind === 'directory' ? 0o755 : kind === 'symlink' ? 0o777 : 0o644)
  return {
    mode: type | bits,
    size: options.size ?? 0,
    mtime: options.mtime ?? 1_700_000_000,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  } as unknown as Stats
}

function entry(
  name: string,
  kind: 'directory' | 'file' | 'symlink',
  options: { size?: number } = {},
): FileEntryWithStats {
  return {
    filename: name,
    longname: `${kind === 'directory' ? 'd' : kind === 'symlink' ? 'l' : '-'}rwxr-xr-x 1 deploy deploy 0 Oct 22 08:00 ${name}`,
    attrs: remoteStats(kind, options),
  } as unknown as FileEntryWithStats
}

describe('SftpService channel lifecycle', () => {
  it('opens one reusable channel per SSH session and resolves the home path once', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    client.homePath = '/srv/app/home/'
    const first = await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]
    if (!wrapper) throw new Error('missing wrapper')

    const second = await harness.service.open(SESSION_A)
    expect(first).toEqual({ sessionId: SESSION_A, homePath: '/srv/app/home' })
    expect(second).toEqual(first)
    expect(client.sftpCalls).toBe(1)
    expect(wrapper.calls.realpath).toEqual(['.'])

    await harness.service.open(SESSION_A)
    expect(client.sftpCalls).toBe(1)
  })

  it('shares a concurrent open instead of creating a second channel', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    client.defer = true

    const first = harness.service.open(SESSION_A)
    const second = harness.service.open(SESSION_A)
    await vi.waitFor(() => expect(client.pending).toBeTypeOf('function'))
    const wrapper = client.complete()
    if (!wrapper) throw new Error('missing wrapper')

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId: SESSION_A, homePath: '/home/deploy' },
      { sessionId: SESSION_A, homePath: '/home/deploy' },
    ])
    expect(client.sftpCalls).toBe(1)
    expect(wrapper.calls.realpath).toEqual(['.'])
  })

  it('validates session ownership on every operation, not only on first open', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    const wrapper = await harness.service.open(SESSION_A).then(() => client.wrappers[0]!)
    harness.clients.delete(SESSION_A)

    await expect(harness.service.list(SESSION_A, '/srv/app')).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(wrapper.calls.readdir).toHaveLength(0)
  })

  it('isolates directory data and channels between SSH sessions', async () => {
    const harness = createHarness()
    const clientA = addClient(harness.clients, SESSION_A)
    const clientB = addClient(harness.clients, SESSION_B)

    await harness.service.open(SESSION_A)
    await harness.service.open(SESSION_B)
    const wrapperA = clientA.wrappers[0]!
    const wrapperB = clientB.wrappers[0]!
    wrapperA.dirs.set('/srv/app', [entry('a.txt', 'file')])
    wrapperB.dirs.set('/srv/app', [entry('b.txt', 'file')])

    const listingA = await harness.service.list(SESSION_A, '/srv/app')
    const listingB = await harness.service.list(SESSION_B, '/srv/app')
    expect(listingA).toMatchObject({ sessionId: SESSION_A, path: '/srv/app' })
    expect(listingA.entries.map((item) => item.name)).toEqual(['a.txt'])
    expect(listingB).toMatchObject({ sessionId: SESSION_B, path: '/srv/app' })
    expect(listingB.entries.map((item) => item.name)).toEqual(['b.txt'])
    expect(clientA.sftpCalls).toBe(1)
    expect(clientB.sftpCalls).toBe(1)
  })

  it('times out a late SFTP channel open and destroys the late wrapper', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({ openTimeoutMs: 20 })
      const client = addClient(harness.clients, SESSION_A)
      client.defer = true

      const opening = harness.service.open(SESSION_A)
      const outcome = opening.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(25)
      await expect(outcome).resolves.toMatchObject({ code: 'timeout' })

      const wrapper = client.complete()
      expect(wrapper?.destroyed).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a channel and reopens a fresh one on the next request', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const first = client.wrappers[0]!

    await expect(harness.service.close(SESSION_A)).resolves.toEqual({
      sessionId: SESSION_A,
      closed: true,
    })
    expect(first.ended).toBe(1)

    await harness.service.open(SESSION_A)
    const second = client.wrappers[1]!
    second.dirs.set('/srv/app', [entry('after-close.txt', 'file')])
    const listing = await harness.service.list(SESSION_A, '/srv/app')
    expect(listing.entries.map((item) => item.name)).toEqual(['after-close.txt'])
    expect(client.sftpCalls).toBe(2)
    expect(second).not.toBe(first)
  })

  it('rejects pending reads and mutations differently when the channel closes', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!

    wrapper.deferReaddir = true
    const listing = harness.service.list(SESSION_A, '/srv/app')
    await vi.waitFor(() => expect(wrapper.calls.readdir).toHaveLength(1))
    wrapper.emit('close')
    await expect(listing).rejects.toMatchObject({ code: 'unavailable' })

    await harness.service.open(SESSION_A)
    const retryWrapper = client.wrappers[1]!
    retryWrapper.deferMkdir = true
    const mutation = harness.service.mkdir(SESSION_A, '/srv/app', 'new')
    await vi.waitFor(() => expect(retryWrapper.calls.mkdir).toHaveLength(1))
    retryWrapper.emit('close')
    await expect(mutation).rejects.toMatchObject({ code: 'outcome-unknown' })
  })

  it('disposes a session, ends its channel and rejects pending mutations as unknown', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    wrapper.deferMkdir = true

    const mutation = harness.service.mkdir(SESSION_A, '/srv/app', 'new')
    await vi.waitFor(() => expect(wrapper.calls.mkdir).toHaveLength(1))
    harness.service.disposeSession(SESSION_A)
    await expect(mutation).rejects.toMatchObject({ code: 'outcome-unknown' })
    expect(wrapper.ended).toBe(1)

    harness.clients.delete(SESSION_A)
    await expect(harness.service.list(SESSION_A, '/srv/app')).rejects.toMatchObject({
      code: 'unavailable',
    })
  })

  it('disposes the entire service and rejects later requests', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!

    harness.service.dispose()
    harness.service.dispose()
    expect(wrapper.ended).toBe(1)
    await expect(harness.service.list(SESSION_A, '/srv/app')).rejects.toMatchObject({
      code: 'internal',
    })
  })
})

describe('SftpService directory reads', () => {
  it('normalizes the path, maps metadata and distinguishes an empty directory', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!

    wrapper.dirs.set('/srv/app', [
      entry('notes.txt', 'file', { size: 12 }),
      entry('releases', 'directory'),
      entry('current', 'symlink'),
    ])
    const listing = await harness.service.list(SESSION_A, '/srv//app/./')
    expect(wrapper.calls.readdir).toEqual(['/srv/app'])
    expect(listing).toMatchObject({
      sessionId: SESSION_A,
      path: '/srv/app',
      loadedAt: NOW.toISOString(),
    })
    expect(listing.entries.map((item) => item.name)).toEqual(['releases', 'current', 'notes.txt'])
    expect(listing.entries[0]).toMatchObject({
      path: '/srv/app/releases',
      kind: 'directory',
      sizeBytes: null,
      permissions: 'drwxr-xr-x',
    })
    expect(listing.entries[2]).toMatchObject({
      kind: 'file',
      sizeBytes: 12,
      modifiedAt: '2023-11-14T22:13:20.000Z',
      permissions: '-rw-r--r--',
    })

    wrapper.dirs.set('/srv/empty', [])
    await expect(harness.service.list(SESSION_A, '/srv/empty')).resolves.toMatchObject({
      path: '/srv/empty',
      entries: [],
    })
  })

  it('maps SFTP status codes to readable directory errors', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!

    wrapper.dirs.set('/missing', Object.assign(new Error('missing'), { code: 2 }))
    wrapper.dirs.set('/denied', Object.assign(new Error('denied'), { code: 3 }))
    wrapper.dirs.set('/lost', Object.assign(new Error('lost'), { code: 6 }))
    wrapper.dirs.set('/not-dir', Object.assign(new Error('not-dir'), { code: 'ENOTDIR' }))
    wrapper.dirs.set('/unsupported', Object.assign(new Error('unsupported'), { code: 8 }))

    await expect(harness.service.list(SESSION_A, '/missing')).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(harness.service.list(SESSION_A, '/denied')).rejects.toMatchObject({
      code: 'permission-denied',
    })
    await expect(harness.service.list(SESSION_A, '/lost')).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(harness.service.list(SESSION_A, '/not-dir')).rejects.toMatchObject({
      code: 'not-a-directory',
    })
    await expect(harness.service.list(SESSION_A, '/unsupported')).rejects.toMatchObject({
      code: 'unsupported',
    })
  })

  it('times out reads and ignores a late callback without corrupting the channel', async () => {
    const harness = createHarness({ operationTimeoutMs: 20 })
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    wrapper.deferReaddir = true

    const listing = harness.service.list(SESSION_A, '/srv/app')
    const outcome = listing.catch((error: unknown) => error)
    await vi.waitFor(() => expect(wrapper.calls.readdir).toHaveLength(1))
    await expect(outcome).resolves.toMatchObject({ code: 'timeout' })

    wrapper.completeReaddir(null, [entry('late.txt', 'file')])
    wrapper.dirs.set('/srv/app', [entry('current.txt', 'file')])
    await expect(harness.service.list(SESSION_A, '/srv/app')).resolves.toMatchObject({
      entries: [expect.objectContaining({ name: 'current.txt' })],
    })
  })

  it('maps lstat metadata and missing paths', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    wrapper.statEntries.set('/srv/app/notes.txt', remoteStats('file', { size: 42 }))

    await expect(harness.service.stat(SESSION_A, '/srv//app/notes.txt')).resolves.toMatchObject({
      name: 'notes.txt',
      path: '/srv/app/notes.txt',
      kind: 'file',
      sizeBytes: 42,
      permissions: '-rw-r--r--',
    })
    await expect(harness.service.stat(SESSION_A, '/srv/app/missing')).rejects.toMatchObject({
      code: 'not-found',
    })
  })
})

describe('SftpService mutations', () => {
  it('creates a directory only when the target does not exist', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!

    await expect(harness.service.mkdir(SESSION_A, '/srv/app', 'release 2026')).resolves.toEqual({
      sessionId: SESSION_A,
      path: '/srv/app/release 2026',
      operation: 'mkdir',
    })
    expect(wrapper.calls.mkdir).toEqual(['/srv/app/release 2026'])

    wrapper.statEntries.set('/srv/app/release 2026', remoteStats('directory'))
    await expect(
      harness.service.mkdir(SESSION_A, '/srv/app', 'release 2026'),
    ).rejects.toMatchObject({ code: 'already-exists' })
    expect(wrapper.calls.mkdir).toHaveLength(1)
  })

  it('rejects a concurrent mutation on the same path instead of queueing it', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    wrapper.deferLstat = true

    const first = harness.service.mkdir(SESSION_A, '/srv/app', 'release')
    await vi.waitFor(() => expect(wrapper.calls.lstat).toHaveLength(1))
    await expect(harness.service.mkdir(SESSION_A, '/srv/app', 'release')).rejects.toMatchObject({
      code: 'conflict',
    })

    wrapper.completeLstat(Object.assign(new Error('missing'), { code: 2 }))
    await expect(first).resolves.toMatchObject({ path: '/srv/app/release' })
    expect(wrapper.calls.mkdir).toEqual(['/srv/app/release'])
  })

  it('renames without overwriting and maps conflicts and missing sources', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    wrapper.statEntries.set('/srv/app/old.txt', remoteStats('file'))
    wrapper.statEntries.set('/srv/app/taken.txt', remoteStats('file'))

    await expect(
      harness.service.rename(SESSION_A, '/srv/app/old.txt', '/srv/app/new.txt'),
    ).resolves.toEqual({
      sessionId: SESSION_A,
      path: '/srv/app/new.txt',
      operation: 'rename',
    })
    expect(wrapper.calls.rename).toEqual([['/srv/app/old.txt', '/srv/app/new.txt']])

    await expect(
      harness.service.rename(SESSION_A, '/srv/app/old.txt', '/srv/app/taken.txt'),
    ).rejects.toMatchObject({ code: 'already-exists' })
    await expect(
      harness.service.rename(SESSION_A, '/srv/app/missing.txt', '/srv/app/new.txt'),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(wrapper.calls.rename).toHaveLength(1)

    wrapper.renameError = Object.assign(new Error('cross-device'), { code: 4 })
    await expect(
      harness.service.rename(SESSION_A, '/srv/app/old.txt', '/srv/app/other.txt'),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects root rename targets and same-path renames before touching a channel', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!

    await expect(harness.service.rename(SESSION_A, '/srv/app/old.txt', '/')).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(
      harness.service.rename(SESSION_A, '/srv/app/old.txt', '/srv/app/old.txt'),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(wrapper.calls.rename).toHaveLength(0)
  })

  it('deletes files and symlinks but never a directory through unlink', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    wrapper.statEntries.set('/srv/app/notes.txt', remoteStats('file'))
    wrapper.statEntries.set('/srv/app/current', remoteStats('symlink'))
    wrapper.statEntries.set('/srv/app/logs', remoteStats('directory'))

    await expect(harness.service.deleteFile(SESSION_A, '/srv/app/notes.txt')).resolves.toEqual({
      sessionId: SESSION_A,
      path: '/srv/app/notes.txt',
      operation: 'delete-file',
    })
    await expect(harness.service.deleteFile(SESSION_A, '/srv/app/current')).resolves.toMatchObject({
      operation: 'delete-file',
    })
    expect(wrapper.calls.unlink).toEqual(['/srv/app/notes.txt', '/srv/app/current'])

    await expect(harness.service.deleteFile(SESSION_A, '/srv/app/logs')).rejects.toMatchObject({
      code: 'not-a-file',
    })
    await expect(harness.service.deleteFile(SESSION_A, '/srv/app/missing')).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(harness.service.deleteFile(SESSION_A, '/')).rejects.toMatchObject({
      code: 'invalid-input',
    })
    expect(wrapper.calls.unlink).toHaveLength(2)
  })

  it('refuses root, protected, shallow, non-directory and non-empty directory deletions', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!

    for (const path of ['/', '/etc', '/var', '/tmp', '/srv', '/single']) {
      await expect(harness.service.removeDirectory(SESSION_A, path), path).rejects.toMatchObject({
        code: 'invalid-input',
      })
    }
    expect(wrapper.calls.rmdir).toHaveLength(0)
    expect(wrapper.calls.readdir).toHaveLength(0)

    wrapper.statEntries.set('/srv/app/file.txt', remoteStats('file'))
    await expect(
      harness.service.removeDirectory(SESSION_A, '/srv/app/file.txt'),
    ).rejects.toMatchObject({ code: 'not-a-directory' })

    wrapper.statEntries.set('/srv/app/link', remoteStats('symlink'))
    await expect(harness.service.removeDirectory(SESSION_A, '/srv/app/link')).rejects.toMatchObject(
      { code: 'not-a-directory' },
    )

    wrapper.statEntries.set('/srv/app/nonempty', remoteStats('directory'))
    wrapper.dirs.set('/srv/app/nonempty', [entry('keep.txt', 'file')])
    await expect(
      harness.service.removeDirectory(SESSION_A, '/srv/app/nonempty'),
    ).rejects.toMatchObject({ code: 'not-empty' })
    expect(wrapper.calls.rmdir).toHaveLength(0)

    wrapper.statEntries.set('/srv/app/empty', remoteStats('directory'))
    wrapper.dirs.set('/srv/app/empty', [])
    await expect(harness.service.removeDirectory(SESSION_A, '/srv/app/empty')).resolves.toEqual({
      sessionId: SESSION_A,
      path: '/srv/app/empty',
      operation: 'remove-directory',
    })
    expect(wrapper.calls.rmdir).toEqual(['/srv/app/empty'])
  })

  it('reports a timed-out mutation as outcome-unknown and does not silently retry', async () => {
    const harness = createHarness({ operationTimeoutMs: 20 })
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    wrapper.deferMkdir = true

    const mutation = harness.service.mkdir(SESSION_A, '/srv/app', 'release')
    const outcome = mutation.catch((error: unknown) => error)
    await vi.waitFor(() => expect(wrapper.calls.mkdir).toHaveLength(1))
    await expect(outcome).resolves.toMatchObject({ code: 'outcome-unknown' })
    expect(wrapper.calls.mkdir).toHaveLength(1)

    wrapper.completeMkdir()
    await expect(harness.service.mkdir(SESSION_A, '/srv/app', 'release')).resolves.toMatchObject({
      path: '/srv/app/release',
    })
    expect(wrapper.calls.mkdir).toHaveLength(2)
  })
})

describe('SftpService remote text files', () => {
  async function openSession(): Promise<{
    harness: ReturnType<typeof createHarness>
    wrapper: FakeSftp
  }> {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]
    if (!wrapper) throw new Error('missing wrapper')
    return { harness, wrapper }
  }

  it('reads UTF-8 and BOM text with encoding, EOL and revision metadata', async () => {
    const { harness, wrapper } = await openSession()
    const plain = Buffer.from('alpha\r\nbeta\r\n', 'utf8')
    wrapper.statEntries.set(
      '/srv/app/notes.txt',
      remoteStats('file', { size: plain.length, mtime: 1_700_000_123 }),
    )
    wrapper.readFiles.set('/srv/app/notes.txt', plain)

    await expect(harness.service.readTextFile(SESSION_A, '/srv//app/./notes.txt')).resolves.toEqual(
      {
        sessionId: SESSION_A,
        path: '/srv/app/notes.txt',
        content: 'alpha\r\nbeta\r\n',
        encoding: 'utf-8',
        eol: 'crlf',
        revision: `1700000123:${plain.length}`,
        sizeBytes: plain.length,
        modifiedAt: new Date(1_700_000_123_000).toISOString(),
        permissions: '-rw-r--r--',
      },
    )

    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('echo "hi"\n')])
    wrapper.statEntries.set('/srv/app/run.sh', remoteStats('file', { size: bom.length }))
    wrapper.readFiles.set('/srv/app/run.sh', bom)
    await expect(harness.service.readTextFile(SESSION_A, '/srv/app/run.sh')).resolves.toMatchObject(
      {
        content: 'echo "hi"\n',
        encoding: 'utf-8-bom',
        eol: 'lf',
      },
    )
    expect(wrapper.calls.readStreams).toEqual(['/srv/app/notes.txt', '/srv/app/run.sh'])
  })

  it('rejects directories, symlinks, missing, binary, UTF-16 and oversized files', async () => {
    const { harness, wrapper } = await openSession()
    wrapper.statEntries.set('/srv/app/logs', remoteStats('directory'))
    wrapper.statEntries.set('/srv/app/current', remoteStats('symlink'))
    wrapper.statEntries.set('/srv/app/blob.bin', remoteStats('file', { size: 3 }))
    wrapper.readFiles.set('/srv/app/blob.bin', Buffer.from([0x61, 0x00, 0x62]))
    wrapper.statEntries.set('/srv/app/utf16.txt', remoteStats('file', { size: 4 }))
    wrapper.readFiles.set('/srv/app/utf16.txt', Buffer.from([0xff, 0xfe, 0x41, 0x00]))
    wrapper.statEntries.set(
      '/srv/app/huge.txt',
      remoteStats('file', { size: MAX_REMOTE_TEXT_FILE_BYTES + 1 }),
    )

    await expect(harness.service.readTextFile(SESSION_A, '/srv/app/logs')).rejects.toMatchObject({
      code: 'not-a-file',
    })
    await expect(harness.service.readTextFile(SESSION_A, '/srv/app/current')).rejects.toMatchObject(
      { code: 'not-a-file' },
    )
    await expect(
      harness.service.readTextFile(SESSION_A, '/srv/app/missing.txt'),
    ).rejects.toMatchObject({ code: 'not-found' })
    await expect(
      harness.service.readTextFile(SESSION_A, '/srv/app/blob.bin'),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message: '该文件包含二进制内容，未作为文本打开。',
    })
    await expect(
      harness.service.readTextFile(SESSION_A, '/srv/app/utf16.txt'),
    ).rejects.toMatchObject({ code: 'unsupported' })
    await expect(
      harness.service.readTextFile(SESSION_A, '/srv/app/huge.txt'),
    ).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect(wrapper.calls.readStreams).toEqual(['/srv/app/blob.bin', '/srv/app/utf16.txt'])
  })

  it('stops streaming when the response exceeds the byte cap despite a smaller stat', async () => {
    const { harness, wrapper } = await openSession()
    wrapper.statEntries.set('/srv/app/stream.txt', remoteStats('file', { size: 1 }))
    wrapper.readFiles.set('/srv/app/stream.txt', Buffer.alloc(MAX_REMOTE_TEXT_FILE_BYTES + 1, 0x61))

    await expect(
      harness.service.readTextFile(SESSION_A, '/srv/app/stream.txt'),
    ).rejects.toMatchObject({ code: 'limit-exceeded' })
  })

  it('writes through a temp file, backs up the target and cleans up', async () => {
    const { harness, wrapper } = await openSession()
    const path = '/srv/app/notes.txt'
    wrapper.statEntries.set(
      path,
      remoteStats('file', { size: 5, mtime: 1_700_000_000, mode: 0o640 }),
    )

    const result = await harness.service.writeTextFile({
      sessionId: SESSION_A,
      path: '/srv//app/./notes.txt',
      content: 'one\ntwo\n',
      encoding: 'utf-8',
      eol: 'crlf',
      expectedRevision: '1700000000:5',
      force: false,
    })

    expect(result).toEqual({
      sessionId: SESSION_A,
      path,
      revision: '1700000000:5',
      sizeBytes: 10,
      modifiedAt: '2023-11-14T22:13:20.000Z',
      backupCleanupFailed: false,
    })
    const [tempPath, data, options] = wrapper.calls.writeFiles[0]!
    expect(tempPath).toMatch(/^\/srv\/app\/\.termforge-part-/)
    expect(data.toString('utf8')).toBe('one\r\ntwo\r\n')
    expect(options).toEqual({ flag: 'wx', mode: 0o640 })
    const [aside, publish] = wrapper.calls.rename
    expect(aside![0]).toBe(path)
    expect(aside![1]).toMatch(/^\/srv\/app\/\.termforge-backup-/)
    expect(publish).toEqual([tempPath, path])
    expect(wrapper.calls.unlink).toEqual([aside![1]])
  })

  it('refuses stale revisions unless forced', async () => {
    const { harness, wrapper } = await openSession()
    const path = '/srv/app/notes.txt'
    wrapper.statEntries.set(path, remoteStats('file', { size: 5, mtime: 1_700_000_000 }))
    const input = {
      sessionId: SESSION_A,
      path,
      content: 'fresh',
      encoding: 'utf-8' as const,
      eol: 'lf' as const,
      expectedRevision: '1700000000:4',
      force: false,
    }

    await expect(harness.service.writeTextFile(input)).rejects.toMatchObject({ code: 'conflict' })
    expect(wrapper.calls.writeFiles).toHaveLength(0)
    expect(wrapper.calls.rename).toHaveLength(0)

    await expect(harness.service.writeTextFile({ ...input, force: true })).resolves.toMatchObject({
      path,
    })
    expect(wrapper.calls.writeFiles).toHaveLength(1)
  })

  it('rejects root, missing, non-file and oversized save targets before writing', async () => {
    const { harness, wrapper } = await openSession()
    const base = {
      sessionId: SESSION_A,
      content: 'x',
      encoding: 'utf-8' as const,
      eol: 'lf' as const,
      expectedRevision: null,
      force: false,
    }

    await expect(harness.service.writeTextFile({ ...base, path: '/' })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(
      harness.service.writeTextFile({ ...base, path: '/srv/app/missing.txt' }),
    ).rejects.toMatchObject({ code: 'not-found' })
    wrapper.statEntries.set('/srv/app/logs', remoteStats('directory'))
    wrapper.statEntries.set('/srv/app/current', remoteStats('symlink'))
    await expect(
      harness.service.writeTextFile({ ...base, path: '/srv/app/logs' }),
    ).rejects.toMatchObject({ code: 'not-a-file' })
    await expect(
      harness.service.writeTextFile({ ...base, path: '/srv/app/current' }),
    ).rejects.toMatchObject({ code: 'not-a-file' })
    await expect(
      harness.service.writeTextFile({
        ...base,
        path: '/srv/app/huge.txt',
        content: 'a'.repeat(MAX_REMOTE_TEXT_FILE_BYTES),
        encoding: 'utf-8-bom',
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect(wrapper.calls.writeFiles).toHaveLength(0)
    expect(wrapper.calls.rename).toHaveLength(0)
  })

  it('restores the previous file when publishing fails and removes the temp file', async () => {
    const { harness, wrapper } = await openSession()
    const path = '/srv/app/notes.txt'
    wrapper.statEntries.set(path, remoteStats('file', { size: 1 }))
    wrapper.renameErrors = [null, new Error('connection lost')]

    await expect(
      harness.service.writeTextFile({
        sessionId: SESSION_A,
        path,
        content: 'next',
        encoding: 'utf-8',
        eol: 'lf',
        expectedRevision: null,
        force: false,
      }),
    ).rejects.toMatchObject({ code: 'internal' })

    expect(wrapper.calls.rename).toHaveLength(3)
    const [aside, publish, restore] = wrapper.calls.rename
    expect(publish![0]).toMatch(/\.termforge-part-/)
    expect(publish![1]).toBe(path)
    expect(restore).toEqual([aside![1], path])
    expect(wrapper.calls.unlink).toEqual([publish![0]])
  })

  it('reports a failed backup cleanup without failing the save', async () => {
    const { harness, wrapper } = await openSession()
    const path = '/srv/app/notes.txt'
    wrapper.statEntries.set(path, remoteStats('file', { size: 1 }))
    wrapper.unlinkError = new Error('permission denied')

    await expect(
      harness.service.writeTextFile({
        sessionId: SESSION_A,
        path,
        content: 'next',
        encoding: 'utf-8',
        eol: 'lf',
        expectedRevision: null,
        force: false,
      }),
    ).resolves.toMatchObject({ path, backupCleanupFailed: true })
  })
})

describe('SftpService transfer port', () => {
  it('only opens write streams for transfer temp files', async () => {
    const harness = createHarness()
    addClient(harness.clients, SESSION_A)

    await expect(
      harness.service.openTransferWriteStream(SESSION_A, '/srv/app/.env'),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    const stream = await harness.service.openTransferWriteStream(
      SESSION_A,
      '/srv/app/.termforge-part-abc',
    )
    const wrapper = harness.clients.get(SESSION_A)!.wrappers[0]!
    expect(wrapper.calls.writeStreams).toEqual([
      ['/srv/app/.termforge-part-abc', { flags: 'wx', mode: 0o600 }],
    ])
    expect(wrapper.calls.readStreams).toEqual([])
    stream.destroy()
  })

  it('opens a validated read stream for downloads and rejects relative paths', async () => {
    const harness = createHarness()
    addClient(harness.clients, SESSION_A)

    await expect(
      harness.service.openTransferReadStream(SESSION_A, 'relative/path'),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    const stream = await harness.service.openTransferReadStream(SESSION_A, '/srv/app/data.bin')
    const wrapper = harness.clients.get(SESSION_A)!.wrappers[0]!
    expect(wrapper.calls.readStreams).toEqual(['/srv/app/data.bin'])
    expect(stream).toBeInstanceOf(PassThrough)
    stream.destroy()
  })

  it('commits an overwrite by moving the old target aside before publishing', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    const tempPath = '/srv/app/.termforge-part-abc'
    const targetPath = '/srv/app/index.html'

    await expect(
      harness.service.commitRemoteUpload(SESSION_A, tempPath, '/srv/other/index.html', true),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      harness.service.commitRemoteUpload(SESSION_A, '/srv/app/index.html', targetPath, true),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    await expect(
      harness.service.commitRemoteUpload(SESSION_A, tempPath, targetPath, true),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(wrapper.calls.rename).toHaveLength(0)

    wrapper.statEntries.set(tempPath, remoteStats('file', { size: 12 }))
    wrapper.statEntries.set(targetPath, remoteStats('file', { size: 4 }))

    await expect(
      harness.service.commitRemoteUpload(SESSION_A, tempPath, targetPath, false),
    ).rejects.toMatchObject({ code: 'already-exists' })
    expect(wrapper.calls.rename).toHaveLength(0)

    const result = await harness.service.commitRemoteUpload(SESSION_A, tempPath, targetPath, true)
    expect(result).toEqual({
      targetPath,
      replacedExisting: true,
      backupCleanupFailed: false,
    })
    expect(wrapper.calls.rename).toHaveLength(2)
    const [aside, publish] = wrapper.calls.rename
    expect(aside![0]).toBe(targetPath)
    expect(aside![1]).toMatch(/^\/srv\/app\/\.termforge-backup-/)
    expect(publish).toEqual([tempPath, targetPath])
    expect(wrapper.calls.unlink).toEqual([aside![1]])
  })

  it('restores the previous target when publishing the temp file fails', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    const tempPath = '/srv/app/.termforge-part-abc'
    const targetPath = '/srv/app/index.html'
    wrapper.statEntries.set(tempPath, remoteStats('file', { size: 12 }))
    wrapper.statEntries.set(targetPath, remoteStats('file', { size: 4 }))
    wrapper.renameErrors = [null, new Error('connection lost')]

    await expect(
      harness.service.commitRemoteUpload(SESSION_A, tempPath, targetPath, true),
    ).rejects.toMatchObject({ code: 'internal' })

    expect(wrapper.calls.rename).toHaveLength(3)
    const [aside, publish, restore] = wrapper.calls.rename
    expect(aside![0]).toBe(targetPath)
    expect(publish).toEqual([tempPath, targetPath])
    expect(restore).toEqual([aside![1], targetPath])
    expect(wrapper.calls.unlink).toHaveLength(0)
  })

  it('only removes existing transfer temp files and ignores missing ones', async () => {
    const harness = createHarness()
    const client = addClient(harness.clients, SESSION_A)
    await harness.service.open(SESSION_A)
    const wrapper = client.wrappers[0]!
    const tempPath = '/srv/app/.termforge-part-abc'

    await expect(
      harness.service.removeTransferFile(SESSION_A, '/srv/app/index.html'),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      harness.service.removeTransferFile(SESSION_A, '/srv/app/.termforge-part-missing'),
    ).resolves.toBeUndefined()
    expect(wrapper.calls.unlink).toHaveLength(0)

    wrapper.statEntries.set(tempPath, remoteStats('file', { size: 12 }))
    await expect(harness.service.removeTransferFile(SESSION_A, tempPath)).resolves.toBeUndefined()
    expect(wrapper.calls.unlink).toEqual([tempPath])
  })
})
