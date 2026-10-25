export interface ConnectionUsageRecord {
  connectionId: string
  lastAttemptAt: string
  lastConnectedAt: string | null
  attemptCount: number
  successCount: number
}

export interface ConnectionUsageSnapshot {
  records: ConnectionUsageRecord[]
}

export interface ConnectionUsageClearAck {
  cleared: number
}

export interface ConnectionUsageRemovalAck {
  connectionId: string
  removed: boolean
}
