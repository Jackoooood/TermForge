import { z } from 'zod'
import { MAX_CONNECTION_USAGE_RECORDS } from '../constants/app'
import { connectionIdSchema } from './ipc'

const isoDateSchema = z.iso.datetime({ offset: true, message: '时间必须是有效的 ISO 8601 时间' })

export const connectionUsageRecordSchema = z
  .strictObject({
    connectionId: connectionIdSchema,
    lastAttemptAt: isoDateSchema,
    lastConnectedAt: isoDateSchema.nullable(),
    attemptCount: z.number().int().min(1).max(1_000_000_000),
    successCount: z.number().int().min(0).max(1_000_000_000),
  })
  .superRefine((record, context) => {
    if (record.successCount > record.attemptCount) {
      context.addIssue({
        code: 'custom',
        message: '成功连接次数不能大于尝试次数',
        path: ['successCount'],
      })
    }
    if (record.successCount === 0 && record.lastConnectedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: '没有成功记录时不能包含成功时间',
        path: ['lastConnectedAt'],
      })
    }
    if (record.successCount > 0 && record.lastConnectedAt === null) {
      context.addIssue({
        code: 'custom',
        message: '存在成功记录时必须包含成功时间',
        path: ['lastConnectedAt'],
      })
    }
  })

export const persistedConnectionUsageSchema = z
  .strictObject({
    version: z.literal(1),
    records: z.array(connectionUsageRecordSchema).max(MAX_CONNECTION_USAGE_RECORDS),
  })
  .superRefine((usage, context) => {
    const seen = new Set<string>()
    for (const [index, record] of usage.records.entries()) {
      if (seen.has(record.connectionId)) {
        context.addIssue({
          code: 'custom',
          message: '最近连接记录不能重复引用同一连接',
          path: ['records', index, 'connectionId'],
        })
      }
      seen.add(record.connectionId)
    }
  })

export type PersistedConnectionUsage = z.infer<typeof persistedConnectionUsageSchema>
