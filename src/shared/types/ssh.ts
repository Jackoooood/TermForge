import type { AuthMethod } from './connection'
import type { HostKeyAlgorithm, PresentedHostKey } from './hostKey'

export const SSH_SESSION_STATUSES = [
  'idle',
  'connecting',
  'authenticating',
  'awaiting-host-key',
  'connected',
  'reconnecting',
  'closing',
  'disconnected',
  'error',
] as const

export type SshSessionStatus = (typeof SSH_SESSION_STATUSES)[number]

export const SSH_FAILURE_CODES = [
  'configuration-invalid',
  'credential-required',
  'credential-invalid',
  'credential-unavailable',
  'host-key-changed',
  'host-key-rejected',
  'host-key-timeout',
  'host-key-storage-failed',
  'host-key-unsupported',
  'host-key-verification-failed',
  'dns-failed',
  'connection-refused',
  'connection-timeout',
  'authentication-failed',
  'network-error',
  'remote-closed',
  'agent-unavailable',
  'private-key-unreadable',
  'private-key-invalid',
  'cancelled',
  'internal',
] as const

export type SshFailureCode = (typeof SSH_FAILURE_CODES)[number]

export const SSH_CREDENTIAL_KINDS = ['password', 'privateKey', 'passphrase'] as const

export type SshCredentialKind = (typeof SSH_CREDENTIAL_KINDS)[number]

export interface SshFailure {
  code: SshFailureCode
  message: string
  credentialKind?: SshCredentialKind
  /**
   * Present when the failure concerns a jump host. `index` is 1-based in chain
   * order; absent means the failure concerns the final target (or an unqualified
   * local error).
   */
  hop?: SshJumpHop
}

/**
 * A jump host in the connection path. Only display-safe fields are carried;
 * credentials, sockets and verifier callbacks never cross IPC.
 */
export interface SshJumpHop {
  /** 1-based position in the ordered jump list. */
  index: number
  connectionId: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
}

export interface SshSessionSnapshot {
  /**
   * Stable renderer tab identity supplied when the SSH session was requested.
   * A reconnect creates a new `sessionId` while keeping the same `clientId`.
   */
  clientId: string
  sessionId: string
  connectionId: string
  connectionName: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  status: SshSessionStatus
  /** Ordered jump path (nearest hop first); empty for direct connections. */
  jumps: SshJumpHop[]
  /** Jump currently being established; null once connected or while dialing the target. */
  activeHop: SshJumpHop | null
  createdAt: string
  connectedAt: string | null
  hostKey: PresentedHostKey | null
  error: SshFailure | null
}

export interface SshConnectResult {
  session: SshSessionSnapshot
  reused: boolean
}

/**
 * Result of cancelling the in-flight connection attempt for one renderer tab.
 * `session` is null when no attempt was found for that client ID.
 */
export interface SshConnectCancelAck {
  cancelled: boolean
  session: SshSessionSnapshot | null
}

export interface HostKeyChallenge {
  requestId: string
  sessionId: string
  connectionId: string
  connectionName: string
  host: string
  port: number
  algorithm: HostKeyAlgorithm
  fingerprint: string
  expiresAt: string
  /** Present when this challenge belongs to a jump host rather than the target. */
  hop?: SshJumpHop
}

export interface SshStatusEvent {
  session: SshSessionSnapshot
}

export interface SshHostKeyRequestEvent {
  challenge: HostKeyChallenge
}

export interface SshHostKeyResponseAck {
  requestId: string
  accepted: boolean
}

export interface SshCredentialInput {
  connectionId: string
  kind: SshCredentialKind
  secret: string
}

export interface SshCredentialAck {
  connectionId: string
  kind: SshCredentialKind
}
