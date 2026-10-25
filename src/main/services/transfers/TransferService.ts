import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Transform, type Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Dirent, Stats } from 'node:fs'
import { AppOperationError } from '../../errors'
import {
  joinRemotePath,
  normalizeRemotePath,
  remoteParentPath,
  remotePathName,
  getRemoteEntryNameError,
  MAX_NAME_LENGTH,
} from '../../../shared/sftp/remotePath'
import {
  getLocalFileNameError,
  MAX_LOCAL_NAME_LENGTH,
} from '../../../shared/transfer/localFileName'
import {
  isTransferTempName,
  TRANSFER_BACKUP_PREFIX,
  TRANSFER_TEMP_PREFIX,
} from '../../../shared/transfer/transferFiles'
import { MAX_TRANSFER_BATCH } from '../../../shared/types/transfer'
import {
  MAX_JOURNAL_TASKS,
  transferJournalSchema,
  TRANSFER_JOURNAL_VERSION,
  type TransferJournalRecord,
} from '../../../shared/schemas/transferJournal'
import type { RemoteFileEntry } from '../../../shared/types/sftp'
import type {
  TransferClearAck,
  TransferConflictInfo,
  TransferConflictPolicy,
  TransferTask,
  TransferUpdateEvent,
  TransferUploadEnqueueAck,
} from '../../../shared/types/transfer'
import { isActiveTransferStatus, isTerminalTransferStatus } from '../../../shared/types/transfer'
import {
  appendLocalName,
  isLocalPathAtRoot,
  localPathName,
  normalizeLocalPath,
} from '../../../shared/localFs/localPath'
import {
  transferEnqueueDownloadPathsInputSchema,
  transferEnqueueUploadPathsInputSchema,
} from '../../../shared/schemas/transfer'
import type { SftpTransferPort } from '../sftp/SftpService'
import { readJsonFile, writeJsonFileAtomic } from '../../storage/jsonFile'
import { TransferQueue } from './TransferQueue'
import {
  mapTransferFailure,
  TransferAbortError,
  TransferTaskError,
  type TransferAbortReason,
  type TransferFailure,
  type TransferStage,
} from './transfer-errors'

export interface TransferServiceDependencies {
  sftp: SftpTransferPort
  emitUpdate: (event: TransferUpdateEvent) => void
  /** Opens a native multi-file picker; returns absolute local file paths. */
  pickUploadFiles: () => Promise<string[]>
  /** Opens a native directory picker; returns an absolute local path. */
  pickDownloadDirectory: () => Promise<string | null>
  now?: () => Date
  createId?: () => string
  maxConcurrent?: number
  maxPerSession?: number
  /** Cap for files expanded out of dragged directories. */
  maxExpandedUploadTasks?: number
  /** Traversal depth cap for local directory expansion. */
  maxUploadDirectoryDepth?: number
  progressIntervalMs?: number
  inactivityTimeoutMs?: number
  closeTimeoutMs?: number
  cleanupTimeoutMs?: number
  abortSettleTimeoutMs?: number
  /** Optional journal used to surface unfinished tasks truthfully after restart. */
  journalPath?: string
  onNotice?: (event: string, details: Record<string, unknown>) => void
}

export interface TransferConcurrencyLimits {
  maxConcurrent: number
  maxPerSession: number
}

export interface TransferServicePort {
  enqueueUpload(sessionId: string, remoteDirectory: string): Promise<TransferTask[]>
  /** Explicit-path upload used by drag & drop and the local file panel. */
  enqueueUploadPaths(
    sessionId: string,
    remoteDirectory: string,
    localPaths: string[],
  ): Promise<TransferUploadEnqueueAck>
  enqueueDownload(sessionId: string, remotePaths: string[]): Promise<TransferTask[]>
  /** Downloads into an explicit local directory chosen by the caller (a panel), not a dialog. */
  enqueueDownloadPaths(
    sessionId: string,
    remotePaths: string[],
    localDirectory: string,
  ): Promise<TransferTask[]>
  cancel(transferId: string): Promise<TransferTask>
  retry(transferId: string): Promise<TransferTask>
  resolveConflict(
    transferId: string,
    choice: TransferConflictPolicy,
    newName?: string,
  ): Promise<TransferTask>
  list(): TransferTask[]
  clearHistory(): TransferClearAck
  handleSessionTerminated(sessionId: string): void
  cancelAll(reason?: TransferAbortReason): void
  initialize(): Promise<void>
  setConcurrencyLimits(limits: TransferConcurrencyLimits): void
  dispose(): Promise<void>
}

interface SourceMetadata {
  size: number
  mtimeMs: number
}

/** One uploadable file produced by expanding dragged local sources. */
interface ExpandedUploadSource {
  localPath: string
  fileName: string
  /** Directory (POSIX-separated, relative to the drop root); '' for top level. */
  relativeDirectory: string
}

interface ProgressSample {
  at: number
  bytes: number
}

interface TaskRuntime {
  task: TransferTask
  localSourcePath: string | null
  localDirectory: string | null
  remoteDirectory: string | null
  sourceMetadata: SourceMetadata | null
  sourceStream: Readable | null
  destinationStream: Writable | null
  remoteTempCreated: boolean
  localTempCreated: boolean
  tempPath: string | null
  bytesTransferred: number
  samples: ProgressSample[]
  lastEmitAt: number
  watchdog: NodeJS.Timeout | null
  settleTimer: NodeJS.Timeout | null
  activeSlot: boolean
  cancelRequested: boolean
  commitStarted: boolean
  abortCause: Error | null
  stage: TransferStage
  finalized: boolean
  cleanupStarted: boolean
  cleanupNote: string | null
  completionWarning: string | null
}

const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_MAX_PER_SESSION = 1
const DEFAULT_PROGRESS_INTERVAL_MS = 200
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000
const DEFAULT_ABORT_SETTLE_TIMEOUT_MS = 8_000
const DEFAULT_MAX_EXPANDED_UPLOAD_TASKS = 500
const DEFAULT_MAX_UPLOAD_DIRECTORY_DEPTH = 64
const MAX_REMOTE_ENSURE_DEPTH = 64
const SPEED_WINDOW_MS = 3_000
const MAX_SUGGESTION_ATTEMPTS = 20

function toLocalErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AppOperationError('timeout', message)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function trackClose(stream: Readable | Writable): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      stream.off('close', finish)
      stream.off('error', finish)
      resolve()
    }
    if (stream.closed) {
      resolve()
      return
    }
    stream.once('close', finish)
    stream.once('error', finish)
  })
}

function appendNameSuffix(name: string, index: number, maxLength: number): string {
  const suffix = ` (${index})`
  const dot = name.lastIndexOf('.')
  const hasExtension = dot > 0
  const base = hasExtension ? name.slice(0, dot) : name
  const extension = hasExtension ? name.slice(dot) : ''
  const available = Math.max(1, maxLength - suffix.length - extension.length)
  return `${base.slice(0, available)}${suffix}${extension}`
}

function computeProgress(totalBytes: number | null, transferredBytes: number): number | null {
  if (totalBytes === null) return null
  if (totalBytes === 0) return 0
  return Math.min(100, Math.floor((transferredBytes / totalBytes) * 100))
}

/**
 * Owns every transfer task in the main process. Local source paths come from
 * native dialogs or from renderer selections that are re-validated here
 * (`lstat`, type checks, no symlink following); the renderer receives only
 * immutable task snapshots. All file handles and streams stay in this process.
 */
export class TransferService implements TransferServicePort {
  private readonly tasks = new Map<string, TransferTask>()
  private readonly runtimes = new Map<string, TaskRuntime>()
  private readonly queue: TransferQueue
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly maxExpandedUploadTasks: number
  private readonly maxUploadDirectoryDepth: number
  private readonly progressIntervalMs: number
  private readonly inactivityTimeoutMs: number
  private readonly closeTimeoutMs: number
  private readonly cleanupTimeoutMs: number
  private readonly abortSettleTimeoutMs: number
  private readonly journalPath: string | null
  private readonly journalReady: Promise<void>
  private journalTimer: NodeJS.Timeout | null = null
  private journalChain: Promise<void> = Promise.resolve()
  private pickerActive = false
  private disposed = false

