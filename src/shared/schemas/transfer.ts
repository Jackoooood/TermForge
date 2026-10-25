import { z } from 'zod'
import { MAX_TRANSFER_BATCH } from '../types/transfer'
import { localPathSchema } from './localFs'
import { remotePathSchema, sftpSessionIdSchema } from './sftp'

export const transferIdSchema = z
  .string()
  .min(1, '缺少传输任务 ID')
  .max(120, '传输任务 ID 过长')
  .regex(/^transfer-[A-Za-z0-9-]+$/, '传输任务 ID 格式无效')

export const transferEnqueueUploadInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  remoteDirectory: remotePathSchema,
})

export const transferEnqueueUploadPathsInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  remoteDirectory: remotePathSchema,
  localPaths: z
    .array(localPathSchema)
    .min(1, '至少选择一个本地条目')
    .max(MAX_TRANSFER_BATCH, `单次最多选择 ${MAX_TRANSFER_BATCH} 个本地条目`),
})

export const transferEnqueueDownloadInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  remotePaths: z
    .array(remotePathSchema)
    .min(1, '至少选择一个远程文件')
    .max(MAX_TRANSFER_BATCH, `单次最多下载 ${MAX_TRANSFER_BATCH} 个文件`),
})

export const transferEnqueueDownloadPathsInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  remotePaths: z
    .array(remotePathSchema)
    .min(1, '至少选择 1 个远程文件')
    .max(MAX_TRANSFER_BATCH, `单次最多下载 ${MAX_TRANSFER_BATCH} 个文件`),
  localDirectory: localPathSchema,
})

export const transferConflictChoiceSchema = z.enum(['overwrite', 'rename', 'skip'])

export const transferResolveConflictInputSchema = z
  .strictObject({
    transferId: transferIdSchema,
    choice: transferConflictChoiceSchema,
    newName: z.string().max(255, '新名称过长').optional(),
  })
  .superRefine((value, context) => {
    if (value.choice === 'rename' && (value.newName?.trim().length ?? 0) === 0) {
      context.addIssue({
        code: 'custom',
        path: ['newName'],
        message: '重命名需要提供新的文件名',
      })
    }
    if (value.choice !== 'rename' && value.newName !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['newName'],
        message: '只有重命名策略可以使用新名称',
      })
    }
  })

export const transferCancelInputSchema = z.strictObject({
  transferId: transferIdSchema,
})

export const transferRetryInputSchema = transferCancelInputSchema
