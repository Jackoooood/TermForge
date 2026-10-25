// @vitest-environment node

import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync, type Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppOperationError } from '../../src/main/errors'
import type { SftpTransferPort } from '../../src/main/services/sftp/SftpService'
import { TransferService } from '../../src/main/services/transfers/TransferService'
import { TRANSFER_JOURNAL_VERSION } from '../../src/shared/schemas/transferJournal'
import { TRANSFER_TEMP_PREFIX } from '../../src/shared/transfer/transferFiles'
import type { RemoteFileEntry, SftpMutationAck } from '../../src/shared/types/sftp'
import type { TransferTask } from '../../src/shared/types/transfer'

const SESSION = 'ssh-transfer-test'
const OTHER_SESSION = 'ssh-transfer-other'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ReadGate {
  stream: PassThrough
  tail: Buffer
}

/**
 * Test double for the main-process SFTP port. The remote tree is mapped onto a
 * real temporary directory so TransferService still exercises real file
 * streams; this is not a real SSH server integration test.
 */
class FakeSftpTransfer implements SftpTransferPort {
  readonly probed: string[] = []
  readonly readOpens: string[] = []
  readonly removed: string[] = []
  readonly mkdirs: string[] = []
  readonly commits: Array<{ tempPath: string; targetPath: string; overwrite: boolean }> = []
  readonly sizeOverrides = new Map<string, number | null>()
  readonly gates = new Map<string, ReadGate>()
  readonly writeGates = new Set<string>()
  gateReads = false
  gateWrites = false
  failProbe: Error | null = null
  commitError: Error | null = null

  constructor(private readonly root: string) {}

  async probe(sessionId: string): Promise<void> {
    this.probed.push(sessionId)
    if (this.failProbe) throw this.failProbe
  }

  async statRemote(_sessionId: string, path: string): Promise<RemoteFileEntry> {
    const localPath = this.toLocal(path)
    let stats: Stats
    try {
      stats = await fsp.lstat(localPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppOperationError('not-found', '远程路径不存在。')
      }
      throw error
    }
    const kind = stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file'
    const sizeBytes =
      kind === 'file'
        ? this.sizeOverrides.has(path)
          ? this.sizeOverrides.get(path)!
          : stats.size
        : null
    return {
      id: path,
      name: path.split('/').filter(Boolean).at(-1) ?? path,
      path,
      kind,
      sizeBytes,
      modifiedAt: stats.mtime.toISOString(),
      permissions: null,
    }
  }

  async openTransferReadStream(_sessionId: string, path: string): Promise<Readable> {
    this.readOpens.push(path)
    const content = await fsp.readFile(this.toLocal(path))
    if (!this.gateReads) {
      return createReadStream(this.toLocal(path))
    }
    const stream = new PassThrough()
    const split = Math.ceil(content.length / 2)
    stream.write(content.subarray(0, split))
    this.gates.set(path, { stream, tail: content.subarray(split) })
    return stream
  }

  async openTransferWriteStream(_sessionId: string, path: string): Promise<Writable> {
    if (this.gateWrites) {
      // Never consumed: the upload pipeline stalls after its high-water mark
      // so the test can cancel a genuinely in-flight upload.
      this.writeGates.add(path)
      return new PassThrough()
    }
    return createWriteStream(this.toLocal(path), { flags: 'wx', mode: 0o600 })
  }

  releaseRead(path: string): void {
    const gate = this.gates.get(path)
    if (!gate) throw new Error(`No gated read for ${path}`)
    this.gates.delete(path)
    gate.stream.end(gate.tail)
  }

  async commitRemoteUpload(
    _sessionId: string,
    tempPath: string,
    targetPath: string,
    overwrite: boolean,
  ): Promise<{ targetPath: string; replacedExisting: boolean; backupCleanupFailed: boolean }> {
    this.commits.push({ tempPath, targetPath, overwrite })
    if (this.commitError) throw this.commitError

    const temp = this.toLocal(tempPath)
    const target = this.toLocal(targetPath)
    let backup: string | null = null
    let replacedExisting = false
    try {
      const stats = await fsp.lstat(target)
      if (!stats.isFile()) throw new AppOperationError('not-a-file', '目标不是普通文件。')
      if (!overwrite) throw new AppOperationError('already-exists', '目标已存在。')
      backup = join(dirname(target), `.termforge-backup-test-${randomUUID()}`)
      await fsp.rename(target, backup)
      replacedExisting = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }

    try {
      await fsp.rename(temp, target)
    } catch (error) {
      if (backup) await fsp.rename(backup, target).catch(() => undefined)
      throw error
    }
    if (backup) await fsp.unlink(backup)
    return { targetPath, replacedExisting, backupCleanupFailed: false }
  }

