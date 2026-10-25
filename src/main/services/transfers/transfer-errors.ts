import { AppOperationError } from '../../errors'
import type { TransferDirection, TransferErrorCode } from '../../../shared/types/transfer'

export type TransferStage = 'source' | 'transfer' | 'commit' | 'cleanup'

export type TransferAbortReason = 'cancelled' | 'session-closed' | 'window-closed' | 'shutdown'

export class TransferAbortError extends Error {
  constructor(readonly reason: TransferAbortReason) {
    super('Transfer aborted')
    this.name = 'TransferAbortError'
  }
}

/** A sanitized, transfer-specific failure that is safe to show verbatim. */
export class TransferTaskError extends Error {
  constructor(
    readonly code: TransferErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TransferTaskError'
  }
}

export interface TransferFailure {
  code: TransferErrorCode
  message: string
}

function nativeCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function directionLabel(direction: TransferDirection): string {
  return direction === 'upload' ? '上传' : '下载'
}

/**
 * Reduces local filesystem errors and SFTP errors to an allow-listed task
 * failure. Raw error messages and absolute paths never reach the renderer.
 */
export function mapTransferFailure(
  error: unknown,
  direction: TransferDirection,
  stage: TransferStage,
): TransferFailure {
  if (error instanceof TransferTaskError) {
    return { code: error.code, message: error.message }
  }

  if (error instanceof TransferAbortError) {
    if (error.reason === 'session-closed') {
      return { code: 'connection-lost', message: 'SSH 会话已断开，传输已停止。' }
    }
    if (error.reason === 'window-closed' || error.reason === 'shutdown') {
      return { code: 'cancelled', message: '应用正在退出，传输已停止。' }
    }
    return { code: 'cancelled', message: '传输已取消。' }
  }

  if (error instanceof AppOperationError) {
    if (error.code === 'unavailable' || error.code === 'outcome-unknown') {
      if (error.code === 'unavailable') {
        return { code: 'connection-lost', message: 'SSH 连接不可用，传输已停止。' }
      }
      return { code: 'outcome-unknown', message: error.message }
    }
    if (error.code === 'not-found') {
      return direction === 'upload'
        ? { code: 'source-missing', message: '本地源文件不存在或已被删除。' }
        : { code: 'source-missing', message: '远程源文件不存在或已被删除。' }
    }
    if (error.code === 'already-exists') {
      return {
        code: 'target-changed',
        message: '目标在提交前已被创建或修改；为避免覆盖，本次传输已失败。',
      }
    }
    if (error.code === 'conflict') {
      return { code: 'target-changed', message: error.message }
    }
    return { code: error.code, message: error.message }
  }

  const code = nativeCode(error)
  if (code === 'ENOENT') {
    if (stage === 'source') {
      return direction === 'upload'
        ? { code: 'source-missing', message: '本地源文件不存在或已被删除。' }
        : { code: 'source-missing', message: '远程源文件不存在或已被删除。' }
    }
    return { code: 'destination-unavailable', message: '目标目录不存在或已不可用。' }
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      code: 'permission-denied',
      message:
        direction === 'upload'
          ? '无法读取本地源文件或没有目标目录写权限。'
          : '无法写入本地目标目录或读取远程源文件。',
    }
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return { code: 'destination-unavailable', message: '本地磁盘空间不足，传输已停止。' }
  }
  if (code === 'EISDIR' || code === 'ENOTDIR') {
    return { code: 'not-a-file', message: '源或目标不是普通文件。' }
  }
  if (code === 'EEXIST') {
    return {
      code: 'target-changed',
      message: '目标在提交前已被创建；为避免覆盖，本次传输已失败。',
    }
  }
  if (code === 'EXDEV') {
    return {
      code: 'destination-unavailable',
      message: '目标目录不允许在同一文件系统内完成安全重命名。',
    }
  }
  if (code === 'EMFILE' || code === 'ENFILE') {
    return { code: 'internal', message: '本地文件句柄不足，请稍后重试。' }
  }

  if (stage === 'transfer') {
    return {
      code: 'internal',
      message: `${directionLabel(direction)}过程中断，传输未完成。`,
    }
  }
  return {
    code: 'internal',
    message: `${directionLabel(direction)}未能完成，请稍后重试。`,
  }
}
