import { z } from 'zod'
import { SSH_CREDENTIAL_KINDS } from '../types/ssh'
import { connectionIdSchema } from './ipc'

const MAX_SECRET_LENGTH = 65_536
const SESSION_ID = /^ssh-[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const CLIENT_ID = /^sshtab-[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const REQUEST_ID = /^hk-[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/

export const sshSessionIdSchema = z
  .string()
  .min(1, '缺少 SSH 会话 ID')
  .max(100, 'SSH 会话 ID 过长')
  .regex(SESSION_ID, 'SSH 会话 ID 格式无效')

export const sshClientIdSchema = z
  .string()
  .min(1, '缺少 SSH 客户端标识')
  .max(105, 'SSH 客户端标识过长')
  .regex(CLIENT_ID, 'SSH 客户端标识格式无效')

export const hostKeyRequestIdSchema = z
  .string()
  .min(1, '缺少主机密钥确认请求 ID')
  .max(100, '主机密钥确认请求 ID 过长')
  .regex(REQUEST_ID, '主机密钥确认请求 ID 格式无效')

export const sshCredentialKindSchema = z.enum(SSH_CREDENTIAL_KINDS, {
  message: '不支持的凭据类型',
})

export const sshCredentialInputSchema = z.strictObject({
  connectionId: connectionIdSchema,
  kind: sshCredentialKindSchema,
  secret: z
    .string()
    .min(1, '凭据内容不能为空')
    .max(MAX_SECRET_LENGTH, '凭据内容超出允许长度'),
})

export const respondHostKeyInputSchema = z.strictObject({
  requestId: hostKeyRequestIdSchema,
  accepted: z.boolean({ message: '主机密钥确认结果必须是布尔值' }),
})
