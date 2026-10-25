export const PORT_FORWARD_STORE_VERSION = 1 as const

export const PORT_FORWARD_ID_PREFIX = 'pf-'

export const DEFAULT_FORWARD_BIND_ADDRESS = '127.0.0.1'

export const DYNAMIC_FORWARD_BIND_ADDRESS = '127.0.0.1'

export const PORT_FORWARD_LIMITS = {
  maxRules: 100,
  maxActiveRules: 32,
  maxConnectionsPerRule: 64,
  maxGlobalConnections: 256,
  connectTimeoutMs: 10_000,
  handshakeTimeoutMs: 10_000,
  stopTimeoutMs: 5_000,
} as const
