import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import { AppOperationError } from '../../errors'
import {
  getRemoteEntryNameError,
  getRemotePathError,
  isRootRemotePath,
  joinRemotePath,
  normalizeRemotePath,
  remoteParentPath,
  remotePathName,
} from '../../../shared/sftp/remotePath'
import {
  sftpCloseInputSchema,
  sftpDeleteInputSchema,
  sftpListInputSchema,
  sftpMkdirInputSchema,
  sftpOpenInputSchema,
  sftpReadTextFileInputSchema,
  sftpRenameInputSchema,
  sftpStatInputSchema,
  sftpWriteTextFileInputSchema,
} from '../../../shared/schemas/sftp'
import {
  MAX_REMOTE_TEXT_FILE_BYTES,
  decodeRemoteText,
  encodeRemoteText,
} from '../../../shared/sftp/remoteText'
import type {
  RemoteDirectoryListing,
  RemoteFileEntry,
  RemoteTextFile,
  SftpCloseAck,
  SftpMutationAck,
  SftpOpenResult,
  SftpTextWriteAck,
  SftpTextWriteInput,
} from '../../../shared/types/sftp'
import {
  isTransferTempName,
  TRANSFER_BACKUP_PREFIX,
  TRANSFER_TEMP_PREFIX,
} from '../../../shared/transfer/transferFiles'
import type { SshClientLike } from '../ssh/SshService'
import { isSafeEntryName, mapRemoteDirectoryEntries, mapRemoteStatEntry } from './sftpMetadata'

export interface SftpServiceDependencies {
  /**
   * Main-process-only lookup. It validates that the session exists and is
   * currently connected before returning the owning SSH client.
   */
  acquireClient: (sessionId: string) => SshClientLike
  now?: () => Date
  openTimeoutMs?: number
  operationTimeoutMs?: number
}

export interface SftpServicePort {
  open(sessionId: string): Promise<SftpOpenResult>
  list(sessionId: string, path: string): Promise<RemoteDirectoryListing>
  stat(sessionId: string, path: string): Promise<RemoteFileEntry>
  mkdir(sessionId: string, parentPath: string, name: string): Promise<SftpMutationAck>
  rename(sessionId: string, sourcePath: string, targetPath: string): Promise<SftpMutationAck>
  deleteFile(sessionId: string, path: string): Promise<SftpMutationAck>
  removeDirectory(sessionId: string, path: string): Promise<SftpMutationAck>
  readTextFile(sessionId: string, path: string): Promise<RemoteTextFile>
  writeTextFile(input: SftpTextWriteInput): Promise<SftpTextWriteAck>
  close(sessionId: string): Promise<SftpCloseAck>
}

export interface RemoteCommitResult {
  targetPath: string
  replacedExisting: boolean
  /** The old target was moved aside, but its backup could not be removed. */
  backupCleanupFailed: boolean
}

/**
 * Main-process-only SFTP surface used by the transfer engine. Streams and
 * wrappers never cross IPC; the renderer only sees task snapshots.
 */
export interface SftpTransferPort {
  probe(sessionId: string): Promise<void>
  statRemote(sessionId: string, path: string): Promise<RemoteFileEntry>
  /** Used to create missing remote subdirectories for directory uploads. */
  mkdir(sessionId: string, parentPath: string, name: string): Promise<SftpMutationAck>
  openTransferReadStream(sessionId: string, path: string): Promise<Readable>
  openTransferWriteStream(sessionId: string, path: string): Promise<Writable>
  commitRemoteUpload(
    sessionId: string,
    tempPath: string,
    targetPath: string,
    overwrite: boolean,
  ): Promise<RemoteCommitResult>
  removeTransferFile(sessionId: string, path: string): Promise<void>
}

const DEFAULT_OPEN_TIMEOUT_MS = 15_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const MIN_SAFE_DIRECTORY_DEPTH = 2

const PROTECTED_DIRECTORY_ROOTS = new Set([
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
])

interface PendingCall {
  mutation: boolean
  fail: (error: AppOperationError) => void
}

interface SessionState {
  sessionId: string
  channel: SFTPWrapper | null
  opening: Promise<SFTPWrapper> | null
  homeOpening: Promise<string> | null
  pending: Set<PendingCall>
  locks: Set<string>
  homePath: string | null
  closed: boolean
}

function readErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' && Number.isFinite(code) ? code : null
}

function readNativeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function textRevision(stats: Pick<Stats, 'size' | 'mtime'>): string {
  const size = typeof stats.size === 'number' && Number.isFinite(stats.size) ? Math.trunc(stats.size) : -1
  const mtime =
    typeof stats.mtime === 'number' && Number.isFinite(stats.mtime) ? Math.trunc(stats.mtime) : -1
  return `${mtime}:${size}`
}

function safeDestroy(wrapper: SFTPWrapper): void {
  try {
    wrapper.destroy()
  } catch {
    // The channel is already gone.
  }
}

function safeEnd(wrapper: SFTPWrapper): void {
  try {
    wrapper.end()
  } catch {
    safeDestroy(wrapper)
  }
}