  constructor(private readonly dependencies: TransferServiceDependencies) {
    this.queue = new TransferQueue({
      maxConcurrent: Math.max(1, dependencies.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
      maxPerSession: Math.max(1, dependencies.maxPerSession ?? DEFAULT_MAX_PER_SESSION),
    })
    this.now = dependencies.now ?? (() => new Date())
    this.createId = dependencies.createId ?? (() => `transfer-${randomUUID()}`)
    this.maxExpandedUploadTasks = Math.max(
      1,
      dependencies.maxExpandedUploadTasks ?? DEFAULT_MAX_EXPANDED_UPLOAD_TASKS,
    )
    this.maxUploadDirectoryDepth = Math.max(
      1,
      dependencies.maxUploadDirectoryDepth ?? DEFAULT_MAX_UPLOAD_DIRECTORY_DEPTH,
    )
    this.progressIntervalMs = Math.max(
      0,
      dependencies.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
    )
    this.inactivityTimeoutMs = dependencies.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
    this.closeTimeoutMs = dependencies.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    this.cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
    this.abortSettleTimeoutMs = dependencies.abortSettleTimeoutMs ?? DEFAULT_ABORT_SETTLE_TIMEOUT_MS
    this.journalPath = dependencies.journalPath ?? null
    this.journalReady = this.hydrateJournal()
  }

  initialize(): Promise<void> {
    return this.journalReady
  }

  setConcurrencyLimits(limits: TransferConcurrencyLimits): void {
    const maxConcurrent = Math.min(4, Math.max(1, Math.floor(limits.maxConcurrent)))
    const maxPerSession = Math.min(maxConcurrent, 2, Math.max(1, Math.floor(limits.maxPerSession)))
    this.queue.setLimits({ maxConcurrent, maxPerSession })
    this.dependencies.onNotice?.('concurrency-updated', {
      maxConcurrent,
      maxPerSession,
    })
    this.schedule()
  }

  async enqueueUpload(rawSessionId: string, rawRemoteDirectory: string): Promise<TransferTask[]> {
    this.assertUsable()
    const sessionId = rawSessionId
    const remoteDirectory = normalizeRemotePath(rawRemoteDirectory)
    try {
      await this.assertRemoteDirectory(sessionId, remoteDirectory)
    } catch (error) {
      throw this.asEnqueueFailure(error)
    }

    const picked = await this.openPicker(() => this.dependencies.pickUploadFiles())
    if (this.disposed) {
      throw new AppOperationError('unavailable', '应用正在退出，无法开始新的传输。')
    }
    const sourcePaths = [...new Set(picked.filter((path) => path.length > 0))]
    if (sourcePaths.length === 0) return []
    if (sourcePaths.length > MAX_TRANSFER_BATCH) {
      throw new AppOperationError(
        'limit-exceeded',
        `一次最多上传 ${MAX_TRANSFER_BATCH} 个文件，请缩小选择范围后重试。`,
      )
    }

    // The dialog is asynchronous: the session or directory may have changed.
    try {
      await this.assertRemoteDirectory(sessionId, remoteDirectory)
    } catch (error) {
      throw this.asEnqueueFailure(error)
    }

    const created: TransferTask[] = []
    for (const sourcePath of sourcePaths) {
      const fileName = basename(sourcePath)
      if (!fileName) continue
      const id = this.createId()
      const task = this.createTask({
        id,
        sessionId,
        direction: 'upload',
        fileName,
        sourcePath,
        destinationPath: joinRemotePath(remoteDirectory, fileName),
      })
      const runtime = this.createRuntime(task, {
        localSourcePath: sourcePath,
        remoteDirectory,
      })
      this.register(task, runtime)
      created.push(this.snapshot(task))
    }

    this.schedule()
    return created
  }

  async enqueueUploadPaths(
    rawSessionId: string,
    rawRemoteDirectory: string,
    rawLocalPaths: string[],
  ): Promise<TransferUploadEnqueueAck> {
    this.assertUsable()
    const parsed = transferEnqueueUploadPathsInputSchema.safeParse({
      sessionId: rawSessionId,
      remoteDirectory: rawRemoteDirectory,
      localPaths: rawLocalPaths,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '上传路径参数未通过校验。')
    }
    const sessionId = parsed.data.sessionId
    const remoteDirectory = normalizeRemotePath(parsed.data.remoteDirectory)

    // Fail fast while the drop target is known to exist; the per-file
    // preparation re-checks the directory and creates missing sub-directories.
    try {
      await this.assertRemoteDirectory(sessionId, remoteDirectory)
    } catch (error) {
      throw this.asEnqueueFailure(error)
    }

    const sourcePaths = [...new Set(parsed.data.localPaths.map((path) => normalizeLocalPath(path)))]
    const expanded = await this.expandLocalUploadSources(sourcePaths)
    if (this.disposed) {
      throw new AppOperationError('unavailable', '应用正在退出，无法开始新的传输。')
    }

    const created: TransferTask[] = []
    const seenDestinations = new Set<string>()
    let skippedUnsupported = expanded.skippedUnsupported
    for (const source of expanded.files) {
      const segments =
        source.relativeDirectory.length > 0 ? source.relativeDirectory.split('/') : []
      // Local names may contain characters the remote side cannot represent
      // (control characters); such entries are skipped and counted instead of
      // failing the whole drop.
      if (
        getRemoteEntryNameError(source.fileName) ||
        segments.some((segment) => getRemoteEntryNameError(segment))
      ) {
        skippedUnsupported += 1
        continue
      }

      let destination = remoteDirectory
      for (const segment of segments) {
        destination = joinRemotePath(destination, segment)
      }
      destination = joinRemotePath(destination, source.fileName)
      if (seenDestinations.has(destination)) continue
      seenDestinations.add(destination)

      const id = this.createId()
      const task = this.createTask({
        id,
        sessionId,
        direction: 'upload',
        fileName: source.fileName,
        sourcePath: source.localPath,
        destinationPath: destination,
      })
      const runtime = this.createRuntime(task, {
        localSourcePath: source.localPath,
        remoteDirectory: remoteParentPath(destination),
      })
      this.register(task, runtime)
      created.push(this.snapshot(task))
    }

    this.schedule()
    return {
      tasks: created,
      skippedSymlinks: expanded.skippedSymlinks,
      skippedUnsupported,
      truncated: expanded.truncated,
      remoteDirectory,
    }
  }

  /**
   * Expands dragged local files and directories into per-file sources.
   * Symbolic links are never followed (they are counted and skipped), and the
   * traversal stops honestly when the expanded-task cap is reached.
   */
  private async expandLocalUploadSources(sourcePaths: string[]): Promise<{
    files: ExpandedUploadSource[]
    skippedSymlinks: number
    skippedUnsupported: number
    truncated: boolean
  }> {
    const files: ExpandedUploadSource[] = []
    let skippedSymlinks = 0
    let skippedUnsupported = 0
    let truncated = false
    const queue: Array<{ directory: string; relativeDirectory: string; depth: number }> = []

    for (const sourcePath of sourcePaths) {
      let stats: Stats
      try {
        stats = await fsp.lstat(sourcePath)
      } catch (error) {
        const code = toLocalErrorCode(error)
        if (code === 'ENOENT') {
          throw new AppOperationError(
            'not-found',
            '所选本地条目不存在或已被移动；请刷新本地面板后重试。',
          )
        }
        if (code === 'EACCES' || code === 'EPERM') {
          throw new AppOperationError('permission-denied', '没有权限读取所选本地条目。')
        }
        throw new AppOperationError('unavailable', '无法读取所选本地条目，请稍后重试。')
      }

      if (stats.isSymbolicLink()) {
        skippedSymlinks += 1
        continue
      }
      if (stats.isFile()) {
        const fileName = localPathName(sourcePath)
        if (!fileName) {
          skippedUnsupported += 1
          continue
        }
        if (files.length >= this.maxExpandedUploadTasks) {
          truncated = true
          break
        }
        files.push({ localPath: sourcePath, fileName, relativeDirectory: '' })
        continue
      }
      if (stats.isDirectory()) {
        // The dragged directory keeps its own name at the destination (copy
        // semantics, like Explorer/WinSCP); only the top-level plain files
        // land directly in the target directory.
        queue.push({
          directory: sourcePath,
          relativeDirectory: localPathName(sourcePath),
          depth: 0,
        })
        continue
      }
      skippedUnsupported += 1
    }

    while (queue.length > 0 && !truncated) {
      const current = queue.shift()!
      let dirents: Dirent[]
      try {
        dirents = await fsp.readdir(current.directory, { withFileTypes: true })
      } catch (error) {
        const code = toLocalErrorCode(error)
        if (code === 'EACCES' || code === 'EPERM') {
          throw new AppOperationError(
            'permission-denied',
            `没有权限读取本地目录：${localPathName(current.directory) || current.directory}`,
          )
        }
        // A directory that vanished mid-walk contributes nothing; the count
        // keeps the skip visible instead of silently transferring less.
        skippedUnsupported += 1
        continue
      }
      dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

      for (const dirent of dirents) {
        if (truncated) break
        const name = dirent.name
        if (!name || name.includes('/') || name.includes('\\')) {
          skippedUnsupported += 1
          continue
        }
        const childPath = appendLocalName(current.directory, name)
        if (dirent.isSymbolicLink()) {
          skippedSymlinks += 1
          continue
        }
        if (dirent.isFile()) {
          if (files.length >= this.maxExpandedUploadTasks) {
            truncated = true
            break
          }
          files.push({
            localPath: childPath,
            fileName: name,
            relativeDirectory: current.relativeDirectory,
          })
          continue
        }
        if (dirent.isDirectory()) {
          if (current.depth + 1 > this.maxUploadDirectoryDepth) {
            skippedUnsupported += 1
            continue
          }
          queue.push({
            directory: childPath,
            relativeDirectory: current.relativeDirectory
              ? `${current.relativeDirectory}/${name}`
              : name,
            depth: current.depth + 1,
          })
          continue
        }
        skippedUnsupported += 1
      }
    }

    return { files, skippedSymlinks, skippedUnsupported, truncated }
  }

  async enqueueDownload(rawSessionId: string, rawRemotePaths: string[]): Promise<TransferTask[]> {
    this.assertUsable()
    const sessionId = rawSessionId
    const remotePaths = [...new Set(rawRemotePaths.map((path) => normalizeRemotePath(path)))]
    if (remotePaths.length === 0) {
      throw new AppOperationError('invalid-input', '至少选择一个远程文件。')
    }
    if (remotePaths.length > MAX_TRANSFER_BATCH) {
      throw new AppOperationError(
        'limit-exceeded',
        `一次最多下载 ${MAX_TRANSFER_BATCH} 个文件，请缩小选择范围后重试。`,
      )
    }
    for (const path of remotePaths) {
      if (path === '/') {
        throw new AppOperationError('invalid-input', '不能将远程根目录作为下载目标。')
      }
      // Remote POSIX names may contain backslashes, which Windows path.join
      // would treat as separators and could escape the chosen local directory.
      const nameError = getLocalFileNameError(remotePathName(path))
      if (nameError) {
        throw new AppOperationError('invalid-input', `远程文件名无法在本地安全创建：${nameError}`)
      }
    }

    await this.dependencies.sftp.probe(sessionId)

    const localDirectory = await this.openPicker(() => this.dependencies.pickDownloadDirectory())
    if (!localDirectory) return []
    if (this.disposed) {
      throw new AppOperationError('unavailable', '应用正在退出，无法开始新的传输。')
    }
    try {
      await this.assertLocalDirectory(localDirectory)
    } catch (error) {
      throw this.asEnqueueFailure(error)
    }

    const created: TransferTask[] = []
    for (const remotePath of remotePaths) {
      const fileName = remotePathName(remotePath)
      if (!fileName) continue
      const id = this.createId()
      const task = this.createTask({
        id,
        sessionId,
        direction: 'download',
        fileName,
        sourcePath: remotePath,
        destinationPath: join(localDirectory, fileName),
      })
      const runtime = this.createRuntime(task, { localDirectory })
      this.register(task, runtime)
      created.push(this.snapshot(task))
    }

    this.schedule()
    return created
  }

  /**
   * Download variant used by drag & drop and the local file panel: the target
   * directory is supplied by the renderer and re-validated here, never taken
   * from a dialog.
   */
  async enqueueDownloadPaths(
    rawSessionId: string,
    rawRemotePaths: string[],
    rawLocalDirectory: string,
  ): Promise<TransferTask[]> {
    this.assertUsable()
    const parsed = transferEnqueueDownloadPathsInputSchema.safeParse({
      sessionId: rawSessionId,
      remotePaths: rawRemotePaths,
      localDirectory: rawLocalDirectory,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '下载路径参数未通过校验。')
    }
    const sessionId = parsed.data.sessionId
    const remotePaths = [
      ...new Set(parsed.data.remotePaths.map((path) => normalizeRemotePath(path))),
    ]
    const localDirectory = normalizeLocalPath(parsed.data.localDirectory)
    if (isLocalPathAtRoot(localDirectory)) {
      throw new AppOperationError(
        'invalid-input',
        '不要把文件直接下载到磁盘根目录；请在根目录下选择一个文件夹。',
      )
    }
    for (const path of remotePaths) {
      if (path === '/') {
        throw new AppOperationError('invalid-input', '不能将远程根目录作为下载目标。')
      }
      const nameError = getLocalFileNameError(remotePathName(path))
      if (nameError) {
        throw new AppOperationError('invalid-input', `远程文件名无法在本地安全创建：${nameError}`)
      }
    }

    await this.dependencies.sftp.probe(sessionId)
    if (this.disposed) {
      throw new AppOperationError('unavailable', '应用正在退出，无法开始新的传输。')
    }
    try {
      await this.assertLocalDirectory(localDirectory)
    } catch (error) {
      throw this.asEnqueueFailure(error)
    }

    const created: TransferTask[] = []
    for (const remotePath of remotePaths) {
      const fileName = remotePathName(remotePath)
      if (!fileName) continue
      const id = this.createId()
      const task = this.createTask({
        id,
        sessionId,
        direction: 'download',
        fileName,
        sourcePath: remotePath,
        destinationPath: appendLocalName(localDirectory, fileName),
      })
      const runtime = this.createRuntime(task, { localDirectory })
      this.register(task, runtime)
      created.push(this.snapshot(task))
    }

    this.schedule()
    return created
  }

  cancel(rawTransferId: string): Promise<TransferTask> {
    const task = this.requireTask(rawTransferId)
    if (isTerminalTransferStatus(task.status)) {
      throw new AppOperationError('conflict', '任务已经结束，无法取消。')
    }
    const runtime = this.requireRuntime(rawTransferId)

    if (task.status === 'queued') {
      this.queue.remove(task.id)
      this.finalizeImmediately(runtime, {
        status: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: '传输已取消。',
        conflict: null,
      })
      return Promise.resolve(this.snapshot(runtime.task))
    }

    if (task.status === 'waitingForConflictResolution') {
      this.finalizeImmediately(runtime, {
        status: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: '传输已取消。',
        conflict: null,
      })
      return Promise.resolve(this.snapshot(runtime.task))
    }

    if (task.status === 'cancelling') {
      return Promise.resolve(this.snapshot(task))
    }

    if (runtime.commitStarted) {
      throw new AppOperationError('conflict', '文件正在提交，暂时无法取消；请稍候查看结果。')
    }

    runtime.cancelRequested = true
    this.applyTask(runtime, { status: 'cancelling', speedBytesPerSecond: null })
    this.abortRuntime(runtime, new TransferAbortError('cancelled'))
    return Promise.resolve(this.snapshot(runtime.task))
  }

  async retry(rawTransferId: string): Promise<TransferTask> {
    this.assertUsable()
    const task = this.requireTask(rawTransferId)
    if (task.status === 'interrupted') {
      throw new AppOperationError(
        'conflict',
        '该任务来自上次应用退出，服务器上的结果未知，无法在当前会话恢复；请重新发起传输。',
      )
    }
    if (task.status !== 'failed' && task.status !== 'cancelled') {
      throw new AppOperationError('conflict', '只有已失败或已取消的任务可以重试。')
    }
    const staleRuntime = this.runtimes.get(task.id)
    if (staleRuntime) {
      this.releaseSlot(staleRuntime)
      this.runtimes.delete(task.id)
    }

    await this.dependencies.sftp.probe(task.sessionId)
    if (this.disposed) {
      throw new AppOperationError('unavailable', '应用正在退出，无法重试传输。')
    }

    const retried = this.createTask({
      id: task.id,
      sessionId: task.sessionId,
      direction: task.direction,
      fileName: task.fileName,
      sourcePath: task.sourcePath,
      destinationPath: task.destinationPath,
      attempt: task.attempt + 1,
      createdAt: task.createdAt,
      revision: task.revision + 1,
    })

    const runtime = this.createRuntime(retried, {
      localSourcePath: task.direction === 'upload' ? task.sourcePath : null,
      localDirectory: task.direction === 'download' ? dirname(task.destinationPath) : null,
      remoteDirectory: task.direction === 'upload' ? remoteParentPath(task.destinationPath) : null,
    })
    this.register(retried, runtime)
    this.schedule()
    return this.snapshot(retried)
  }

  resolveConflict(
    rawTransferId: string,
    choice: TransferConflictPolicy,
    newName?: string,
  ): Promise<TransferTask> {
    this.assertUsable()
    const task = this.requireTask(rawTransferId)
    const runtime = this.requireRuntime(rawTransferId)
    if (task.status !== 'waitingForConflictResolution') {
      throw new AppOperationError('conflict', '该任务当前没有待处理的冲突。')
    }

    if (choice === 'skip') {
      this.finalizeImmediately(runtime, {
        status: 'skipped',
        errorCode: null,
        errorMessage: null,
        conflict: null,
      })
      return Promise.resolve(this.snapshot(runtime.task))
    }

    const directory = task.direction === 'upload' ? runtime.remoteDirectory : runtime.localDirectory
    if (!directory) {
      throw new AppOperationError('internal', '冲突任务的目录信息不可用。')
    }

    let destinationPath = task.destinationPath
    if (choice === 'rename') {
      const candidate = (newName ?? '').trim()
      const nameError =
        task.direction === 'upload'
          ? getRemoteEntryNameError(candidate)
          : getLocalFileNameError(candidate)
      if (nameError) {
        throw new AppOperationError('invalid-input', nameError)
      }
      destinationPath =
        task.direction === 'upload'
          ? joinRemotePath(directory, candidate)
          : join(directory, candidate)
    }

    runtime.task = {
      ...runtime.task,
      status: 'queued',
      destinationPath,
      conflictPolicy: choice,
      conflict: null,
      totalBytes: null,
      transferredBytes: 0,
      progress: null,
      speedBytesPerSecond: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      revision: runtime.task.revision + 1,
    }
    runtime.bytesTransferred = 0
    runtime.samples = []
    runtime.lastEmitAt = 0
    runtime.sourceMetadata = null
    runtime.sourceStream = null
    runtime.destinationStream = null
    runtime.remoteTempCreated = false
    runtime.localTempCreated = false
    runtime.tempPath = null
    runtime.cancelRequested = false
    runtime.commitStarted = false
    runtime.abortCause = null
    runtime.stage = 'source'
    runtime.finalized = false
    runtime.cleanupStarted = false
    runtime.cleanupNote = null
    runtime.completionWarning = null

    this.tasks.set(runtime.task.id, runtime.task)
    this.emit(runtime.task)
    this.queue.enqueue({ taskId: runtime.task.id, sessionId: runtime.task.sessionId })
    this.schedule()
    return Promise.resolve(this.snapshot(runtime.task))
  }

  list(): TransferTask[] {
    return [...this.tasks.values()].map((task) => this.snapshot(task))
  }

  clearHistory(): TransferClearAck {
    let cleared = 0
    for (const [id, task] of this.tasks) {
      if (!isTerminalTransferStatus(task.status)) continue
      if (this.runtimes.has(id)) continue
      this.tasks.delete(id)
      cleared += 1
    }
    if (cleared > 0) this.scheduleJournalWrite()
    return { cleared }
  }

  handleSessionTerminated(sessionId: string): void {
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.task.sessionId !== sessionId) continue
      if (runtime.commitStarted) continue

      if (runtime.task.status === 'queued') {
        this.queue.remove(runtime.task.id)
        this.finalizeImmediately(runtime, {
          status: 'failed',
          errorCode: 'connection-lost',
          errorMessage: 'SSH 会话已断开，传输已停止。',
          conflict: null,
        })
        continue
      }
      if (runtime.task.status === 'waitingForConflictResolution') {
        this.finalizeImmediately(runtime, {
          status: 'failed',
          errorCode: 'connection-lost',
          errorMessage: 'SSH 会话已断开，传输已停止。',
          conflict: null,
        })
        continue
      }
      if (
        runtime.task.status === 'preparing' ||
        runtime.task.status === 'transferring' ||
        runtime.task.status === 'cancelling'
      ) {
        this.abortRuntime(runtime, new TransferAbortError('session-closed'))
      }
    }
  }

  cancelAll(reason: TransferAbortReason = 'window-closed'): void {
    const message =
      reason === 'shutdown' || reason === 'window-closed'
        ? '应用正在关闭，传输已停止。'
        : '传输已取消。'
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.commitStarted) continue
      if (
        runtime.task.status === 'queued' ||
        runtime.task.status === 'waitingForConflictResolution'
      ) {
        this.queue.remove(runtime.task.id)
        this.finalizeImmediately(runtime, {
          status: 'cancelled',
          errorCode: 'cancelled',
          errorMessage: message,
          conflict: null,
        })
        continue
      }
      if (
        runtime.task.status === 'preparing' ||
        runtime.task.status === 'transferring' ||
        runtime.task.status === 'cancelling'
      ) {
        this.abortRuntime(runtime, new TransferAbortError(reason))
      }
    }
  }

  /**
   * Idempotent shutdown. Cancellation is requested immediately; the returned
   * promise waits only for a bounded settle window, then flushes the journal.
   * Tasks that cannot settle remain journalled as unfinished and are shown as
   * `interrupted` after restart instead of being reported as completed.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.cancelAll('shutdown')
    this.disposed = true
    this.queue.reset()

    const deadline = Date.now() + Math.min(3_000, this.abortSettleTimeoutMs)
    while (this.runtimes.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50)
        timer.unref?.()
      })
    }

    if (this.journalTimer) {
      clearTimeout(this.journalTimer)
      this.journalTimer = null
    }
    await withTimeout(this.flushJournal(), 1_500, '等待传输任务日志写入超时。').catch(
      () => undefined,
    )
  }

  private createTask(input: {
    id: string
    sessionId: string
    direction: 'upload' | 'download'
    fileName: string
    sourcePath: string
    destinationPath: string
    attempt?: number
    createdAt?: string
    revision?: number
  }): TransferTask {
    return {
      id: input.id,
      sessionId: input.sessionId,
      direction: input.direction,
      fileName: input.fileName,
      sourcePath: input.sourcePath,
      destinationPath: input.destinationPath,
      status: 'queued',
      totalBytes: null,
      transferredBytes: 0,
      progress: null,
      speedBytesPerSecond: null,
      errorCode: null,
      errorMessage: null,
      createdAt: input.createdAt ?? this.now().toISOString(),
      startedAt: null,
      completedAt: null,
      attempt: input.attempt ?? 1,
      conflictPolicy: null,
      conflict: null,
      revision: input.revision ?? 1,
    }
  }

  private createRuntime(
    task: TransferTask,
    paths: {
      localSourcePath?: string | null
      localDirectory?: string | null
      remoteDirectory?: string | null
    },
  ): TaskRuntime {
    return {
      task,
      localSourcePath: paths.localSourcePath ?? null,
      localDirectory: paths.localDirectory ?? null,
      remoteDirectory: paths.remoteDirectory ?? null,
      sourceMetadata: null,
      sourceStream: null,
      destinationStream: null,
      remoteTempCreated: false,
      localTempCreated: false,
      tempPath: null,
      bytesTransferred: 0,
      samples: [],
      lastEmitAt: 0,
      watchdog: null,
      settleTimer: null,
      activeSlot: false,
      cancelRequested: false,
      commitStarted: false,
      abortCause: null,
      stage: 'source',
      finalized: false,
      cleanupStarted: false,
      cleanupNote: null,
      completionWarning: null,
    }
  }

  private register(task: TransferTask, runtime: TaskRuntime): void {
    this.tasks.set(task.id, task)
    this.runtimes.set(task.id, runtime)
    this.emit(task)
    this.queue.enqueue({ taskId: task.id, sessionId: task.sessionId })
    this.scheduleJournalWrite()
  }

  private schedule(): void {
    if (this.disposed) return
    while (true) {
      const entry = this.queue.takeNext()
      if (!entry) return
      const runtime = this.runtimes.get(entry.taskId)
      if (!runtime || runtime.task.status !== 'queued' || runtime.finalized) {
        this.queue.release(entry.taskId)
        continue
      }
      runtime.activeSlot = true
      void this.runTask(runtime)
    }
  }

  private async runTask(runtime: TaskRuntime): Promise<void> {
    try {
      this.applyTask(runtime, {
        status: 'preparing',
        startedAt: runtime.task.startedAt ?? this.now().toISOString(),
        errorCode: null,
        errorMessage: null,
      })
      runtime.stage = 'source'
      const ready =
        runtime.task.direction === 'upload'
          ? await this.prepareUpload(runtime)
          : await this.prepareDownload(runtime)
      if (!ready) return

      this.assertRunActive(runtime)
      this.applyTask(runtime, {
        status: 'transferring',
        progress: runtime.task.totalBytes === null ? null : 0,
      })

      if (runtime.task.direction === 'upload') {
        await this.transferUpload(runtime)
      } else {
        await this.transferDownload(runtime)
      }

      this.assertRunActive(runtime)
      await this.commitRuntime(runtime)
      this.finishCompleted(runtime)
    } catch (error) {
      await this.finishFailed(runtime, error)
    } finally {
      this.stopWatchdog(runtime)
      this.clearSettleTimer(runtime)
      if (this.runtimes.get(runtime.task.id) === runtime) {
        this.releaseSlot(runtime)
        if (runtime.finalized) this.runtimes.delete(runtime.task.id)
        this.schedule()
      }
    }
  }

  private async prepareUpload(runtime: TaskRuntime): Promise<boolean> {
    const task = runtime.task
    const sourcePath = runtime.localSourcePath
    if (!sourcePath) {
      throw new TransferTaskError('source-missing', '本地源文件信息不可用。')
    }

    let stats: Stats
    try {
      stats = await fsp.lstat(sourcePath)
    } catch (error) {
      throw this.localSourceFailure(error)
    }
    this.assertRunActive(runtime)
    if (!stats.isFile()) {
      throw new TransferTaskError(
        'source-not-file',
        '只能上传普通文件；文件夹或符号链接未加入传输。',
      )
    }

    const size = Number.isSafeInteger(stats.size) && stats.size >= 0 ? stats.size : null
    runtime.sourceMetadata = { size: stats.size, mtimeMs: stats.mtimeMs }

    const directory = runtime.remoteDirectory
    if (!directory) {
      throw new TransferTaskError('destination-unavailable', '远程目标目录信息不可用。')
    }
    await this.ensureRemoteDirectory(runtime, directory)
    this.assertRunActive(runtime)

    const existing = await this.statRemoteOrNull(task.sessionId, task.destinationPath)
    this.assertRunActive(runtime)
    if (existing) {
      if (task.conflictPolicy === 'overwrite') {
        if (existing.kind !== 'file') {
          throw new TransferTaskError(
            'target-changed',
            '目标已存在且不是普通文件，无法覆盖；请选择其他文件名。',
          )
        }
      } else {
        await this.enterConflict(runtime)
        return false
      }
    }

    this.applyTask(runtime, { totalBytes: size, transferredBytes: 0, progress: null })
    return true
  }

  private async prepareDownload(runtime: TaskRuntime): Promise<boolean> {
    const task = runtime.task
    let source: RemoteFileEntry
    try {
      source = await this.dependencies.sftp.statRemote(task.sessionId, task.sourcePath)
    } catch (error) {
      if (error instanceof AppOperationError && error.code === 'not-found') {
        throw new TransferTaskError('source-missing', '远程源文件不存在或已被删除。')
      }
      throw error
    }
    this.assertRunActive(runtime)
    if (source.kind !== 'file') {
      throw new TransferTaskError('source-not-file', '只能下载普通文件；目录或符号链接未加入传输。')
    }

    const localDirectory = runtime.localDirectory
    if (!localDirectory) {
      throw new TransferTaskError('destination-unavailable', '本地目标目录信息不可用。')
    }
    await this.assertLocalDirectory(localDirectory)
    this.assertRunActive(runtime)

    const targetName = basename(task.destinationPath)
    const nameError = getLocalFileNameError(targetName)
    if (nameError) {
      throw new TransferTaskError(
        'invalid-input',
        `远程文件名无法在本地安全保存（${nameError}）；请重命名远程文件后重试。`,
      )
    }

    let targetStats: Stats | null = null
    try {
      targetStats = await fsp.lstat(task.destinationPath)
    } catch (error) {
      const code = toLocalErrorCode(error)
      if (code !== 'ENOENT') {
        throw new TransferTaskError(
          'destination-unavailable',
          '无法检查本地目标文件，请确认目录仍可访问。',
        )
      }
    }
    this.assertRunActive(runtime)

    if (targetStats) {
      if (!targetStats.isFile()) {
        throw new TransferTaskError(
          'target-changed',
          '本地目标已存在且不是普通文件，未覆盖；请选择其他名称。',
        )
      }
      if (task.conflictPolicy === 'overwrite') {
        // Re-checked again immediately before the final rename.
      } else {
        await this.enterConflict(runtime)
        return false
      }
    }

    const total = source.sizeBytes
    this.applyTask(runtime, {
      totalBytes: total,
      transferredBytes: 0,
      progress: null,
    })
    return true
  }

  private async transferUpload(runtime: TaskRuntime): Promise<void> {
    const task = runtime.task
    const sourcePath = runtime.localSourcePath
    const directory = runtime.remoteDirectory
    const metadata = runtime.sourceMetadata
    if (!sourcePath || !directory || !metadata) {
      throw new TransferTaskError('internal', '上传任务的准备信息不完整。')
    }

    runtime.stage = 'transfer'
    const tempPath = joinRemotePath(directory, `${TRANSFER_TEMP_PREFIX}${randomUUID()}`)
    runtime.tempPath = tempPath
    runtime.remoteTempCreated = true

    this.armWatchdog(runtime)
    const readStream = createReadStream(sourcePath)
    runtime.sourceStream = readStream
    const writeStream = await this.dependencies.sftp.openTransferWriteStream(
      task.sessionId,
      tempPath,
    )
    runtime.destinationStream = writeStream
    this.assertRunActive(runtime)

    const closeTracker = trackClose(writeStream)
    try {
      await pipeline(readStream, this.createCounter(runtime), writeStream)
      await withTimeout(
        closeTracker,
        this.closeTimeoutMs,
        '远程文件写入未能在限定时间内关闭，上传结果未提交。',
      )
      this.assertRunActive(runtime)

      let after: Stats
      try {
        after = await fsp.lstat(sourcePath)
      } catch (error) {
        throw this.localSourceFailure(error)
      }
      if (!after.isFile() || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
        throw new TransferTaskError(
          'source-changed',
          '本地源文件在传输期间发生了变化，上传已停止且未提交。',
        )
      }
      if (runtime.bytesTransferred !== metadata.size) {
        throw new TransferTaskError(
          'source-changed',
          '读取的字节数与源文件大小不一致，上传未提交。',
        )
      }

      const remoteTemp = await this.dependencies.sftp.statRemote(task.sessionId, tempPath)
      if (remoteTemp.kind !== 'file') {
        throw new TransferTaskError('internal', '服务器上的临时文件不存在或不是普通文件。')
      }
      if (remoteTemp.sizeBytes !== null && remoteTemp.sizeBytes !== runtime.bytesTransferred) {
        throw new TransferTaskError(
          'internal',
          '服务器确认的写入字节数与发送字节数不一致，上传未提交。',
        )
      }
    } finally {
      this.stopWatchdog(runtime)
    }
  }

  private async transferDownload(runtime: TaskRuntime): Promise<void> {
    const task = runtime.task
    const localDirectory = runtime.localDirectory
    if (!localDirectory) {
      throw new TransferTaskError('destination-unavailable', '本地目标目录信息不可用。')
    }

    runtime.stage = 'transfer'
    const tempPath = join(localDirectory, `${TRANSFER_TEMP_PREFIX}${randomUUID()}`)
    runtime.tempPath = tempPath
    runtime.localTempCreated = true

    this.armWatchdog(runtime)
    const readStream = await this.dependencies.sftp.openTransferReadStream(
      task.sessionId,
      task.sourcePath,
    )
    runtime.sourceStream = readStream
    this.assertRunActive(runtime)
    const writeStream = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })
    runtime.destinationStream = writeStream

    const closeTracker = trackClose(writeStream)
    try {
      await pipeline(readStream, this.createCounter(runtime), writeStream)
      await withTimeout(
        closeTracker,
        this.closeTimeoutMs,
        '本地文件写入未能在限定时间内关闭，下载结果未提交。',
      )
      this.assertRunActive(runtime)

      let tempStats: Stats
      try {
        tempStats = await fsp.stat(tempPath)
      } catch {
        throw new TransferTaskError('internal', '下载临时文件不存在，下载未提交。')
      }
      if (!tempStats.isFile() || tempStats.size !== runtime.bytesTransferred) {
        throw new TransferTaskError('internal', '本地临时文件大小与接收字节数不一致，下载未提交。')
      }
      if (
        runtime.task.totalBytes !== null &&
        runtime.bytesTransferred !== runtime.task.totalBytes
      ) {
        throw new TransferTaskError(
          'source-changed',
          '远程文件在下载期间发生变化或未完整读取，下载未提交。',
        )
      }

      const sourceNow = await this.dependencies.sftp.statRemote(task.sessionId, task.sourcePath)
      this.assertRunActive(runtime)
      if (sourceNow.kind !== 'file') {
        throw new TransferTaskError('source-changed', '远程源文件在下载期间发生了变化。')
      }
      if (
        runtime.task.totalBytes !== null &&
        sourceNow.sizeBytes !== null &&
        sourceNow.sizeBytes !== runtime.task.totalBytes
      ) {
        throw new TransferTaskError('source-changed', '远程源文件大小在下载期间发生了变化。')
      }
    } finally {
      this.stopWatchdog(runtime)
    }
  }

  private async commitRuntime(runtime: TaskRuntime): Promise<void> {
    runtime.stage = 'commit'
    runtime.commitStarted = true
    if (!runtime.tempPath) {
      throw new TransferTaskError('internal', '缺少待提交的临时文件。')
    }

    if (runtime.task.direction === 'upload') {
      const overwrite = runtime.task.conflictPolicy === 'overwrite'
      const result = await this.dependencies.sftp.commitRemoteUpload(
        runtime.task.sessionId,
        runtime.tempPath,
        runtime.task.destinationPath,
        overwrite,
      )
      runtime.tempPath = null
      runtime.remoteTempCreated = false
      if (result.backupCleanupFailed) {
        runtime.completionWarning =
          '上传已完成，但原目标文件的备份未能自动清理，请检查远程目标目录。'
      }
      return
    }

    await this.commitLocalDownload(runtime)
  }

  private async commitLocalDownload(runtime: TaskRuntime): Promise<void> {
    const task = runtime.task
    const tempPath = runtime.tempPath
    if (!tempPath || !isTransferTempName(basename(tempPath))) {
      throw new TransferTaskError('internal', '下载临时文件信息无效，拒绝提交。')
    }
    const targetPath = task.destinationPath
    if (dirname(tempPath) !== dirname(targetPath)) {
      throw new TransferTaskError('internal', '临时文件与目标不在同一目录，拒绝提交。')
    }

    let tempStats: Stats | null = null
    try {
      tempStats = await fsp.lstat(tempPath)
    } catch {
      tempStats = null
    }
    if (!tempStats || !tempStats.isFile()) {
      throw new TransferTaskError('internal', '下载临时文件已不存在，无法提交。')
    }

    let targetStats: Stats | null = null
    try {
      targetStats = await fsp.lstat(targetPath)
    } catch (error) {
      const code = toLocalErrorCode(error)
      if (code !== 'ENOENT') {
        throw new TransferTaskError('destination-unavailable', '无法检查目标文件，未提交。')
      }
    }

    const overwrite = task.conflictPolicy === 'overwrite'
    let backupPath: string | null = null
    if (targetStats) {
      if (!overwrite) {
        throw new TransferTaskError(
          'target-changed',
          '目标在提交前已被创建或修改；为避免覆盖，下载未提交。',
        )
      }
      if (!targetStats.isFile()) {
        throw new TransferTaskError('target-changed', '目标已存在且不是普通文件，拒绝覆盖。')
      }
      backupPath = join(dirname(targetPath), `${TRANSFER_BACKUP_PREFIX}${randomUUID()}`)
      try {
        await fsp.rename(targetPath, backupPath)
      } catch {
        throw new TransferTaskError('destination-unavailable', '无法暂存原有目标文件，下载未提交。')
      }
    }

    try {
      await fsp.rename(tempPath, targetPath)
    } catch (error) {
      if (backupPath) {
        try {
          await fsp.rename(backupPath, targetPath)
        } catch {
          throw new TransferTaskError(
            'outcome-unknown',
            '下载未能完成，且无法恢复原目标文件；原文件可能以备份名称保留，请检查目标目录。',
          )
        }
      }
      const code = toLocalErrorCode(error)
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
        throw new TransferTaskError(
          'target-changed',
          '目标在提交前已被占用或拒绝访问，下载未提交。',
        )
      }
      throw new TransferTaskError(
        'destination-unavailable',
        '无法将下载临时文件重命名为目标文件，下载未提交。',
      )
    }

    runtime.tempPath = null
    runtime.localTempCreated = false
    if (backupPath) {
      try {
        await fsp.unlink(backupPath)
      } catch {
        runtime.completionWarning =
          '下载已完成，但原目标文件的备份未能自动清理，请检查本地目标目录。'
      }
    }
  }

  private async enterConflict(runtime: TaskRuntime): Promise<void> {
    const conflict = await this.buildConflictInfo(runtime)
    this.assertRunActive(runtime)
    this.applyTask(runtime, {
      status: 'waitingForConflictResolution',
      conflict,
      conflictPolicy: null,
      speedBytesPerSecond: null,
      progress: null,
    })
  }

  private async buildConflictInfo(runtime: TaskRuntime): Promise<TransferConflictInfo> {
    const task = runtime.task
    const isUpload = task.direction === 'upload'
    const directory = isUpload ? runtime.remoteDirectory : runtime.localDirectory
    if (!directory) {
      throw new TransferTaskError('destination-unavailable', '目标目录信息不可用。')
    }
    const originalName = isUpload
      ? remotePathName(task.destinationPath)
      : basename(task.destinationPath)
    const maxLength = isUpload ? MAX_NAME_LENGTH : MAX_LOCAL_NAME_LENGTH

    for (let index = 1; index <= MAX_SUGGESTION_ATTEMPTS; index += 1) {
      const suggestedName = appendNameSuffix(originalName, index, maxLength)
      const nameError = isUpload
        ? getRemoteEntryNameError(suggestedName)
        : getLocalFileNameError(suggestedName)
      if (nameError) continue
      const suggestedPath = isUpload
        ? joinRemotePath(directory, suggestedName)
        : join(directory, suggestedName)
      const taken = isUpload
        ? (await this.statRemoteOrNull(task.sessionId, suggestedPath)) !== null
        : await this.localPathExists(suggestedPath)
      this.assertRunActive(runtime)
      if (!taken) {
        return {
          targetPath: task.destinationPath,
          suggestedName,
          suggestedPath,
        }
      }
    }

    const fallback = appendNameSuffix(originalName, Date.now() % 1_000_000, maxLength)
    return {
      targetPath: task.destinationPath,
      suggestedName: fallback,
      suggestedPath: isUpload ? joinRemotePath(directory, fallback) : join(directory, fallback),
    }
  }

  private async localPathExists(path: string): Promise<boolean> {
    try {
      await fsp.lstat(path)
      return true
    } catch (error) {
      return toLocalErrorCode(error) !== 'ENOENT'
    }
  }

  private createCounter(runtime: TaskRuntime): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        if (!this.isCurrent(runtime)) {
          callback(new TransferAbortError('cancelled'))
          return
        }
        runtime.bytesTransferred += chunk.length
        const at = Date.now()
        runtime.samples.push({ at, bytes: runtime.bytesTransferred })
        if (runtime.samples.length > 120) runtime.samples.shift()
        this.armWatchdog(runtime)
        this.updateProgress(runtime)
        callback(null, chunk)
      },
    })
  }

  private updateProgress(runtime: TaskRuntime, force = false): void {
    if (!this.isCurrent(runtime) || runtime.task.status !== 'transferring') return
    const nowMs = Date.now()
    if (!force && nowMs - runtime.lastEmitAt < this.progressIntervalMs) return
    runtime.lastEmitAt = nowMs

    const cutoff = nowMs - SPEED_WINDOW_MS
    const first = runtime.samples[0]
    const last = runtime.samples[runtime.samples.length - 1]
    let speed: number | null = null
    if (first && last && first !== last && last.at - first.at >= 250 && last.at >= cutoff) {
      speed = Math.round(((last.bytes - first.bytes) * 1000) / (last.at - first.at))
      if (!Number.isFinite(speed) || speed < 0) speed = null
    }

    const percent = computeProgress(runtime.task.totalBytes, runtime.bytesTransferred)
    this.applyTask(runtime, {
      transferredBytes: runtime.bytesTransferred,
      // Never claim 100% before the temp file has been committed.
      progress: percent === null ? null : Math.min(percent, 99),
      speedBytesPerSecond: speed,
    })
  }

  private armWatchdog(runtime: TaskRuntime): void {
    this.stopWatchdog(runtime)
    const timer = setTimeout(() => {
      if (!this.isCurrent(runtime)) return
      this.abortRuntime(runtime, new AppOperationError('timeout', '传输长时间没有数据，已停止。'))
    }, this.inactivityTimeoutMs)
    timer.unref?.()
    runtime.watchdog = timer
  }

  private stopWatchdog(runtime: TaskRuntime): void {
    if (runtime.watchdog) {
      clearTimeout(runtime.watchdog)
      runtime.watchdog = null
    }
  }

  private clearSettleTimer(runtime: TaskRuntime): void {
    if (runtime.settleTimer) {
      clearTimeout(runtime.settleTimer)
      runtime.settleTimer = null
    }
  }

  private abortRuntime(runtime: TaskRuntime, cause: Error): void {
    if (!this.isCurrent(runtime) || runtime.finalized) return
    runtime.abortCause ??= cause
    this.destroyRuntimeStreams(runtime)
    if (runtime.settleTimer) return
    const timer = setTimeout(() => {
      void this.forceFinalize(runtime)
    }, this.abortSettleTimeoutMs)
    timer.unref?.()
    runtime.settleTimer = timer
  }

  private async forceFinalize(runtime: TaskRuntime): Promise<void> {
    if (!this.isCurrent(runtime) || runtime.finalized) return
    this.stopWatchdog(runtime)
    this.clearSettleTimer(runtime)
    const cause =
      runtime.abortCause ?? new AppOperationError('timeout', '传输未能及时停止，已终止任务。')
    const failure = mapTransferFailure(cause, runtime.task.direction, runtime.stage)
    if (failure.code === 'cancelled') {
      this.applyTerminal(runtime, {
        status: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: `${failure.message} 临时文件可能未完全清理。`,
      })
    } else {
      this.applyTerminal(runtime, {
        status: 'failed',
        errorCode: failure.code,
        errorMessage: `${failure.message} 临时文件可能未完全清理。`,
      })
    }
    this.detachRuntime(runtime)
    void this.cleanupRuntime(runtime)
  }

  private async finishFailed(runtime: TaskRuntime, error: unknown): Promise<void> {
    if (!this.isCurrent(runtime) || runtime.finalized) return
    this.stopWatchdog(runtime)
    this.clearSettleTimer(runtime)
    const note = await this.cleanupRuntime(runtime)
    if (!this.isCurrent(runtime) || runtime.finalized) return

    const source = runtime.abortCause ?? error
    const failure: TransferFailure = mapTransferFailure(
      source,
      runtime.task.direction,
      runtime.stage,
    )

    if (failure.code === 'cancelled') {
      this.applyTerminal(runtime, {
        status: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: this.appendNote(failure.message, note),
      })
      return
    }
    this.applyTerminal(runtime, {
      status: 'failed',
      errorCode: failure.code,
      errorMessage: this.appendNote(failure.message, note),
    })
  }

  private finishCompleted(runtime: TaskRuntime): void {
    if (!this.isCurrent(runtime) || runtime.finalized) return
    const total = runtime.task.totalBytes
    this.applyTerminal(runtime, {
      status: 'completed',
      transferredBytes: runtime.bytesTransferred,
      progress: total === null ? null : 100,
      errorCode: runtime.completionWarning ? 'cleanup-failed' : null,
      errorMessage: runtime.completionWarning,
      conflict: null,
    })
  }

  private applyTerminal(
    runtime: TaskRuntime,
    patch: Partial<TransferTask> & { status: 'completed' | 'failed' | 'cancelled' },
  ): void {
    if (!this.isCurrent(runtime) || runtime.finalized) return
    this.applyTask(runtime, {
      speedBytesPerSecond: null,
      completedAt: this.now().toISOString(),
      transferredBytes: runtime.bytesTransferred,
      progress:
        patch.status === 'completed'
          ? runtime.task.totalBytes === null
            ? null
            : 100
          : computeProgress(runtime.task.totalBytes, runtime.bytesTransferred),
      ...patch,
    })
    runtime.finalized = true
  }

  private finalizeImmediately(
    runtime: TaskRuntime,
    patch: Partial<TransferTask> & { status: 'cancelled' | 'failed' | 'skipped' },
  ): void {
    if (!this.isCurrent(runtime) || runtime.finalized) return
    this.applyTask(runtime, {
      speedBytesPerSecond: null,
      completedAt: this.now().toISOString(),
      progress: computeProgress(runtime.task.totalBytes, runtime.bytesTransferred),
      ...patch,
    })
    runtime.finalized = true
    this.detachRuntime(runtime)
  }

  private detachRuntime(runtime: TaskRuntime): void {
    if (this.runtimes.get(runtime.task.id) !== runtime) return
    this.releaseSlot(runtime)
    this.runtimes.delete(runtime.task.id)
    this.schedule()
  }

  private releaseSlot(runtime: TaskRuntime): void {
    if (!runtime.activeSlot) return
    runtime.activeSlot = false
    this.queue.release(runtime.task.id)
  }

  private async cleanupRuntime(runtime: TaskRuntime): Promise<string | null> {
    if (runtime.cleanupStarted) return runtime.cleanupNote
    runtime.cleanupStarted = true
    this.destroyRuntimeStreams(runtime)

    const streams = [runtime.sourceStream, runtime.destinationStream].filter(
      (stream): stream is Readable | Writable => Boolean(stream),
    )
    if (streams.length > 0) {
      await withTimeout(
        Promise.all(streams.map((stream) => trackClose(stream))),
        Math.min(this.cleanupTimeoutMs, 2_000),
        '等待传输流关闭超时。',
      ).catch(() => undefined)
    }

    let failed = false
    const tempPath = runtime.tempPath
    if (tempPath && runtime.remoteTempCreated) {
      try {
        await withTimeout(
          this.dependencies.sftp.removeTransferFile(runtime.task.sessionId, tempPath),
          this.cleanupTimeoutMs,
          '清理远程临时文件超时。',
        )
      } catch {
        failed = true
      }
    }
    if (tempPath && runtime.localTempCreated && isTransferTempName(basename(tempPath))) {
      try {
        await fsp.unlink(tempPath)
      } catch (error) {
        if (toLocalErrorCode(error) !== 'ENOENT') failed = true
      }
    }

    runtime.remoteTempCreated = false
    runtime.localTempCreated = false
    runtime.tempPath = null
    runtime.cleanupNote = failed ? '临时文件可能未能完全清理，请检查目标目录。' : null
    return runtime.cleanupNote
  }

  private destroyRuntimeStreams(runtime: TaskRuntime): void {
    for (const stream of [runtime.sourceStream, runtime.destinationStream]) {
      if (!stream || stream.destroyed) continue
      try {
        stream.destroy()
      } catch {
        // The stream is already unusable.
      }
    }
  }

  private assertRunActive(runtime: TaskRuntime): void {
    if (!this.isCurrent(runtime) || runtime.finalized) {
      throw new TransferAbortError('cancelled')
    }
    if (runtime.cancelRequested) {
      throw runtime.abortCause ?? new TransferAbortError('cancelled')
    }
    if (runtime.abortCause) {
      throw runtime.abortCause
    }
  }

  private isCurrent(runtime: TaskRuntime): boolean {
    return this.runtimes.get(runtime.task.id) === runtime
  }

  private async assertRemoteDirectory(sessionId: string, directory: string): Promise<void> {
    let entry: RemoteFileEntry
    try {
      entry = await this.dependencies.sftp.statRemote(sessionId, directory)
    } catch (error) {
      if (
        error instanceof AppOperationError &&
        (error.code === 'unavailable' ||
          error.code === 'permission-denied' ||
          error.code === 'outcome-unknown' ||
          error.code === 'timeout')
      ) {
        throw error
      }
      throw new TransferTaskError(
        'destination-unavailable',
        '远程目标目录已不可用，请刷新 SFTP 目录后重试。',
      )
    }
    if (entry.kind !== 'directory') {
      throw new TransferTaskError('destination-unavailable', '远程目标不是目录。')
    }
  }

  /**
   * Prepares the remote directory chain for an upload target. Existing
   * ancestors are verified to be directories; missing ones are created
   * top-down. A file blocking the chain or an over-deep path aborts with a
   * truthful error instead of being worked around.
   */
  private async ensureRemoteDirectory(runtime: TaskRuntime, directory: string): Promise<void> {
    const sessionId = runtime.task.sessionId
    const missing: string[] = []
    let current = directory
    while (current !== '/') {
      this.assertRunActive(runtime)
      const existing = await this.statRemoteOrNull(sessionId, current)
      if (existing) {
        if (existing.kind !== 'directory') {
          throw new TransferTaskError(
            'destination-unavailable',
            '远程目标路径中存在同名文件，无法创建目录；请调整后重试。',
          )
        }
        break
      }
      missing.push(current)
      if (missing.length > MAX_REMOTE_ENSURE_DEPTH) {
        throw new TransferTaskError(
          'destination-unavailable',
          '远程目录层级过深，无法自动创建；请改用更浅的目标目录。',
        )
      }
      current = remoteParentPath(current)
    }

    for (const target of [...missing].reverse()) {
      this.assertRunActive(runtime)
      try {
        await this.dependencies.sftp.mkdir(
          sessionId,
          remoteParentPath(target),
          remotePathName(target),
        )
      } catch (error) {
        if (error instanceof AppOperationError && error.code === 'already-exists') {
          // Another client created it between the check and mkdir; the
          // directory now exists, which is the desired end state.
          continue
        }
        if (
          error instanceof AppOperationError &&
          (error.code === 'unavailable' ||
            error.code === 'outcome-unknown' ||
            error.code === 'timeout' ||
            error.code === 'permission-denied')
        ) {
          throw error
        }
        throw new TransferTaskError(
          'destination-unavailable',
          '无法在远程创建所需的目录结构，请检查权限后重试。',
        )
      }
    }
  }

  private async assertLocalDirectory(directory: string): Promise<void> {
    let stats: Stats
    try {
      stats = await fsp.stat(directory)
    } catch {
      throw new TransferTaskError('destination-unavailable', '本地目标目录不存在或无法访问。')
    }
    if (!stats.isDirectory()) {
      throw new TransferTaskError('destination-unavailable', '本地目标不是目录。')
    }
  }

  private async statRemoteOrNull(sessionId: string, path: string): Promise<RemoteFileEntry | null> {
    try {
      return await this.dependencies.sftp.statRemote(sessionId, path)
    } catch (error) {
      if (error instanceof AppOperationError && error.code === 'not-found') return null
      throw error
    }
  }

  private localSourceFailure(error: unknown): TransferTaskError {
    const failure = mapTransferFailure(error, 'upload', 'source')
    return new TransferTaskError(failure.code, failure.message)
  }

  private asEnqueueFailure(error: unknown): AppOperationError {
    if (error instanceof AppOperationError) return error
    if (error instanceof TransferTaskError) {
      return new AppOperationError(
        error.code === 'destination-unavailable' ? 'unavailable' : 'internal',
        error.message,
      )
    }
    return new AppOperationError('internal', '无法开始传输，请稍后重试。')
  }

  private requireTask(transferId: string): TransferTask {
    const task = this.tasks.get(transferId)
    if (!task) {
      throw new AppOperationError('not-found', '传输任务不存在或已从历史记录中清除。')
    }
    return task
  }

  private requireRuntime(transferId: string): TaskRuntime {
    const runtime = this.runtimes.get(transferId)
    if (!runtime) {
      throw new AppOperationError('conflict', '传输任务正在收尾，请稍候再试。')
    }
    return runtime
  }

  private applyTask(runtime: TaskRuntime, patch: Partial<TransferTask>): void {
    if (!this.isCurrent(runtime)) return
    if (runtime.finalized) return
    const next: TransferTask = {
      ...runtime.task,
      ...patch,
      revision: runtime.task.revision + 1,
    }
    runtime.task = next
    this.tasks.set(next.id, next)
    this.emit(next)
    this.scheduleJournalWrite()
  }

  private emit(task: TransferTask): void {
    if (this.disposed) return
    this.dependencies.emitUpdate({ task: this.snapshot(task) })
  }

  private snapshot(task: TransferTask): TransferTask {
    return {
      ...task,
      conflict: task.conflict ? { ...task.conflict } : null,
    }
  }

  private appendNote(message: string, note: string | null): string {
    return note ? `${message} ${note}` : message
  }

  private async openPicker<T>(pick: () => Promise<T>): Promise<T> {
    if (this.pickerActive) {
      throw new AppOperationError('conflict', '文件选择对话框已打开，请完成当前选择后再试。')
    }
    this.pickerActive = true
    try {
      return await pick()
    } finally {
      this.pickerActive = false
    }
  }

  private async hydrateJournal(): Promise<void> {
    if (!this.journalPath) return

    let raw: unknown
    try {
      raw = await readJsonFile(this.journalPath, '传输任务日志')
    } catch {
      return
    }
    if (raw === null) return
    const parsed = transferJournalSchema.safeParse(raw)
    if (!parsed.success) return

    let recovered = 0
    for (const record of parsed.data.tasks) {
      if (this.tasks.has(record.id)) continue
      const task: TransferTask = {
        id: record.id,
        sessionId: record.sessionId,
        direction: record.direction,
        fileName: record.fileName,
        sourcePath: record.sourcePath,
        destinationPath: record.destinationPath,
        status: 'interrupted',
        totalBytes: record.totalBytes,
        transferredBytes: record.transferredBytes,
        progress: record.progress,
        speedBytesPerSecond: null,
        errorCode: 'outcome-unknown',
        errorMessage:
          record.status === 'interrupted'
            ? '该任务在之前的应用会话中未能确认结果；没有自动继续，也没有标记为完成。'
            : '上次应用退出时该任务尚未完成，服务器上的实际状态未知；没有自动继续，也没有标记为完成。',
        createdAt: record.createdAt,
        startedAt: null,
        completedAt: null,
        attempt: record.attempt,
        conflictPolicy: null,
        conflict: null,
        revision: record.revision + 1,
      }
      this.tasks.set(task.id, task)
      recovered += 1
    }

    if (recovered > 0) {
      this.dependencies.onNotice?.('journal-recovered', { count: recovered })
      this.scheduleJournalWrite()
    }
  }

  private scheduleJournalWrite(): void {
    if (!this.journalPath || this.journalTimer) return
    const timer = setTimeout(() => {
      this.journalTimer = null
      void this.flushJournal()
    }, 250)
    timer.unref?.()
    this.journalTimer = timer
  }

  private flushJournal(): Promise<void> {
    if (!this.journalPath) return Promise.resolve()
    if (this.journalTimer) {
      clearTimeout(this.journalTimer)
      this.journalTimer = null
    }

    const path = this.journalPath
    try {
      const tasks: TransferJournalRecord[] = [...this.tasks.values()]
        .filter((task) => isActiveTransferStatus(task.status) || task.status === 'interrupted')
        .slice(-MAX_JOURNAL_TASKS)
        .map((task) => ({
          id: task.id,
          sessionId: task.sessionId,
          direction: task.direction,
          fileName: task.fileName,
          sourcePath: task.sourcePath,
          destinationPath: task.destinationPath,
          status: task.status as TransferJournalRecord['status'],
          totalBytes: task.totalBytes,
          transferredBytes: task.transferredBytes,
          progress: task.progress,
          createdAt: task.createdAt,
          attempt: task.attempt,
          revision: task.revision,
        }))
      const envelope = transferJournalSchema.parse({
        version: TRANSFER_JOURNAL_VERSION,
        tasks,
      })
      const write = this.journalChain.then(() =>
        writeJsonFileAtomic(path, envelope, '传输任务日志'),
      )
      this.journalChain = write.catch(() => undefined)
    } catch {
      // A malformed in-memory snapshot must never break transfer cleanup.
    }
    return this.journalChain
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new AppOperationError('unavailable', '应用正在退出，无法开始新的传输。')
    }
  }
}
