import type { AuthMethod } from './connection'
import type { PresentedHostKey } from './hostKey'
import type { SshFailure, SshJumpHop, SshSessionStatus } from './ssh'

export type SessionStatus = SshSessionStatus

/**
 * Runtime-only automatic reconnect progress for one tab. It is never
 * persisted: the sequence belongs to the live renderer session and ends with
 * the tab, an explicit user action or exhausted attempts.
 */
export interface SessionAutoReconnect {
  /** Number of the current or upcoming automatic attempt (1-based). */
  attempt: number
  maxAttempts: number
  /** ISO timestamp of the next scheduled retry; null while one is in flight or after exhaustion. */
  nextRetryAt: string | null
  /** True once the bounded sequence ended without reconnecting. */
  exhausted: boolean
}

/**
 * Renderer-side metadata for one workspace tab. `id` is the stable tab identity
 * and IPC client ID; `sessionId` is the current main-process SSH session and is
 * replaced by a reconnect. The main-process SshSessionSnapshot remains
 * authoritative for `status`, `connectedAt`, `hostKey` and `failure`.
 */
export interface SessionInfo {
  id: string
  sessionId: string | null
  connectionId: string
  connectionName: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  title: string
  status: SessionStatus
  /** Ordered jump path (nearest hop first); empty for direct connections. */
  jumps: SshJumpHop[]
  /** Jump currently being established; null once connected or while dialing the target. */
  activeHop: SshJumpHop | null
  /** Increments for every SSH connection attempt bound to this tab. */
  generation: number
  /** True once this tab has owned a terminal; stays true across a passive disconnect. */
  hasTerminal: boolean
  createdAt: string
  connectedAt: string | null
  hostKey: PresentedHostKey | null
  failure: SshFailure | null
  /** Automatic retry progress; null when no sequence is pending or running. */
  autoReconnect: SessionAutoReconnect | null
}
