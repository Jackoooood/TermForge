export const TERMINAL_SHELL_STATUSES = [
  'idle',
  'opening',
  'open',
  'closing',
  'closed',
  'exited',
  'error',
] as const

export type TerminalShellStatus = (typeof TERMINAL_SHELL_STATUSES)[number]

export const TERMINAL_EXIT_REASONS = [
  'remote-exit',
  'remote-close',
  'local-close',
  'ssh-closed',
  'error',
] as const

export type TerminalExitReason = (typeof TERMINAL_EXIT_REASONS)[number]

export type TerminalFailureCode =
  | 'bridge-unavailable'
  | 'session-unavailable'
  | 'shell-open-failed'
  | 'shell-error'
  | 'ssh-disconnected'

export interface TerminalFailure {
  code: TerminalFailureCode
  message: string
}

export interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalExitInfo {
  code: number | null
  signal: string | null
  reason: TerminalExitReason
}

/** A main-process-owned PTY reminder: SSH connected does not imply a shell is open. */
export interface TerminalShellSnapshot {
  sessionId: string
  status: TerminalShellStatus
  size: TerminalSize
  failure: TerminalFailure | null
  exit: TerminalExitInfo | null
}

export interface TerminalOpenResult {
  sessionId: string
  status: TerminalShellStatus
  size: TerminalSize
  reused: boolean
}

export interface TerminalAck {
  sessionId: string
}

/**
 * Remote output is UTF-8 text decoded in the main process. It intentionally
 * never contains environment variables, credentials or channel objects.
 */
export interface TerminalOutputEvent {
  sessionId: string
  data: string
}

export type TerminalStatusEvent = TerminalShellSnapshot

export interface TerminalExitEvent extends TerminalExitInfo {
  sessionId: string
}

export const DEFAULT_TERMINAL_SIZE: TerminalSize = Object.freeze({
  cols: 80,
  rows: 24,
})
