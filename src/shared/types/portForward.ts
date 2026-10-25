export const PORT_FORWARD_TYPES = ['local', 'remote', 'dynamic'] as const

export type PortForwardType = (typeof PORT_FORWARD_TYPES)[number]

export const PORT_FORWARD_STATUSES = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'error',
] as const

export type PortForwardStatus = (typeof PORT_FORWARD_STATUSES)[number]

export const PORT_FORWARD_FAILURE_CODES = [
  'session-ended',
  'connection-missing',
  'bind-failed',
  'remote-bind-failed',
  'remote-port-mismatch',
  'unbind-failed',
  'channel-open-failed',
  'target-unreachable',
  'handshake-timeout',
  'limit-exceeded',
  'protocol-error',
  'cleanup-failed',
  'internal',
] as const

export type PortForwardFailureCode = (typeof PORT_FORWARD_FAILURE_CODES)[number]

export type PortForwardStopReason =
  'user' | 'session-ended' | 'connection-removed' | 'app-quit' | null

interface PortForwardRuleBase {
  id: string
  name: string
  connectionId: string
  createdAt: string
  updatedAt: string
}

export interface LocalForwardRule extends PortForwardRuleBase {
  type: 'local'
  bindAddress: string
  bindPort: number
  targetHost: string
  targetPort: number
}

export interface RemoteForwardRule extends PortForwardRuleBase {
  type: 'remote'
  bindAddress: string
  bindPort: number
  targetHost: string
  targetPort: number
}

export interface DynamicForwardRule extends PortForwardRuleBase {
  type: 'dynamic'
  bindAddress: '127.0.0.1'
  bindPort: number
}

export type PortForwardRule = LocalForwardRule | RemoteForwardRule | DynamicForwardRule

export interface LocalForwardCreateInput {
  type: 'local'
  name: string
  connectionId: string
  bindAddress?: string
  bindPort: number
  targetHost: string
  targetPort: number
}

export interface RemoteForwardCreateInput {
  type: 'remote'
  name: string
  connectionId: string
  bindAddress?: string
  bindPort: number
  targetHost: string
  targetPort: number
}

export interface DynamicForwardCreateInput {
  type: 'dynamic'
  name: string
  connectionId: string
  bindPort: number
}

export type PortForwardCreateInput =
  LocalForwardCreateInput | RemoteForwardCreateInput | DynamicForwardCreateInput

export interface LocalForwardUpdateInput {
  type: 'local'
  name: string
  bindAddress?: string
  bindPort: number
  targetHost: string
  targetPort: number
}

export interface RemoteForwardUpdateInput {
  type: 'remote'
  name: string
  bindAddress?: string
  bindPort: number
  targetHost: string
  targetPort: number
}

export interface DynamicForwardUpdateInput {
  type: 'dynamic'
  name: string
  bindPort: number
}

export type PortForwardUpdateInput =
  LocalForwardUpdateInput | RemoteForwardUpdateInput | DynamicForwardUpdateInput

export interface PortForwardFailure {
  code: PortForwardFailureCode
  message: string
}

export interface PortForwardRuntime {
  ruleId: string
  status: PortForwardStatus
  sessionId: string | null
  boundAddress: string | null
  boundPort: number | null
  activeConnections: number
  startedAt: string | null
  lastStopReason: PortForwardStopReason
  failure: PortForwardFailure | null
  cleanupPending: boolean
}

export interface PortForwardItem {
  rule: PortForwardRule
  runtime: PortForwardRuntime
}

export interface PortForwardStoreState {
  rules: PortForwardRule[]
}

export interface PortForwardSnapshot {
  revision: number
  items: PortForwardItem[]
}

export interface PortForwardRemoveAck {
  id: string
}

export interface PortForwardUpdateEvent {
  snapshot: PortForwardSnapshot
}

export interface StartPortForwardInput {
  ruleId: string
  sessionId: string
  confirmExposure?: boolean
}

export interface ConnectionRemovalImpact {
  connectionId: string
  portForwardRuleCount: number
  runningPortForwardCount: number
}

export interface ConnectionRemovalOptions {
  cascadePortForwards?: boolean
}
