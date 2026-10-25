import { z } from 'zod'

export const TRANSFER_JOURNAL_VERSION = 1
export const MAX_JOURNAL_TASKS = 100

const ACTIVE_OR_INTERRUPTED = [
  'queued',
  'preparing',
  'waitingForConflictResolution',
  'transferring',
  'cancelling',
  'interrupted',
] as const

export const transferJournalRecordSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(120)
    .regex(/^transfer-[A-Za-z0-9-]+$/),
  sessionId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^ssh-[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/),
  direction: z.enum(['upload', 'download']),
  fileName: z.string().min(1).max(255),
  sourcePath: z.string().min(1).max(4_096),
  destinationPath: z.string().min(1).max(4_096),
  status: z.enum(ACTIVE_OR_INTERRUPTED),
  totalBytes: z.number().int().nonnegative().nullable(),
  transferredBytes: z.number().int().nonnegative(),
  progress: z.number().int().min(0).max(100).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  attempt: z.number().int().min(1).max(1_000),
  revision: z.number().int().nonnegative(),
})

export const transferJournalSchema = z.strictObject({
  version: z.literal(TRANSFER_JOURNAL_VERSION),
  tasks: z.array(transferJournalRecordSchema).max(MAX_JOURNAL_TASKS),
})

export type TransferJournalRecord = z.infer<typeof transferJournalRecordSchema>