/**
 * Owns SFTP channels in the main process, one reusable channel per SSH
 * session. Nothing here ever crosses IPC: the renderer only names an existing
 * SSH session and receives plain directory metadata.
 */
export class SftpService implements SftpServicePort, SftpTransferPort {
  private readonly sessions = new Map<string, SessionState>()
  private readonly now: () => Date
  private readonly openTimeoutMs: number
  private readonly operationTimeoutMs: number
  private disposed = false

  constructor(private readonly dependencies: SftpServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.openTimeoutMs = dependencies.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    this.operationTimeoutMs = dependencies.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  }

  async open(rawSessionId: string): Promise<SftpOpenResult> {
    const parsed = sftpOpenInputSchema.safeParse({ sessionId: rawSessionId })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', 'SSH 会话 ID 格式无效。')
    }
    this.assertUsable()
    const state = this.ensureState(parsed.data.sessionId)

    try {
      await this.acquireChannel(state)
      if (!state.homePath) {
        state.homeOpening ??= this.resolveHome(state)
        try {
          state.homePath = await state.homeOpening
        } finally {
          state.homeOpening = null
        }
      }
      return { sessionId: state.sessionId, homePath: state.homePath }
    } catch (error) {
      this.forgetIfIdle(state)
      throw error
    }
  }

  async list(rawSessionId: string, rawPath: string): Promise<RemoteDirectoryListing> {
    const parsed = sftpListInputSchema.safeParse({
      sessionId: rawSessionId,
      path: rawPath,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '目录路径未通过校验。')
    }
    this.assertUsable()
    const path = normalizeRemotePath(parsed.data.path)
    const state = this.ensureState(parsed.data.sessionId)

    try {
      const entries = await this.execute<FileEntryWithStats[]>(
        state,
        '读取目录',
        false,
        (wrapper, done) => wrapper.readdir(path, done),
      )
      return {
        sessionId: state.sessionId,
        path,
        entries: mapRemoteDirectoryEntries(path, entries),
        loadedAt: this.now().toISOString(),
      }
    } catch (error) {
      this.forgetIfIdle(state)
      throw error
    }
  }

  async stat(rawSessionId: string, rawPath: string): Promise<RemoteFileEntry> {
    const parsed = sftpStatInputSchema.safeParse({
      sessionId: rawSessionId,
      path: rawPath,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '远程路径未通过校验。')
    }
    this.assertUsable()
    const path = normalizeRemotePath(parsed.data.path)
    const state = this.ensureState(parsed.data.sessionId)

    try {
      const stats = await this.execute<Stats>(state, '读取文件信息', false, (wrapper, done) =>
        wrapper.lstat(path, done),
      )
      if (!stats) {
        throw new AppOperationError('internal', '服务器未返回该路径的文件信息。')
      }
      return mapRemoteStatEntry(path, stats)
    } catch (error) {
      this.forgetIfIdle(state)
      throw error
    }
  }

  async probe(rawSessionId: string): Promise<void> {
    const parsed = sftpOpenInputSchema.safeParse({ sessionId: rawSessionId })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', 'SSH 会话 ID 格式无效。')
    }
    this.assertUsable()
    const state = this.ensureState(parsed.data.sessionId)
    try {
      await this.acquireChannel(state)
    } catch (error) {
      this.forgetIfIdle(state)
      throw error
    }
  }

  async statRemote(rawSessionId: string, rawPath: string): Promise<RemoteFileEntry> {
    return this.stat(rawSessionId, rawPath)
  }

  async openTransferReadStream(rawSessionId: string, rawPath: string): Promise<Readable> {
    const parsed = sftpStatInputSchema.safeParse({ sessionId: rawSessionId, path: rawPath })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '远程源文件路径未通过校验。')
    }
    this.assertUsable()
    const path = normalizeRemotePath(parsed.data.path)
    const state = this.ensureState(parsed.data.sessionId)
    try {
      const wrapper = await this.acquireChannel(state)
      const stream = wrapper.createReadStream(path)
      // The transfer engine owns error handling; keep an early failure from
      // becoming an unhandled stream error in the short window before pipeline.
      stream.on('error', () => undefined)
      return stream
    } catch (error) {
      this.forgetIfIdle(state)
      throw error
    }
  }

  async openTransferWriteStream(rawSessionId: string, rawPath: string): Promise<Writable> {
    const parsed = sftpStatInputSchema.safeParse({ sessionId: rawSessionId, path: rawPath })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '远程临时文件路径未通过校验。')
    }
    this.assertUsable()
    const path = normalizeRemotePath(parsed.data.path)
    if (!isTransferTempName(remotePathName(path))) {
      throw new AppOperationError('invalid-input', '拒绝写入非传输临时文件。')
    }
    const state = this.ensureState(parsed.data.sessionId)
    try {
      const wrapper = await this.acquireChannel(state)
      const stream = wrapper.createWriteStream(path, { flags: 'wx', mode: 0o600 })
      stream.on('error', () => undefined)
      return stream
    } catch (error) {
      this.forgetIfIdle(state)
      throw error
    }
  }

  /**
   * Publishes a fully written remote temp file under its final name. The target
   * is never unlinked in place: when overwriting, it is first renamed to a
   * unique backup in the same directory and restored if the commit fails.
   */
  async commitRemoteUpload(
    rawSessionId: string,
    rawTempPath: string,
    rawTargetPath: string,
    overwrite: boolean,
  ): Promise<RemoteCommitResult> {
    const parsed = sftpRenameInputSchema.safeParse({
      sessionId: rawSessionId,
      sourcePath: rawTempPath,
      targetPath: rawTargetPath,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '提交上传文件参数未通过校验。')
    }
    if (typeof overwrite !== 'boolean') {
      throw new AppOperationError('invalid-input', '覆盖策略参数无效。')
    }
    this.assertUsable()
    const tempPath = normalizeRemotePath(parsed.data.sourcePath)
    const targetPath = normalizeRemotePath(parsed.data.targetPath)
    if (!isTransferTempName(remotePathName(tempPath))) {
      throw new AppOperationError('invalid-input', '拒绝提交非传输临时文件。')
    }
    if (isRootRemotePath(tempPath) || isRootRemotePath(targetPath)) {
      throw new AppOperationError('invalid-input', '远程根目录不能作为传输目标。')
    }
    const parent = remoteParentPath(tempPath)
    if (parent !== remoteParentPath(targetPath)) {
      throw new AppOperationError(
        'invalid-input',
        '临时文件必须与目标位于同一目录，才能安全提交。',
      )
    }

    const state = this.ensureState(parsed.data.sessionId)
    return this.withLocks(state, [tempPath, targetPath], async () => {
      const tempStats = await this.lstatIfExists(state, tempPath)
      if (!tempStats) {
        throw new AppOperationError('not-found', '上传临时文件已不存在，无法提交。')
      }
      if (this.isDirectoryStats(tempStats) || this.isSymlinkStats(tempStats)) {
        throw new AppOperationError('not-a-file', '上传临时路径不是普通文件，拒绝提交。')
      }

      const targetStats = await this.lstatIfExists(state, targetPath)
      let backupPath: string | null = null
      if (targetStats) {
        if (!overwrite) {
          throw new AppOperationError('already-exists', '目标文件已存在，未覆盖现有文件。')
        }
        if (this.isDirectoryStats(targetStats)) {
          throw new AppOperationError('not-a-file', '目标已存在且是目录，拒绝覆盖。')
        }
        if (this.isSymlinkStats(targetStats)) {
          throw new AppOperationError(
            'conflict',
            '目标是符号链接，拒绝通过上传替换；请先确认目标后重试。',
          )
        }
        backupPath = joinRemotePath(parent, `${TRANSFER_BACKUP_PREFIX}${randomUUID()}`)
        await this.execute<undefined>(state, '暂存原目标文件', true, (wrapper, done) =>
          wrapper.rename(targetPath, backupPath as string, (error) => {
            done(error)
          }),
        )
      }

      try {
        await this.execute<undefined>(state, '提交上传文件', true, (wrapper, done) =>
          wrapper.rename(tempPath, targetPath, (error) => {
            done(error)
          }),
        )
      } catch (error) {
        if (backupPath) {
          try {
            await this.execute<undefined>(state, '恢复原目标文件', true, (wrapper, done) =>
              wrapper.rename(backupPath as string, targetPath, (renameError) => {
                done(renameError)
              }),
            )
          } catch {
            throw new AppOperationError(
              'outcome-unknown',
              '上传未能完成，且无法恢复原目标文件；原文件可能以备份名称保留，请刷新目录核实。',
            )
          }
        }
        throw error
      }

      let backupCleanupFailed = false
      if (backupPath) {
        try {
          await this.execute<undefined>(state, '清理目标备份', true, (wrapper, done) =>
            wrapper.unlink(backupPath as string, (error) => {
              done(error)
            }),
          )
        } catch {
          backupCleanupFailed = true
        }
      }

      return {
        targetPath,
        replacedExisting: Boolean(targetStats),
        backupCleanupFailed,
      }
    })
  }

  async removeTransferFile(rawSessionId: string, rawPath: string): Promise<void> {
    const parsed = sftpDeleteInputSchema.safeParse({ sessionId: rawSessionId, path: rawPath })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '临时文件路径未通过校验。')
    }
    this.assertUsable()
    const path = normalizeRemotePath(parsed.data.path)
    if (!isTransferTempName(remotePathName(path))) {
      throw new AppOperationError('invalid-input', '拒绝清理非传输临时文件。')
    }
    const state = this.ensureState(parsed.data.sessionId)
    await this.withLocks(state, [path], async () => {
      const stats = await this.lstatIfExists(state, path)
      if (!stats) return
      if (this.isDirectoryStats(stats)) {
        throw new AppOperationError('not-a-file', '临时路径不是文件，拒绝删除。')
      }
      await this.execute<undefined>(state, '清理上传临时文件', true, (wrapper, done) =>
        wrapper.unlink(path, (error) => {
          done(error)
        }),
      )
    })
  }

  async mkdir(
    rawSessionId: string,
    rawParentPath: string,
    rawName: string,
  ): Promise<SftpMutationAck> {
    const parsed = sftpMkdirInputSchema.safeParse({
      sessionId: rawSessionId,
      parentPath: rawParentPath,
      name: rawName,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '新建目录参数未通过校验。')
    }
    this.assertUsable()
    const parentPath = normalizeRemotePath(parsed.data.parentPath)
    const targetPath = joinRemotePath(parentPath, parsed.data.name)
    const state = this.ensureState(parsed.data.sessionId)

    return this.withLocks(state, [targetPath], async () => {
      const existing = await this.lstatIfExists(state, targetPath)
      if (existing) {
        throw new AppOperationError('already-exists', '同名文件或目录已存在，未创建目录。')
      }
      await this.execute<undefined>(state, '创建目录', true, (wrapper, done) =>
        wrapper.mkdir(targetPath, (error) => {
          done(error)
        }),
      )
      return {
        sessionId: state.sessionId,
        path: targetPath,
        operation: 'mkdir',
      }
    })
  }

  async rename(
    rawSessionId: string,
    rawSourcePath: string,
    rawTargetPath: string,
  ): Promise<SftpMutationAck> {
    const parsed = sftpRenameInputSchema.safeParse({
      sessionId: rawSessionId,
      sourcePath: rawSourcePath,
      targetPath: rawTargetPath,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '重命名参数未通过校验。')
    }
    this.assertUsable()
    const sourcePath = normalizeRemotePath(parsed.data.sourcePath)
    const targetPath = normalizeRemotePath(parsed.data.targetPath)
    const targetName = targetPath.slice(targetPath.lastIndexOf('/') + 1)

    if (sourcePath === targetPath) {
      throw new AppOperationError('invalid-input', '新名称与原名相同，未执行重命名。')
    }
    if (isRootRemotePath(sourcePath) || isRootRemotePath(targetPath)) {
      throw new AppOperationError('invalid-input', '不能重命名远程根目录。')
    }
    if (getRemoteEntryNameError(targetName)) {
      throw new AppOperationError('invalid-input', '重命名目标名称无效。')
    }
    if (getRemotePathError(targetPath)) {
      throw new AppOperationError('invalid-input', '重命名目标路径无效。')
    }

    const state = this.ensureState(parsed.data.sessionId)
    return this.withLocks(state, [sourcePath, targetPath], async () => {
      const source = await this.lstatIfExists(state, sourcePath)
      if (!source) {
        throw new AppOperationError('not-found', '源文件或目录不存在，未执行重命名。')
      }
      const target = await this.lstatIfExists(state, targetPath)
      if (target) {
        throw new AppOperationError('already-exists', '目标名称已被占用，未覆盖现有文件或目录。')
      }

      await this.execute<undefined>(state, '重命名', true, (wrapper, done) =>
        wrapper.rename(sourcePath, targetPath, (error) => {
          done(error)
        }),
      )
      return {
        sessionId: state.sessionId,
        path: targetPath,
        operation: 'rename',
      }
    })
  }

  async deleteFile(rawSessionId: string, rawPath: string): Promise<SftpMutationAck> {
    const parsed = sftpDeleteInputSchema.safeParse({
      sessionId: rawSessionId,
      path: rawPath,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '删除文件参数未通过校验。')
    }
    this.assertUsable()
    const path = normalizeRemotePath(parsed.data.path)
    if (isRootRemotePath(path)) {
      throw new AppOperationError('invalid-input', '远程根目录不能作为删除目标。')
    }

    const state = this.ensureState(parsed.data.sessionId)
    return this.withLocks(state, [path], async () => {
      const stats = await this.lstatIfExists(state, path)
      if (!stats) {
        throw new AppOperationError('not-found', '要删除的路径不存在，可能已被移除。')
      }
      if (this.isDirectoryStats(stats)) {
        throw new AppOperationError(
          'not-a-file',
          '目标是目录，未执行删除；目录需使用安全的目录删除操作。',
        )
      }

      await this.execute<undefined>(state, '删除文件', true, (wrapper, done) =>
        wrapper.unlink(path, (error) => {
          done(error)
        }),
      )
      return {
        sessionId: state.sessionId,
        path,
        operation: 'delete-file',
      }
    })
  }

  async removeDirectory(rawSessionId: string, rawPath: string): Promise<SftpMutationAck> {
    const parsed = sftpDeleteInputSchema.safeParse({
      sessionId: rawSessionId,
      path: rawPath,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '删除目录参数未通过校验。')
    }
    this.assertUsable()
    const path = normalizeRemotePath(parsed.data.path)
    this.assertSafeDirectoryRemovalTarget(path)

    const state = this.ensureState(parsed.data.sessionId)
    return this.withLocks(state, [path], async () => {
      const stats = await this.lstatIfExists(state, path)
      if (!stats) {
        throw new AppOperationError('not-found', '要删除的目录不存在，可能已被移除。')
      }
      if (!this.isDirectoryStats(stats)) {
        throw new AppOperationError(
          'not-a-directory',
          '目标不是目录；删除符号链接或文件请使用文件删除操作。',
        )
      }

      const entries = await this.execute<FileEntryWithStats[]>(
        state,
        '检查目录内容',
        false,
        (wrapper, done) => wrapper.readdir(path, done),
      )
      const remaining = Array.isArray(entries)
        ? entries.filter((entry) => entry && isSafeEntryName(entry.filename))
        : []
      if (remaining.length > 0) {
        throw new AppOperationError(
          'not-empty',
          `目录仍包含 ${remaining.length} 个条目，未执行删除；本应用不会递归删除目录内容。`,
        )
      }

      await this.execute<undefined>(state, '删除目录', true, (wrapper, done) =>
        wrapper.rmdir(path, (error) => {
          done(error)
        }),
      )
      return {
        sessionId: state.sessionId,
        path,
        operation: 'remove-directory',
      }
    })
  }

  async readTextFile(rawSessionId: string, rawPath: string): Promise<RemoteTextFile> {
    const parsed = sftpReadTextFileInputSchema.safeParse({
      sessionId: rawSessionId,
      path: rawPath,
    })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '读取文本文件参数未通过校验。')
    }
    this.assertUsable()
    const path = normalizeRemotePath(parsed.data.path)
    const state = this.ensureState(parsed.data.sessionId)

    try {
      const stats = await this.lstatIfExists(state, path)
      if (!stats) {
        throw new AppOperationError('not-found', '远程文件不存在，可能已被移动或删除。')
      }
      if (this.isDirectoryStats(stats)) {
        throw new AppOperationError('not-a-file', '目标是目录，无法作为文本文件打开。')
      }
      if (this.isSymlinkStats(stats)) {
        throw new AppOperationError(
          'not-a-file',
          '目标是符号链接；为避免编辑意外目标，仅支持普通文件。',
        )
      }
      if (
        typeof stats.size === 'number' &&
        Number.isFinite(stats.size) &&
        stats.size > MAX_REMOTE_TEXT_FILE_BYTES
      ) {
        throw new AppOperationError(
          'limit-exceeded',
          `文件大小超过 ${Math.floor(MAX_REMOTE_TEXT_FILE_BYTES / 1024)} KiB 编辑上限。`,
        )
      }

      const bytes = await this.readFileBuffer(state, path)
      const decoded = decodeRemoteText(bytes)
      if (!decoded.ok) {
        const message =
          decoded.reason === 'binary'
            ? '该文件包含二进制内容，未作为文本打开。'
            : decoded.reason === 'unsupported-encoding'
              ? '暂不支持该文件编码；当前仅支持 UTF-8 与 UTF-8 BOM。'
              : '文件不是有效的 UTF-8 文本，未打开。'
        throw new AppOperationError('unsupported', message)
      }

      const entry = mapRemoteStatEntry(path, stats)
      return {
        sessionId: state.sessionId,
        path,
        content: decoded.value.content,
        encoding: decoded.value.encoding,
        eol: decoded.value.eol,
        revision: textRevision(stats),
        sizeBytes: entry.sizeBytes ?? bytes.length,
        modifiedAt: entry.modifiedAt,
        permissions: entry.permissions,
      }
    } catch (error) {
      this.forgetIfIdle(state)
      throw error
    }
  }

  async writeTextFile(rawInput: SftpTextWriteInput): Promise<SftpTextWriteAck> {
    const parsed = sftpWriteTextFileInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '保存文本文件参数未通过校验。')
    }
    this.assertUsable()
    const { sessionId, content, encoding, eol, expectedRevision, force } = parsed.data
    const path = normalizeRemotePath(parsed.data.path)
    if (isRootRemotePath(path)) {
      throw new AppOperationError('invalid-input', '远程根目录不能作为文本文件保存目标。')
    }
    const bytes = encodeRemoteText(content, encoding, eol)
    if (bytes.length > MAX_REMOTE_TEXT_FILE_BYTES) {
      throw new AppOperationError(
        'limit-exceeded',
        `文件内容超过 ${Math.floor(MAX_REMOTE_TEXT_FILE_BYTES / 1024)} KiB 编辑上限。`,
      )
    }

    const state = this.ensureState(sessionId)
    return this.withLocks(state, [path], async () => {
      const stats = await this.lstatIfExists(state, path)
      if (!stats) {
        throw new AppOperationError('not-found', '远程文件已不存在，未保存更改。')
      }
      if (this.isDirectoryStats(stats)) {
        throw new AppOperationError('not-a-file', '目标是目录，无法保存为文本文件。')
      }
      if (this.isSymlinkStats(stats)) {
        throw new AppOperationError(
          'not-a-file',
          '目标是符号链接；为避免写入意外目标，未保存更改。',
        )
      }
      if (!force && expectedRevision !== null && textRevision(stats) !== expectedRevision) {
        throw new AppOperationError(
          'conflict',
          '远程文件已被其他程序修改，未覆盖。请重新加载后再保存，或选择强制保存。',
        )
      }

      const parent = remoteParentPath(path)
      const tempPath = joinRemotePath(parent, `${TRANSFER_TEMP_PREFIX}${randomUUID()}`)
      const backupPath = joinRemotePath(parent, `${TRANSFER_BACKUP_PREFIX}${randomUUID()}`)
      const mode =
        typeof stats.mode === 'number' && stats.mode > 0 ? stats.mode & 0o7777 : 0o600
      let tempPending = false

      try {
        await this.execute<undefined>(state, '写入编辑临时文件', true, (wrapper, done) => {
          wrapper.writeFile(
            tempPath,
            Buffer.from(bytes),
            { flag: 'wx', mode },
            (error) => done(error),
          )
        })
        tempPending = true

        await this.execute<undefined>(state, '暂存原文件', true, (wrapper, done) =>
          wrapper.rename(path, backupPath, (error) => {
            done(error)
          }),
        )

        try {
          await this.execute<undefined>(state, '保存编辑结果', true, (wrapper, done) =>
            wrapper.rename(tempPath, path, (error) => {
              done(error)
            }),
          )
          tempPending = false
        } catch (error) {
          try {
            await this.execute<undefined>(state, '恢复原文件', true, (wrapper, done) =>
              wrapper.rename(backupPath, path, (renameError) => {
                done(renameError)
              }),
            )
          } catch {
            throw new AppOperationError(
              'outcome-unknown',
              '保存失败，且无法恢复原文件；服务器上可能保留了 .termforge-backup-* 备份，请刷新目录核实。',
            )
          }
          throw error
        }

        let backupCleanupFailed = false
        try {
          await this.execute<undefined>(state, '清理编辑备份', true, (wrapper, done) =>
            wrapper.unlink(backupPath, (error) => {
              done(error)
            }),
          )
        } catch {
          backupCleanupFailed = true
        }

        let updatedStats: Stats | null = null
        try {
          updatedStats = await this.lstatIfExists(state, path)
        } catch {
          updatedStats = null
        }
        const entry = updatedStats ? mapRemoteStatEntry(path, updatedStats) : null

        return {
          sessionId: state.sessionId,
          path,
          revision: updatedStats
            ? textRevision(updatedStats)
            : `${Math.floor(this.now().getTime() / 1000)}:${bytes.length}`,
          sizeBytes: bytes.length,
          modifiedAt: entry?.modifiedAt ?? null,
          backupCleanupFailed,
        }
      } finally {
        if (tempPending) {
          try {
            await this.execute<undefined>(state, '清理编辑临时文件', true, (wrapper, done) =>
              wrapper.unlink(tempPath, (error) => {
                done(error)
              }),
            )
          } catch {
            // The temp file can be cleaned up manually; never mask the save error.
          }
        }
      }
    })
  }

  async close(rawSessionId: string): Promise<SftpCloseAck> {
    const parsed = sftpCloseInputSchema.safeParse({ sessionId: rawSessionId })
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', 'SSH 会话 ID 格式无效。')
    }
    this.assertUsable()
    const state = this.sessions.get(parsed.data.sessionId)
    if (!state) return { sessionId: parsed.data.sessionId, closed: true }
    if (state.opening) {
      try {
        await state.opening
      } catch {
        // A failed open leaves no channel to close.
      }
    }
    const wrapper = state.channel
    state.channel = null
    state.homePath = null
    this.rejectPending(
      state,
      'SFTP 通道已关闭，请重新打开后再试。',
      'SFTP 通道已关闭，无法确认操作是否已在服务器上生效；请重新打开并刷新目录。',
    )
    if (wrapper) safeEnd(wrapper)
    this.forgetIfIdle(state)
    return { sessionId: state.sessionId, closed: true }
  }

  /**
   * Called by the SSH owner when a session reaches a terminal state or a tab is
   * closed. All pending SFTP work is rejected; the state is not reusable.
   */
  disposeSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    this.sessions.delete(sessionId)
    state.closed = true
    state.homePath = null
    const wrapper = state.channel
    state.channel = null
    this.rejectPending(
      state,
      'SSH 连接已断开，SFTP 请求已取消。',
      'SSH 连接已断开，无法确认操作是否已在服务器上生效；请在重新连接后刷新目录核实。',
    )
    if (wrapper) safeEnd(wrapper)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const state of this.sessions.values()) {
      state.closed = true
      const wrapper = state.channel
      state.channel = null
      this.rejectPending(
        state,
        '应用正在退出，SFTP 请求已取消。',
        '应用正在退出，无法确认操作是否已在服务器上生效。',
      )
      if (wrapper) safeEnd(wrapper)
    }
    this.sessions.clear()
  }

  private ensureState(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const state: SessionState = {
      sessionId,
      channel: null,
      opening: null,
      homeOpening: null,
      pending: new Set(),
      locks: new Set(),
      homePath: null,
      closed: false,
    }
    this.sessions.set(sessionId, state)
    return state
  }

  private resolveHome(state: SessionState): Promise<string> {
    return this.execute<string>(state, '解析远程主目录', false, (wrapper, done) =>
      wrapper.realpath('.', done),
    ).then((rawHome) => {
      if (typeof rawHome !== 'string' || !rawHome.startsWith('/')) {
        throw new AppOperationError('internal', '服务器返回了无效的远程主目录。')
      }
      return normalizeRemotePath(rawHome)
    })
  }

  private async acquireChannel(state: SessionState): Promise<SFTPWrapper> {
    if (this.disposed || state.closed) {
      throw new AppOperationError('unavailable', 'SFTP 服务已停止，无法执行该操作。')
    }
    // Validate ownership and connectivity on every operation, not only when a
    // channel happens to be opened for the first time.
    const client = this.dependencies.acquireClient(state.sessionId)
    if (state.channel) return state.channel
    if (state.opening) return state.opening

    const opening = this.openChannel(state, client)
    state.opening = opening
    try {
      return await opening
    } finally {
      if (state.opening === opening) state.opening = null
    }
  }

  private openChannel(state: SessionState, client: SshClientLike): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null

      const finish = (error: unknown, wrapper?: SFTPWrapper): void => {
        if (settled) {
          if (wrapper) safeDestroy(wrapper)
          return
        }
        settled = true
        if (timer) clearTimeout(timer)
        if (error || !wrapper || state.closed || this.disposed) {
          if (wrapper) safeDestroy(wrapper)
          if (state.closed || this.disposed) {
            reject(new AppOperationError('unavailable', 'SFTP 会话已释放。'))
          } else {
            reject(this.mapError(error, '打开 SFTP 通道', false))
          }
          return
        }

        state.channel = wrapper
        try {
          wrapper.on('close', () => this.handleChannelLoss(state, wrapper))
          wrapper.on('error', () => {
            this.handleChannelLoss(state, wrapper)
            safeDestroy(wrapper)
          })
        } catch {
          state.channel = null
          safeDestroy(wrapper)
          reject(new AppOperationError('unavailable', 'SFTP 通道无法建立。'))
          return
        }
        resolve(wrapper)
      }

      timer = setTimeout(() => {
        finish(new AppOperationError('timeout', '打开 SFTP 通道超时，请稍后重试。'))
      }, this.openTimeoutMs)
      timer.unref?.()

      try {
        client.sftp((error, wrapper) => {
          finish(error, wrapper)
        })
      } catch (error) {
        finish(error)
      }
    })
  }

  private execute<T>(
    state: SessionState,
    action: string,
    mutation: boolean,
    start: (wrapper: SFTPWrapper, done: (error: unknown, value?: T) => void) => void,
  ): Promise<T> {
    return this.acquireChannel(state).then(
      (wrapper) =>
        new Promise<T>((resolve, reject) => {
          let settled = false
          let timer: NodeJS.Timeout | null = null

          const finish = (error: unknown, value?: T): void => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            state.pending.delete(pending)
            if (error) {
              reject(
                error instanceof AppOperationError ? error : this.mapError(error, action, mutation),
              )
              return
            }
            resolve(value as T)
          }

          const pending: PendingCall = {
            mutation,
            fail: (error) => finish(error),
          }
          state.pending.add(pending)
          timer = setTimeout(() => {
            finish(
              new AppOperationError(
                mutation ? 'outcome-unknown' : 'timeout',
                mutation
                  ? `${action}操作超时，无法确认服务器是否已执行；请刷新目录核实后再决定是否重试。`
                  : `${action}超时，请稍后重试。`,
              ),
            )
          }, this.operationTimeoutMs)
          timer.unref?.()

          try {
            start(wrapper, finish)
          } catch (error) {
            finish(error)
          }
        }),
    )
  }

  private handleChannelLoss(state: SessionState, wrapper: SFTPWrapper): void {
    if (state.channel !== wrapper) return
    state.channel = null
    this.rejectPending(
      state,
      'SFTP 通道已中断，请重试或重新打开 SFTP。',
      'SFTP 通道已中断，无法确认操作是否已在服务器上生效；请重新打开并刷新目录。',
    )
  }

  private rejectPending(state: SessionState, readMessage: string, mutationMessage: string): void {
    for (const pending of [...state.pending]) {
      pending.fail(
        new AppOperationError(
          pending.mutation ? 'outcome-unknown' : 'unavailable',
          pending.mutation ? mutationMessage : readMessage,
        ),
      )
    }
  }

  private async withLocks<T>(
    state: SessionState,
    paths: string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(paths)].sort()
    if (keys.some((key) => state.locks.has(key))) {
      throw new AppOperationError('conflict', '该路径正在执行另一个文件操作，请等待完成后再试。')
    }
    for (const key of keys) state.locks.add(key)

    try {
      return await operation()
    } finally {
      for (const key of keys) state.locks.delete(key)
      this.forgetIfIdle(state)
    }
  }

  private readFileBuffer(state: SessionState, path: string): Promise<Buffer> {
    return this.execute<Buffer>(state, '读取文件', false, (wrapper, done) => {
      const chunks: Buffer[] = []
      let total = 0
      let settled = false

      const finish = (error?: unknown, value?: Buffer): void => {
        if (settled) return
        settled = true
        done(error, value)
      }

      let stream: ReturnType<SFTPWrapper['createReadStream']>
      try {
        stream = wrapper.createReadStream(path)
      } catch (error) {
        finish(error)
        return
      }

      stream.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buffer.length
        if (total > MAX_REMOTE_TEXT_FILE_BYTES) {
          stream.destroy()
          finish(
            new AppOperationError(
              'limit-exceeded',
              `文件超过 ${Math.floor(MAX_REMOTE_TEXT_FILE_BYTES / 1024)} KiB 编辑上限，已停止读取。`,
            ),
          )
          return
        }
        chunks.push(buffer)
      })
      stream.on('end', () => finish(undefined, Buffer.concat(chunks)))
      stream.on('error', (error: unknown) => finish(error))
    })
  }

  private async lstatIfExists(state: SessionState, path: string): Promise<Stats | null> {
    try {
      return await this.execute<Stats>(state, '读取文件信息', false, (wrapper, done) =>
        wrapper.lstat(path, done),
      )
    } catch (error) {
      if (error instanceof AppOperationError && error.code === 'not-found') return null
      throw error
    }
  }

  private isDirectoryStats(stats: Stats): boolean {
    try {
      if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) return false
      if (typeof stats.isDirectory === 'function') return stats.isDirectory()
    } catch {
      // Fall back to mode bits.
    }
    return (stats.mode & 0o170000) === 0o040000
  }

  private isSymlinkStats(stats: Stats): boolean {
    try {
      if (typeof stats.isSymbolicLink === 'function') return stats.isSymbolicLink()
    } catch {
      // Fall back to mode bits.
    }
    return (stats.mode & 0o170000) === 0o120000
  }

  private assertSafeDirectoryRemovalTarget(path: string): void {
    this.assertUsable()
    const normalized = normalizeRemotePath(path)
    if (normalized === '/') {
      throw new AppOperationError('invalid-input', '远程根目录不能作为删除目标。')
    }
    if (PROTECTED_DIRECTORY_ROOTS.has(normalized)) {
      throw new AppOperationError(
        'invalid-input',
        '该路径是受保护的系统目录，拒绝作为普通目录删除目标。',
      )
    }
    const depth = normalized.split('/').filter(Boolean).length
    if (depth < MIN_SAFE_DIRECTORY_DEPTH) {
      throw new AppOperationError(
        'invalid-input',
        '拒绝删除顶层目录；请选择更具体的空目录作为删除目标。',
      )
    }
    if (remoteParentPath(normalized) === normalized) {
      throw new AppOperationError('invalid-input', '删除目标路径无效。')
    }
  }

  private mapError(error: unknown, action: string, mutation: boolean): AppOperationError {
    if (error instanceof AppOperationError) return error

    const status = readErrorCode(error)
    const nativeCode = readNativeErrorCode(error)
    const transport =
      status === 6 ||
      status === 7 ||
      nativeCode === 'ECONNRESET' ||
      nativeCode === 'EPIPE' ||
      nativeCode === 'ETIMEDOUT' ||
      nativeCode === 'ECONNREFUSED' ||
      nativeCode === 'NOT_CONNECTED'

    if (transport) {
      return new AppOperationError(
        mutation ? 'outcome-unknown' : 'unavailable',
        mutation
          ? `${action}期间 SFTP 连接中断，无法确认操作是否已在服务器上生效；请重新连接并刷新目录核实。`
          : 'SFTP 连接已中断，请重新连接 SSH 后再试。',
      )
    }

    if (status === 2 || nativeCode === 'ENOENT' || nativeCode === 'NO_SUCH_FILE') {
      return new AppOperationError('not-found', '远程路径不存在，可能已被其他操作移动或删除。')
    }
    if (
      status === 3 ||
      nativeCode === 'EACCES' ||
      nativeCode === 'EPERM' ||
      nativeCode === 'PERMISSION_DENIED'
    ) {
      return new AppOperationError(
        'permission-denied',
        '服务器拒绝访问：当前 SSH 用户没有所需权限。',
      )
    }
    if (status === 8 || nativeCode === 'ENOSYS' || nativeCode === 'OP_UNSUPPORTED') {
      return new AppOperationError('unsupported', '服务器不支持该 SFTP 操作。')
    }
    if (nativeCode === 'ENOTDIR' || (status === 4 && action === '读取目录')) {
      return new AppOperationError(
        'not-a-directory',
        '无法读取该路径：它可能不是目录，或服务器拒绝了读取。',
      )
    }
    if (status === 4) {
      return new AppOperationError(
        mutation ? 'conflict' : 'internal',
        mutation
          ? `${action}被服务器拒绝：目标可能已存在、权限不足，或跨文件系统重命名不受支持。`
          : `${action}失败，请稍后重试。`,
      )
    }

    return new AppOperationError('internal', `${action}失败，请稍后重试。`)
  }

  private forgetIfIdle(state: SessionState): void {
    if (
      state.channel ||
      state.opening ||
      state.pending.size > 0 ||
      state.homePath ||
      state.locks.size > 0
    ) {
      return
    }
    if (this.sessions.get(state.sessionId) === state) {
      this.sessions.delete(state.sessionId)
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new AppOperationError('internal', '应用正在退出，SFTP 服务已停止。')
    }
  }
}
