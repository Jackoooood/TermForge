import { z } from 'zod'
import { HOST_KEY_ALGORITHMS } from '../types/hostKey'
import { isValidHost } from './connection'

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/

const hostKeyEndpointShape = {
  host: z
    .string()
    .trim()
    .min(1, '主机不能为空')
    .max(253, '主机地址过长')
    .refine(isValidHost, '主机地址格式无效'),
  port: z.number().int().min(1).max(65_535),
}

export const hostKeyEndpointSchema = z.strictObject(hostKeyEndpointShape)

export const hostKeyAlgorithmSchema = z.enum(HOST_KEY_ALGORITHMS, {
  message: '不支持的主机密钥算法',
})

export const presentedHostKeySchema = z.strictObject({
  ...hostKeyEndpointShape,
  algorithm: hostKeyAlgorithmSchema,
  fingerprint: z.string().regex(FINGERPRINT, '指纹必须为 OpenSSH SHA256 Base64 格式').max(64),
})

export const hostKeyRecordSchema = z
  .strictObject({
    ...hostKeyEndpointShape,
    algorithm: hostKeyAlgorithmSchema,
    fingerprint: z.string().regex(FINGERPRINT, '指纹必须为 OpenSSH SHA256 Base64 格式').max(64),
    trustedAt: z.iso.datetime({ offset: true, message: '信任时间无效' }),
    updatedAt: z.iso.datetime({ offset: true, message: '更新时间无效' }),
  })
  .superRefine((record, context) => {
    if (Date.parse(record.trustedAt) > Date.parse(record.updatedAt)) {
      context.addIssue({
        code: 'custom',
        message: '信任时间不能晚于更新时间',
        path: ['trustedAt'],
      })
    }
  })

export const persistedHostKeysSchema = z
  .strictObject({
    version: z.literal(1),
    records: z.array(hostKeyRecordSchema).max(10_000),
  })
  .superRefine((value, context) => {
    const endpoints = new Set<string>()
    for (const [index, record] of value.records.entries()) {
      const endpoint = `${record.host.toLowerCase()}:${record.port}`
      if (endpoints.has(endpoint)) {
        context.addIssue({
          code: 'custom',
          message: '同一主机端点只能保存一条主机密钥记录',
          path: ['records', index],
        })
      }
      endpoints.add(endpoint)
    }
  })

export type PersistedHostKeys = z.infer<typeof persistedHostKeysSchema>