  async removeTransferFile(_sessionId: string, path: string): Promise<void> {
    if (!basename(path).startsWith(TRANSFER_TEMP_PREFIX)) {
      throw new AppOperationError('invalid-input', '拒绝清理非传输临时文件。')
    }
    this.removed.push(path)
    await fsp.unlink(this.toLocal(path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  async mkdir(sessionId: string, parentPath: string, name: string): Promise<SftpMutationAck> {
    const targetPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`
    this.mkdirs.push(targetPath)
    const localPath = this.toLocal(targetPath)
    try {
      await fsp.lstat(localPath)
      throw new AppOperationError('already-exists', '同名文件或目录已存在，未创建目录。')
    } catch (error) {
      if (error instanceof AppOperationError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await fsp.mkdir(localPath)
    } catch (error) {
      // Concurrent tasks may create the directory between lstat and mkdir; the
      // real service serializes per path and reports already-exists.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AppOperationError('already-exists', '同名文件或目录已存在，未创建目录。')
      }
      throw error
    }
    return { sessionId, path: targetPath, operation: 'mkdir' }
  }

  private toLocal(remotePath: string): string {
    return join(this.root, ...remotePath.split('/').filter(Boolean))
  }
}

const bases: string[] = []

async function createHarness(
  options: {
    uploads?: string[]
    downloadDirectory?: string | null
    maxConcurrent?: number
    maxPerSession?: number
    maxExpandedUploadTasks?: number
    journalPath?: string
    onNotice?: (event: string, details: Record<string, unknown>) => void
  } = {},
): Promise<{
  remoteRoot: string
  localRoot: string
  port: FakeSftpTransfer
  service: TransferService
  updates: TransferTask[]
  pickUploadFiles: ReturnType<typeof vi.fn>
  pickDownloadDirectory: ReturnType<typeof vi.fn>
}> {
  const base = await fsp.mkdtemp(join(tmpdir(), 'termforge-transfer-'))
  bases.push(base)
  const remoteRoot = join(base, 'remote')
  const localRoot = join(base, 'local')
  await fsp.mkdir(join(remoteRoot, 'inbox'), { recursive: true })
  await fsp.mkdir(join(remoteRoot, 'src'), { recursive: true })
  await fsp.mkdir(localRoot, { recursive: true })

  const port = new FakeSftpTransfer(remoteRoot)
  const updates: TransferTask[] = []
  const pickUploadFiles = vi.fn(async () => options.uploads ?? [])
  const pickDownloadDirectory = vi.fn(async () =>
    options.downloadDirectory === undefined ? localRoot : options.downloadDirectory,
  )
  const service = new TransferService({
    sftp: port,
    emitUpdate: ({ task }) => updates.push(task),
    pickUploadFiles,
    pickDownloadDirectory,
    maxConcurrent: options.maxConcurrent ?? 2,
    maxPerSession: options.maxPerSession ?? 1,
    maxExpandedUploadTasks: options.maxExpandedUploadTasks,
    progressIntervalMs: 0,
    inactivityTimeoutMs: 3_000,
    closeTimeoutMs: 2_000,
    cleanupTimeoutMs: 1_000,
    abortSettleTimeoutMs: 50,
    journalPath: options.journalPath,
    onNotice: options.onNotice,
  })
  return { remoteRoot, localRoot, port, service, updates, pickUploadFiles, pickDownloadDirectory }
}

async function waitForTask(
  service: TransferService,
  taskId: string,
  predicate: (task: TransferTask) => boolean,
  timeoutMs = 8_000,
): Promise<TransferTask> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const task = service.list().find((item) => item.id === taskId)
    if (task && predicate(task)) return task
    await delay(10)
  }
  throw new Error(`Timed out waiting for ${taskId}: ${JSON.stringify(service.list())}`)
}

async function waitForCondition(
  check: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function tempNames(directory: string): Promise<string[]> {
  const names = await fsp.readdir(directory)
  return names.filter((name) => name.startsWith(TRANSFER_TEMP_PREFIX))
}

afterEach(async () => {
  for (const base of bases.splice(0)) {
    await fsp.rm(base, { recursive: true, force: true })
  }
})

describe('TransferService', () => {
  it('streams a real upload through a remote temp file and commits it atomically', async () => {
    const harness = await createHarness()
    const sourcePath = join(harness.localRoot, 'notes.txt')
    await fsp.writeFile(sourcePath, 'hello transfer')
    harness.pickUploadFiles.mockResolvedValue([sourcePath])

    const [created] = await harness.service.enqueueUpload(SESSION, '/inbox')
    expect(created).toMatchObject({
      status: 'queued',
      direction: 'upload',
      sourcePath,
      destinationPath: '/inbox/notes.txt',
    })

    const done = await waitForTask(
      harness.service,
      created!.id,
      (task) => task.status === 'completed',
    )
    expect(done).toMatchObject({
      status: 'completed',
      totalBytes: 14,
      transferredBytes: 14,
      progress: 100,
      speedBytesPerSecond: null,
      errorCode: null,
      errorMessage: null,
      attempt: 1,
    })
    expect(await fsp.readFile(join(harness.remoteRoot, 'inbox', 'notes.txt'), 'utf8')).toBe(
      'hello transfer',
    )
    expect(await fsp.readdir(join(harness.remoteRoot, 'inbox'))).toEqual(['notes.txt'])
    expect(harness.port.removed).toEqual([])

    const transferring = harness.updates.filter((task) => task.status === 'transferring')
    expect(transferring.length).toBeGreaterThan(0)
    expect(transferring.every((task) => task.progress !== null && task.progress < 100)).toBe(true)
  }, 10_000)

  it('emits byte-based progress and keeps unknown totals indeterminate', async () => {
    const harness = await createHarness()
    const sourcePath = join(harness.localRoot, 'large.bin')
    const payload = Buffer.alloc(512 * 1024, 7)
    await fsp.writeFile(sourcePath, payload)
    harness.pickUploadFiles.mockResolvedValue([sourcePath])

    let created = await harness.service.enqueueUpload(SESSION, '/inbox')
    await waitForTask(harness.service, created[0]!.id, (task) => task.status === 'completed')
    const progressUpdates = harness.updates.filter(
      (task) => task.id === created[0]!.id && task.status === 'transferring',
    )
    expect(progressUpdates.length).toBeGreaterThan(1)
    expect(
      progressUpdates.some(
        (task) => task.transferredBytes > 0 && task.progress !== null && task.progress < 100,
      ),
    ).toBe(true)

    const remoteSource = join(harness.remoteRoot, 'src', 'mystery.bin')
    await fsp.writeFile(remoteSource, 'unknown-size-content')
    harness.port.sizeOverrides.set('/src/mystery.bin', null)

    created = await harness.service.enqueueDownload(SESSION, ['/src/mystery.bin'])
    const taskId = created[0]!.id
    const done = await waitForTask(harness.service, taskId, (task) => task.status === 'completed')
    expect(done.totalBytes).toBeNull()
    expect(done.progress).toBeNull()
    expect(done.transferredBytes).toBe(20)
    expect(JSON.stringify(done)).not.toMatch(/NaN|Infinity/)
    expect(
      harness.updates
        .filter((task) => task.id === taskId && task.status === 'transferring')
        .every((task) => task.progress === null),
    ).toBe(true)
    expect(await fsp.readFile(join(harness.localRoot, 'mystery.bin'), 'utf8')).toBe(
      'unknown-size-content',
    )
  }, 10_000)

  it('rejects remote names that are unsafe as local file names before picking a directory', async () => {
    const harness = await createHarness()

    await expect(
      harness.service.enqueueDownload(SESSION, ['/src/..\\escape.txt']),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('远程文件名'),
    })
    expect(harness.pickDownloadDirectory).not.toHaveBeenCalled()
    expect(harness.service.list()).toEqual([])
  })

  it('rejects a second request while a picker dialog is already open', async () => {
    const harness = await createHarness()
    let release!: () => void
    harness.pickUploadFiles.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          release = () => resolve([])
        }),
    )

    const first = harness.service.enqueueUpload(SESSION, '/inbox')
    await waitForCondition(
      () => harness.pickUploadFiles.mock.calls.length === 1,
      'picker dialog open',
    )
    await expect(harness.service.enqueueUpload(SESSION, '/src')).rejects.toMatchObject({
      code: 'conflict',
    })
    release()
    await expect(first).resolves.toEqual([])
    expect(harness.pickUploadFiles).toHaveBeenCalledTimes(1)
    expect(harness.service.list()).toEqual([])
  })

  it('runs queued transfers in FIFO order under the global concurrency limit', async () => {
    const harness = await createHarness({ maxConcurrent: 1, maxPerSession: 1 })
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'a.bin'), 'AAAA')
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'b.bin'), 'BBBB')
    harness.port.gateReads = true

    const tasks = await harness.service.enqueueDownload(SESSION, ['/src/a.bin', '/src/b.bin'])
    const [first, second] = tasks

    await waitForTask(harness.service, first!.id, (task) => task.status === 'transferring')
    await waitForCondition(() => harness.port.gates.has('/src/a.bin'), 'first gated read')
    await delay(30)
    expect(harness.service.list().find((task) => task.id === second!.id)?.status).toBe('queued')
    expect(harness.port.readOpens).toEqual(['/src/a.bin'])

    harness.port.releaseRead('/src/a.bin')
    await waitForTask(harness.service, first!.id, (task) => task.status === 'completed')
    await waitForTask(harness.service, second!.id, (task) => task.status === 'transferring')
    await waitForCondition(() => harness.port.gates.has('/src/b.bin'), 'second gated read')
    expect(harness.port.readOpens).toEqual(['/src/a.bin', '/src/b.bin'])

    harness.port.releaseRead('/src/b.bin')
    await waitForTask(harness.service, second!.id, (task) => task.status === 'completed')
    expect(await fsp.readFile(join(harness.localRoot, 'a.bin'), 'utf8')).toBe('AAAA')
    expect(await fsp.readFile(join(harness.localRoot, 'b.bin'), 'utf8')).toBe('BBBB')
  }, 10_000)

  it('cancels queued and running downloads and removes the partial local file', async () => {
    const harness = await createHarness({ maxConcurrent: 1, maxPerSession: 1 })
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'a.bin'), 'AAAAAAAA')
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'b.bin'), 'BBBBBBBB')
    harness.port.gateReads = true

    const tasks = await harness.service.enqueueDownload(SESSION, ['/src/a.bin', '/src/b.bin'])
    const [first, second] = tasks
    await waitForTask(harness.service, first!.id, (task) => task.status === 'transferring')
    await waitForCondition(() => harness.port.gates.has('/src/a.bin'), 'gated download read')

    const queuedCancel = await harness.service.cancel(second!.id)
    expect(queuedCancel.status).toBe('cancelled')
    expect(harness.port.readOpens).toEqual(['/src/a.bin'])

    const runningCancel = await harness.service.cancel(first!.id)
    expect(runningCancel.status).toBe('cancelling')
    const cancelled = await waitForTask(
      harness.service,
      first!.id,
      (task) => task.status === 'cancelled',
    )
    expect(cancelled.errorCode).toBe('cancelled')
    expect(cancelled.transferredBytes).toBeLessThan(8)
    expect(await tempNames(harness.localRoot)).toEqual([])
    expect(await fsp.readdir(harness.localRoot)).toEqual([])
    expect(harness.port.removed).toEqual([])
  }, 10_000)

  it('cancels a running upload and removes the remote temp file', async () => {
    const harness = await createHarness()
    const sourcePath = join(harness.localRoot, 'large-upload.bin')
    await fsp.writeFile(sourcePath, Buffer.alloc(1024 * 1024, 3))
    harness.pickUploadFiles.mockResolvedValue([sourcePath])
    harness.port.gateWrites = true

    const [created] = await harness.service.enqueueUpload(SESSION, '/inbox')
    await waitForTask(harness.service, created!.id, (task) => task.status === 'transferring')
    await waitForCondition(() => harness.port.writeGates.size === 1, 'gated upload write')
    const tempPath = [...harness.port.writeGates][0]!

    const cancelling = await harness.service.cancel(created!.id)
    expect(cancelling.status).toBe('cancelling')
    const cancelled = await waitForTask(
      harness.service,
      created!.id,
      (task) => task.status === 'cancelled',
    )
    expect(cancelled.errorCode).toBe('cancelled')
    expect(harness.port.removed).toContain(tempPath)
    expect(await fsp.readdir(join(harness.remoteRoot, 'inbox'))).toEqual([])
  }, 10_000)

  it('reports upload conflicts and never overwrites without an explicit choice', async () => {
    const harness = await createHarness()
    const remoteTarget = join(harness.remoteRoot, 'inbox', 'notes.txt')
    await fsp.writeFile(remoteTarget, 'original')
    const sourcePath = join(harness.localRoot, 'notes.txt')
    await fsp.writeFile(sourcePath, 'new-content')
    harness.pickUploadFiles.mockResolvedValue([sourcePath])

    const first = (await harness.service.enqueueUpload(SESSION, '/inbox'))[0]!
    const waiting = await waitForTask(
      harness.service,
      first.id,
      (task) => task.status === 'waitingForConflictResolution',
    )
    expect(waiting.conflict).toEqual({
      targetPath: '/inbox/notes.txt',
      suggestedName: 'notes (1).txt',
      suggestedPath: '/inbox/notes (1).txt',
    })
    expect(await fsp.readFile(remoteTarget, 'utf8')).toBe('original')
    expect(await tempNames(join(harness.remoteRoot, 'inbox'))).toEqual([])

    const skipped = await harness.service.resolveConflict(first.id, 'skip')
    expect(skipped.status).toBe('skipped')
    expect(await fsp.readFile(remoteTarget, 'utf8')).toBe('original')

    const second = (await harness.service.enqueueUpload(SESSION, '/inbox'))[0]!
    await waitForTask(
      harness.service,
      second.id,
      (task) => task.status === 'waitingForConflictResolution',
    )
    await expect(
      (async () => harness.service.resolveConflict(second.id, 'rename', '../escape.txt'))(),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(harness.service.list().find((task) => task.id === second.id)?.status).toBe(
      'waitingForConflictResolution',
    )

    const overwritten = await harness.service.resolveConflict(second.id, 'overwrite')
    expect(overwritten.conflictPolicy).toBe('overwrite')
    await waitForTask(harness.service, second.id, (task) => task.status === 'completed')
    expect(await fsp.readFile(remoteTarget, 'utf8')).toBe('new-content')
    expect(await tempNames(join(harness.remoteRoot, 'inbox'))).toEqual([])

    await fsp.writeFile(sourcePath, 'third-content')
    const third = (await harness.service.enqueueUpload(SESSION, '/inbox'))[0]!
    await waitForTask(
      harness.service,
      third.id,
      (task) => task.status === 'waitingForConflictResolution',
    )
    await harness.service.resolveConflict(third.id, 'rename', 'notes-renamed.txt')
    await waitForTask(harness.service, third.id, (task) => task.status === 'completed')
    expect(await fsp.readFile(remoteTarget, 'utf8')).toBe('new-content')
    expect(await fsp.readFile(join(harness.remoteRoot, 'inbox', 'notes-renamed.txt'), 'utf8')).toBe(
      'third-content',
    )
    expect((await fsp.readdir(join(harness.remoteRoot, 'inbox'))).sort()).toEqual([
      'notes-renamed.txt',
      'notes.txt',
    ])
  }, 10_000)

  it('reports download conflicts and preserves pre-existing local files unless overwritten', async () => {
    const harness = await createHarness()
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'report.txt'), 'remote-v2')
    const localTarget = join(harness.localRoot, 'report.txt')
    await fsp.writeFile(localTarget, 'local-original')

    const first = (await harness.service.enqueueDownload(SESSION, ['/src/report.txt']))[0]!
    const waiting = await waitForTask(
      harness.service,
      first.id,
      (task) => task.status === 'waitingForConflictResolution',
    )
    expect(waiting.conflict).toMatchObject({
      targetPath: localTarget,
      suggestedName: 'report (1).txt',
    })
    expect(await fsp.readFile(localTarget, 'utf8')).toBe('local-original')
    expect(await tempNames(harness.localRoot)).toEqual([])

    await harness.service.resolveConflict(first.id, 'skip')
    expect(await fsp.readFile(localTarget, 'utf8')).toBe('local-original')

    const second = (await harness.service.enqueueDownload(SESSION, ['/src/report.txt']))[0]!
    await waitForTask(
      harness.service,
      second.id,
      (task) => task.status === 'waitingForConflictResolution',
    )
    await harness.service.resolveConflict(second.id, 'overwrite')
    await waitForTask(harness.service, second.id, (task) => task.status === 'completed')
    expect(await fsp.readFile(localTarget, 'utf8')).toBe('remote-v2')
    expect(await tempNames(harness.localRoot)).toEqual([])
    expect((await fsp.readdir(harness.localRoot)).sort()).toEqual(['report.txt'])

    await fsp.writeFile(localTarget, 'local-again')
    const third = (await harness.service.enqueueDownload(SESSION, ['/src/report.txt']))[0]!
    await waitForTask(
      harness.service,
      third.id,
      (task) => task.status === 'waitingForConflictResolution',
    )
    await harness.service.resolveConflict(third.id, 'rename', 'report-renamed.txt')
    await waitForTask(harness.service, third.id, (task) => task.status === 'completed')
    expect(await fsp.readFile(localTarget, 'utf8')).toBe('local-again')
    expect(await fsp.readFile(join(harness.localRoot, 'report-renamed.txt'), 'utf8')).toBe(
      'remote-v2',
    )
    expect(await tempNames(harness.localRoot)).toEqual([])
  }, 10_000)

  it('fails without committing, cleans the temp file, and retries with a new attempt', async () => {
    const harness = await createHarness()
    const sourcePath = join(harness.localRoot, 'retry.txt')
    await fsp.writeFile(sourcePath, 'retry-body')
    harness.pickUploadFiles.mockResolvedValue([sourcePath])
    harness.port.commitError = new AppOperationError('unavailable', 'SSH 连接暂不可用。')

    const created = (await harness.service.enqueueUpload(SESSION, '/inbox'))[0]!
    const failed = await waitForTask(
      harness.service,
      created.id,
      (task) => task.status === 'failed',
    )
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'connection-lost',
      attempt: 1,
    })
    expect(failed.completedAt).not.toBeNull()
    expect(await fsp.readdir(join(harness.remoteRoot, 'inbox'))).toEqual([])
    expect(harness.port.removed).toHaveLength(1)
    expect(basename(harness.port.removed[0]!)).toMatch(/^\.termforge-part-/)

    await delay(50)
    expect(harness.port.commits).toHaveLength(1)

    harness.port.failProbe = new AppOperationError('unavailable', 'SSH 会话已失效。')
    await expect(harness.service.retry(created.id)).rejects.toMatchObject({ code: 'unavailable' })
    expect(harness.service.list().find((task) => task.id === created.id)?.status).toBe('failed')

    harness.port.failProbe = null
    harness.port.commitError = null
    const retried = await harness.service.retry(created.id)
    expect(retried).toMatchObject({
      id: created.id,
      status: 'queued',
      attempt: 2,
      destinationPath: '/inbox/retry.txt',
      startedAt: null,
      completedAt: null,
      progress: null,
    })
    expect(retried.revision).toBeGreaterThan(failed.revision)

    const done = await waitForTask(
      harness.service,
      created.id,
      (task) => task.status === 'completed',
    )
    expect(done.attempt).toBe(2)
    expect(await fsp.readFile(join(harness.remoteRoot, 'inbox', 'retry.txt'), 'utf8')).toBe(
      'retry-body',
    )
    await expect(harness.service.retry(created.id)).rejects.toMatchObject({ code: 'conflict' })

    let cleared = 0
    for (let attempt = 0; attempt < 100 && cleared === 0; attempt += 1) {
      cleared = harness.service.clearHistory().cleared
      if (cleared === 0) await delay(10)
    }
    expect(cleared).toBe(1)
    expect(harness.service.list()).toEqual([])
  }, 10_000)

  it('transfers empty files in both directions', async () => {
    const harness = await createHarness()
    const emptyLocal = join(harness.localRoot, 'empty.txt')
    await fsp.writeFile(emptyLocal, Buffer.alloc(0))
    harness.pickUploadFiles.mockResolvedValue([emptyLocal])

    const [upload] = await harness.service.enqueueUpload(SESSION, '/inbox')
    const uploaded = await waitForTask(
      harness.service,
      upload!.id,
      (task) => task.status === 'completed',
    )
    expect(uploaded).toMatchObject({
      totalBytes: 0,
      transferredBytes: 0,
      progress: 100,
    })
    expect(await fsp.readFile(join(harness.remoteRoot, 'inbox', 'empty.txt'))).toEqual(
      Buffer.alloc(0),
    )

    await fsp.writeFile(join(harness.remoteRoot, 'src', 'empty-remote.bin'), Buffer.alloc(0))
    const [download] = await harness.service.enqueueDownload(SESSION, ['/src/empty-remote.bin'])
    const downloaded = await waitForTask(
      harness.service,
      download!.id,
      (task) => task.status === 'completed',
    )
    expect(downloaded).toMatchObject({
      totalBytes: 0,
      transferredBytes: 0,
      progress: 100,
    })
    expect(await fsp.readFile(join(harness.localRoot, 'empty-remote.bin'))).toEqual(Buffer.alloc(0))
  }, 10_000)

  it('keeps another session running when one session terminates', async () => {
    const harness = await createHarness({ maxConcurrent: 2, maxPerSession: 1 })
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'a.bin'), 'AAAAAAAA')
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'b.bin'), 'BBBBBBBB')
    harness.port.gateReads = true

    const [first] = await harness.service.enqueueDownload(SESSION, ['/src/a.bin'])
    const [second] = await harness.service.enqueueDownload(OTHER_SESSION, ['/src/b.bin'])
    await waitForCondition(
      () => harness.port.gates.has('/src/a.bin') && harness.port.gates.has('/src/b.bin'),
      'both gated reads',
    )

    harness.service.handleSessionTerminated(SESSION)
    harness.port.releaseRead('/src/b.bin')

    const failed = await waitForTask(harness.service, first!.id, (task) => task.status === 'failed')
    expect(failed).toMatchObject({ errorCode: 'connection-lost', sessionId: SESSION })
    const completed = await waitForTask(
      harness.service,
      second!.id,
      (task) => task.status === 'completed',
    )
    expect(completed.sessionId).toBe(OTHER_SESSION)
    expect(await fsp.readFile(join(harness.localRoot, 'b.bin'), 'utf8')).toBe('BBBBBBBB')
    expect(harness.port.readOpens).toEqual(['/src/a.bin', '/src/b.bin'])
  }, 10_000)

  it('fails every task for a terminated session and cleans partial files', async () => {
    const harness = await createHarness({ maxConcurrent: 1, maxPerSession: 1 })
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'a.bin'), 'AAAAAAAA')
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'b.bin'), 'BBBBBBBB')
    harness.port.gateReads = true

    const tasks = await harness.service.enqueueDownload(SESSION, ['/src/a.bin', '/src/b.bin'])
    await waitForTask(harness.service, tasks[0]!.id, (task) => task.status === 'transferring')
    await waitForCondition(() => harness.port.gates.has('/src/a.bin'), 'gated download read')

    harness.service.handleSessionTerminated(SESSION)

    const first = await waitForTask(
      harness.service,
      tasks[0]!.id,
      (task) => task.status === 'failed',
    )
    const second = await waitForTask(
      harness.service,
      tasks[1]!.id,
      (task) => task.status === 'failed',
    )
    expect(first.errorCode).toBe('connection-lost')
    expect(second.errorCode).toBe('connection-lost')
    expect(await fsp.readdir(harness.localRoot)).toEqual([])
    expect(harness.port.readOpens).toEqual(['/src/a.bin'])
    expect(harness.service.list().every((task) => task.status === 'failed')).toBe(true)

    harness.service.handleSessionTerminated(OTHER_SESSION)
    expect(harness.service.list()).toHaveLength(2)
  }, 10_000)

  it('hydrates unfinished journal entries as interrupted without auto-resuming them', async () => {
    const base = await fsp.mkdtemp(join(tmpdir(), 'termforge-journal-'))
    bases.push(base)
    const journalPath = join(base, 'transfer-journal.json')
    await fsp.writeFile(
      journalPath,
      JSON.stringify({
        version: TRANSFER_JOURNAL_VERSION,
        tasks: [
          {
            id: 'transfer-previous-upload',
            sessionId: SESSION,
            direction: 'upload',
            fileName: 'notes.txt',
            sourcePath: join(base, 'notes.txt'),
            destinationPath: '/inbox/notes.txt',
            status: 'transferring',
            totalBytes: 100,
            transferredBytes: 40,
            progress: 40,
            createdAt: '2026-10-22T08:00:00.000Z',
            attempt: 2,
            revision: 7,
          },
        ],
      }),
      'utf8',
    )
    const onNotice = vi.fn()
    const harness = await createHarness({ journalPath, onNotice })
    await harness.service.initialize()

    const [task] = harness.service.list()
    expect(task).toMatchObject({
      id: 'transfer-previous-upload',
      status: 'interrupted',
      errorCode: 'outcome-unknown',
      transferredBytes: 40,
      attempt: 2,
      revision: 8,
    })
    expect(task?.errorMessage).toContain('没有自动继续')
    expect(onNotice).toHaveBeenCalledWith('journal-recovered', { count: 1 })

    await expect(harness.service.retry('transfer-previous-upload')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('服务器上的结果未知'),
    })
    await harness.service.dispose()
  })

  it('writes active tasks to the journal and ignores an unreadable journal on startup', async () => {
    const base = await fsp.mkdtemp(join(tmpdir(), 'termforge-journal-'))
    bases.push(base)
    const journalPath = join(base, 'transfer-journal.json')
    await fsp.writeFile(journalPath, '{not-json', 'utf8')

    const harness = await createHarness({ journalPath })
    await harness.service.initialize()
    expect(harness.service.list()).toEqual([])

    await fsp.writeFile(join(harness.remoteRoot, 'src', 'active.bin'), 'ABCDEFGH')
    harness.port.gateReads = true
    const created = (await harness.service.enqueueDownload(SESSION, ['/src/active.bin']))[0]!
    await waitForTask(harness.service, created.id, (task) => task.status === 'transferring')
    await waitForCondition(() => harness.port.gates.has('/src/active.bin'), 'gated download read')

    await waitForCondition(
      () => {
        try {
          return readFileSync(journalPath, 'utf8').includes(created.id)
        } catch {
          return false
        }
      },
      'journal write',
      3_000,
    )

    const persisted = JSON.parse(await fsp.readFile(journalPath, 'utf8')) as {
      version: number
      tasks: Array<{ id: string; status: string }>
    }
    expect(persisted.version).toBe(TRANSFER_JOURNAL_VERSION)
    expect(persisted.tasks.find((task) => task.id === created.id)?.status).toBe('transferring')

    await harness.service.dispose()
  })

  it('stops running transfers during shutdown and refuses new work afterwards', async () => {
    const harness = await createHarness()
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'a.bin'), 'AAAAAAAA')
    harness.port.gateReads = true

    const created = (await harness.service.enqueueDownload(SESSION, ['/src/a.bin']))[0]!
    await waitForTask(harness.service, created.id, (task) => task.status === 'transferring')
    await waitForCondition(() => harness.port.gates.has('/src/a.bin'), 'gated download read')

    harness.service.dispose()

    const cancelled = await waitForTask(
      harness.service,
      created.id,
      (task) => task.status === 'cancelled',
    )
    expect(cancelled.errorCode).toBe('cancelled')
    expect(cancelled.errorMessage).toContain('应用正在退出')
    expect(await fsp.readdir(harness.localRoot)).toEqual([])
    await expect(harness.service.enqueueDownload(SESSION, ['/src/a.bin'])).rejects.toMatchObject({
      code: 'unavailable',
    })
  }, 10_000)

  it('expands a dropped directory into per-file uploads that keep its name and layout', async () => {
    const harness = await createHarness()
    const topFile = join(harness.localRoot, 'top.txt')
    await fsp.writeFile(topFile, 'top')
    const bundle = join(harness.localRoot, 'bundle')
    await fsp.mkdir(join(bundle, 'sub', 'deep'), { recursive: true })
    await fsp.writeFile(join(bundle, 'a.txt'), 'A')
    await fsp.writeFile(join(bundle, 'sub', 'b.txt'), 'B')
    await fsp.writeFile(join(bundle, 'sub', 'deep', 'c.txt'), 'C')

    const ack = await harness.service.enqueueUploadPaths(SESSION, '/inbox', [topFile, bundle])
    expect(ack).toMatchObject({
      skippedSymlinks: 0,
      skippedUnsupported: 0,
      truncated: false,
      remoteDirectory: '/inbox',
    })
    expect(ack.tasks.map((task) => task.destinationPath).sort()).toEqual([
      '/inbox/bundle/a.txt',
      '/inbox/bundle/sub/b.txt',
      '/inbox/bundle/sub/deep/c.txt',
      '/inbox/top.txt',
    ])
    expect(ack.tasks.find((task) => task.fileName === 'c.txt')?.sourcePath).toBe(
      join(bundle, 'sub', 'deep', 'c.txt'),
    )

    for (const task of ack.tasks) {
      await waitForTask(harness.service, task.id, (candidate) => candidate.status === 'completed')
    }
    expect(await fsp.readFile(join(harness.remoteRoot, 'inbox', 'top.txt'), 'utf8')).toBe('top')
    expect(
      await fsp.readFile(join(harness.remoteRoot, 'inbox', 'bundle', 'sub', 'deep', 'c.txt'), 'utf8'),
    ).toBe('C')
    expect(harness.port.mkdirs).toEqual(
      expect.arrayContaining(['/inbox/bundle', '/inbox/bundle/sub', '/inbox/bundle/sub/deep']),
    )
    expect(await tempNames(join(harness.remoteRoot, 'inbox', 'bundle'))).toEqual([])
  }, 15_000)

  it('skips symbolic links during expansion and refuses missing sources or targets', async () => {
    const harness = await createHarness()
    const realDir = join(harness.localRoot, 'real')
    await fsp.mkdir(realDir)
    await fsp.writeFile(join(realDir, 'kept.txt'), 'kept')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await fsp.symlink(realDir, join(harness.localRoot, 'link-dir'), linkType)
    await fsp.symlink(realDir, join(realDir, 'loop-dir'), linkType)

    const ack = await harness.service.enqueueUploadPaths(SESSION, '/inbox', [
      join(harness.localRoot, 'link-dir'),
      join(realDir, 'kept.txt'),
    ])
    expect(ack.skippedSymlinks).toBe(1)
    expect(ack.tasks.map((task) => task.destinationPath)).toEqual(['/inbox/kept.txt'])

    const dropped = await harness.service.enqueueUploadPaths(SESSION, '/inbox', [realDir])
    expect(dropped.skippedSymlinks).toBe(1)
    expect(dropped.tasks.map((task) => task.destinationPath)).toEqual(['/inbox/real/kept.txt'])
    for (const task of [...ack.tasks, ...dropped.tasks]) {
      await waitForTask(harness.service, task.id, (candidate) => candidate.status === 'completed')
    }

    await expect(
      harness.service.enqueueUploadPaths(SESSION, '/inbox', [join(harness.localRoot, 'missing.txt')]),
    ).rejects.toMatchObject({ code: 'not-found' })
    await expect(
      harness.service.enqueueUploadPaths(SESSION, '/inbox', ['relative\\path']),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(harness.service.enqueueUploadPaths(SESSION, '/inbox', [])).rejects.toMatchObject({
      code: 'invalid-input',
    })
    // Both separators go through normalization, so `..\` cannot smuggle an
    // escape past the source check; the collapsed path is simply missing.
    await expect(
      harness.service.enqueueUploadPaths(SESSION, '/inbox', ['/src/..\\escape.txt']),
    ).rejects.toMatchObject({ code: 'not-found' })
    await expect(
      harness.service.enqueueUploadPaths(SESSION, '/inbox/missing-dir', [join(realDir, 'kept.txt')]),
    ).rejects.toMatchObject({ code: 'unavailable' })
  }, 10_000)

  it('stops directory expansion at the configured cap and reports truncation', async () => {
    const harness = await createHarness({ maxExpandedUploadTasks: 3 })
    const folder = join(harness.localRoot, 'many')
    await fsp.mkdir(folder)
    for (const index of [1, 2, 3, 4, 5]) {
      await fsp.writeFile(join(folder, `f-${index}.txt`), 'x')
    }

    const ack = await harness.service.enqueueUploadPaths(SESSION, '/inbox', [folder])
    expect(ack.truncated).toBe(true)
    expect(ack.tasks.map((task) => task.destinationPath)).toEqual([
      '/inbox/many/f-1.txt',
      '/inbox/many/f-2.txt',
      '/inbox/many/f-3.txt',
    ])
    for (const task of ack.tasks) {
      await waitForTask(harness.service, task.id, (candidate) => candidate.status === 'completed')
    }
  }, 10_000)

  it('downloads explicit paths into the chosen directory and rejects unsafe targets', async () => {
    const harness = await createHarness()
    const targetDir = join(harness.localRoot, 'downloads')
    await fsp.mkdir(targetDir)
    await fsp.writeFile(join(harness.remoteRoot, 'src', 'report.txt'), 'report-body')

    const created = await harness.service.enqueueDownloadPaths(
      SESSION,
      ['/src/report.txt', '/src/report.txt'],
      targetDir,
    )
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      direction: 'download',
      sourcePath: '/src/report.txt',
      destinationPath: join(targetDir, 'report.txt'),
    })
    await waitForTask(harness.service, created[0]!.id, (task) => task.status === 'completed')
    expect(await fsp.readFile(join(targetDir, 'report.txt'), 'utf8')).toBe('report-body')

    await expect(
      harness.service.enqueueDownloadPaths(SESSION, ['/'], targetDir),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      harness.service.enqueueDownloadPaths(SESSION, ['/src/..\\escape.txt'], targetDir),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      harness.service.enqueueDownloadPaths(SESSION, [], targetDir),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      harness.service.enqueueDownloadPaths(SESSION, ['relative\\remote'], targetDir),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    const diskRoot = process.platform === 'win32' ? 'C:\\' : '/'
    await expect(
      harness.service.enqueueDownloadPaths(SESSION, ['/src/report.txt'], diskRoot),
    ).rejects.toMatchObject({ code: 'invalid-input', message: expect.stringContaining('磁盘根目录') })
    await expect(
      harness.service.enqueueDownloadPaths(SESSION, ['/src/report.txt'], join(harness.localRoot, 'missing')),
    ).rejects.toMatchObject({ code: 'unavailable' })
  }, 10_000)
})
