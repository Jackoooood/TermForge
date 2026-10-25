import { z } from 'zod'
import {
  getRemoteEntryNameError,
  getRemotePathError,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
} from '../sftp/remotePath'
import { MAX_REMOTE_TEXT_FILE_BYTES } from '../sftp/remoteText'
import { sshSessionIdSchema } from './ssh'

export const remotePathSchema = z
  .string()
  .min(1, '缺少远程路径')
  .max(MAX_PATH_LENGTH, '远程路径过长')
  .refine((value) => getRemotePathError(value) === null, {
    message: '远程路径格式无效，请使用以 / 开头的绝对路径',
  })

const entryName = z
  .string()
  .min(1, '缺少名称')
  .max(MAX_NAME_LENGTH, '名称过长')
  .refine((value) => getRemoteEntryNameError(value) === null, {
    message: '名称无效',
  })

export const sftpSessionIdSchema = sshSessionIdSchema

export const sftpOpenInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
})

export const sftpListInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  path: remotePathSchema,
})

export const sftpStatInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  path: remotePathSchema,
})

export const sftpMkdirInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  parentPath: remotePathSchema,
  name: entryName,
})

export const sftpRenameInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  sourcePath: remotePathSchema,
  targetPath: remotePathSchema,
})

export const sftpDeleteInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  path: remotePathSchema,
})

export const sftpReadTextFileInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  path: remotePathSchema,
})

export const sftpWriteTextFileInputSchema = z.strictObject({
  sessionId: sftpSessionIdSchema,
  path: remotePathSchema,
  content: z
    .string()
    .max(MAX_REMOTE_TEXT_FILE_BYTES, '文件内容超过 2 MiB 编辑上限'),
  encoding: z.enum(['utf-8', 'utf-8-bom']),
  eol: z.enum(['lf', 'crlf']),
  expectedRevision: z.string().min(1).max(128).nullable(),
  force: z.boolean(),
})

export const sftpCloseInputSchema = sftpOpenInputSchema
