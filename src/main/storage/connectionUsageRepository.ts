import { z } from 'zod'
import { MAX_CONNECTION_USAGE_RECORDS } from '../../shared/constants/app'
import {
  connectionUsageRecordSchema,
  persistedConnectionUsageSchema,
} from '../../shared/schemas/connectionUsage'
import { connectionIdSchema } from '../../shared/schemas/ipc'
import type {
  ConnectionUsageClearAck,
  ConnectionUsageRecord,
  ConnectionUsageRemovalAck,
} from '../../shared/types/connectionUsage'
import { AppOperationError } from '../errors'
import { readJsonFile, writeJsonFileAtomic } from './jsonFile'

const MAX_USAGE_COUNT = 1_000_000_000
const timestampInputSchema = z.iso.datetime({ offset: true })

const USAGE_STORE_VERSION = 1 as const

function cloneRecord(record: ConnectionUsageRecord): ConnectionUsageRecord {
  return { ...record }
}

function sortRecords(records: ConnectionUsageRecord[]): ConnectionUsageRecord[] {
  const connectedAt = (record: ConnectionUsageRecord): number =>
    record.lastConnectedAt ? Date.parse(record.lastConnectedAt) : Number.NEGATIVE_INFINITY

  return [...records].sort((left, right) => {
    const attemptDelta = Date.parse(right.lastAttemptAt) - Date.parse(left.lastAttemptAt)
    if (attemptDelta !== 0) return attemptDelta
    const successDelta = connectedAt(right) - connectedAt(left)
    if (successDelta !== 0) return successDelta
    return left.connectionId.localeCompare(right.connectionId)
  })
}

function latestIso(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left
}

export interface ConnectionUsageStore {
  list(): Promise<ConnectionUsageRecord[]>
  recordAttempt(connectionId: string, at?: string): Promise<ConnectionUsageRecord>
  recordConnected(connectionId: string, at?: string): Promise<ConnectionUsageRecord>
  remove(connectionId: string): Promise<ConnectionUsageRemovalAck>
  clear(): Promise<ConnectionUsageClearAck>
}

export class ConnectionUsageRepository implements ConnectionUsageStore {
  private records: ConnectionUsageRecord[] | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  list(): Promise<ConnectionUsageRecord[]> {
    return this.exclusive(async () => {
      const records = await this.loadState()
      return sortRecords(records).map(cloneRecord)
    })
  }

  recordAttempt(connectionId: string, at?: string): Promise<ConnectionUsageRecord> {
    return this.record(connectionId, 'attempt', at)
  }

  recordConnected(connectionId: string, at?: string): Promise<ConnectionUsageRecord> {
    return this.record(connectionId, 'connected', at)
  }

  remove(connectionId: string): Promise<ConnectionUsageRemovalAck> {
    return this.exclusive(async () => {
      const id = this.parseConnectionId(connectionId)
      const records = await this.loadState()
      if (!records.some((record) => record.connectionId === id)) {
        return { connectionId: id, removed: false }
      }

      const next = records.filter((record) => record.connectionId !== id)
      await this.persist(next)
      this.records = next
      return { connectionId: id, removed: true }
    })
  }

  clear(): Promise<ConnectionUsageClearAck> {
    return this.exclusive(async () => {
      const records = await this.loadState()
      if (records.length === 0) return { cleared: 0 }
      await this.persist([])
      this.records = []
      return { cleared: records.length }
    })
  }

  private record(
    connectionId: string,
    event: 'attempt' | 'connected',
    at?: string,
  ): Promise<ConnectionUsageRecord> {
    return this.exclusive(async () => {
      const id = this.parseConnectionId(connectionId)
      const timestamp = this.parseTimestamp(at)
      const records = await this.loadState()
      const existing = records.find((record) => record.connectionId === id)

      let nextRecord: ConnectionUsageRecord
      if (event === 'attempt') {
        nextRecord = {
          connectionId: id,
          lastAttemptAt: existing
            ? latestIso(existing.lastAttemptAt, timestamp)
            : timestamp,
          lastConnectedAt: existing?.lastConnectedAt ?? null,
          attemptCount: (existing?.attemptCount ?? 0) + 1,
          successCount: existing?.successCount ?? 0,
        }
      } else if (existing) {
        nextRecord = {
          connectionId: id,
          lastAttemptAt: existing.lastAttemptAt,
          lastConnectedAt: latestIso(existing.lastConnectedAt ?? timestamp, timestamp),
          attemptCount: existing.attemptCount,
          successCount: existing.successCount + 1,
        }
      } else {
        nextRecord = {
          connectionId: id,
          lastAttemptAt: timestamp,
          lastConnectedAt: timestamp,
          attemptCount: 1,
          successCount: 1,
        }
      }

      if (
        nextRecord.attemptCount > MAX_USAGE_COUNT ||
        nextRecord.successCount > MAX_USAGE_COUNT
      ) {
        throw new AppOperationError('invalid-input', '最近连接记录计数已达上限。')
      }

      const parsedRecord = connectionUsageRecordSchema.safeParse(nextRecord)
      if (!parsedRecord.success) {
        throw new AppOperationError('invalid-input', '最近连接记录未通过校验。')
      }

      const next = sortRecords([
        parsedRecord.data,
        ...records.filter((record) => record.connectionId !== id),
      ]).slice(0, MAX_CONNECTION_USAGE_RECORDS)
      await this.persist(next)
      this.records = next
      return cloneRecord(parsedRecord.data)
    })
  }

  private parseConnectionId(connectionId: string): string {
    const parsed = connectionIdSchema.safeParse(connectionId)
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '连接 ID 格式无效。')
    }
    return parsed.data
  }

  private parseTimestamp(at?: string): string {
    const parsed = timestampInputSchema.safeParse(at ?? new Date().toISOString())
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '最近连接时间格式无效。')
    }
    return new Date(parsed.data).toISOString()
  }

  private async loadState(): Promise<ConnectionUsageRecord[]> {
    if (this.records) return this.records

    const raw = await readJsonFile(this.filePath, '本地最近连接记录')
    if (raw === null) {
      this.records = []
      return this.records
    }

    const parsed = persistedConnectionUsageSchema.safeParse(raw)
    if (!parsed.success) {
      throw new AppOperationError(
        'storage-corrupt',
        '本地最近连接记录损坏或版本不受支持，已停止加载以避免覆盖现有数据。',
      )
    }

    this.records = parsed.data.records
    return this.records
  }

  private async persist(records: ConnectionUsageRecord[]): Promise<void> {
    await writeJsonFileAtomic(
      this.filePath,
      { version: USAGE_STORE_VERSION, records },
      '本地最近连接记录',
    )
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
