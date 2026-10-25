import type { OperationError, OperationErrorCode } from '../shared/types/ipc'

/**
 * Errors crossing IPC are reduced to an allow-listed code and a fixed, safe
 * message. Raw filesystem errors and Zod issues never reach the renderer.
 */
export class AppOperationError extends Error {
  readonly code: OperationErrorCode

  constructor(code: OperationErrorCode, message: string) {
    super(message)
    this.name = 'AppOperationError'
    this.code = code
  }
}

export function toOperationError(error: unknown): OperationError {
  if (error instanceof AppOperationError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'internal',
    message: '操作未能完成，请稍后重试。',
  }
}
