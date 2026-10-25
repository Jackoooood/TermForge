import type { SshFailure } from '@shared/types'

/**
 * Renders a failure message with jump-host context so users can tell which
 * link of the chain failed (a jump host versus the final target).
 */
export function formatSshFailureMessage(failure: SshFailure): string {
  if (!failure.hop) return failure.message
  return `经跳板 ${failure.hop.index}（${failure.hop.name}）失败：${failure.message}`
}
