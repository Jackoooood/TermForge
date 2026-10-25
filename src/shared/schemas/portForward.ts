import { z } from 'zod'
import {
  DEFAULT_FORWARD_BIND_ADDRESS,
  DYNAMIC_FORWARD_BIND_ADDRESS,
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_STORE_VERSION,
} from '../constants/portForward'
import { canonicalizeIpLiteral } from '../portForward/address'
import { isValidHost } from './connection'
import { connectionIdSchema } from './ipc'
import { sshSessionIdSchema } from './ssh'

const MAX_RULE_NAME_LENGTH = 64
const MAX_HOST_LENGTH = 253
const PORT_FORWARD_ID = /^pf-[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/

const isoDateSchema = z.iso.datetime({ offset: true, message: '时间必须是有效的 ISO 8601 时间' })

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
}

export const portForwardIdSchema = z
  .string()
  .min(1, '缺少端口转发规则 ID')
  .max(100, '端口转发规则 ID 过长')
  .regex(PORT_FORWARD_ID, '端口转发规则 ID 格式无效')

const ruleNameSchema = z
  .string()
  .trim()
  .min(1, '请输入规则名称')
  .max(MAX_RULE_NAME_LENGTH, `规则名称最多 ${MAX_RULE_NAME_LENGTH} 个字符`)
  .refine((value) => !hasControlCharacters(value), '规则名称不能包含控制字符')

const portSchema = z
  .number({ message: '端口必须是数字' })
  .int('端口必须为整数')
  .min(1, '端口范围为 1–65535')
  .max(65535, '端口范围为 1–65535')

const bindAddressSchema = z
  .string()
  .trim()
  .min(1, '请输入监听地址')
  .max(64, '监听地址过长')
  .refine(
    (value) => canonicalizeIpLiteral(value) !== null,
    '监听地址必须是 IPv4 或 IPv6 字面量，不能使用主机名',
  )
  .transform((value) => canonicalizeIpLiteral(value) as string)

const createBindAddressSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) =>
    value !== undefined && value.length > 0 ? value : DEFAULT_FORWARD_BIND_ADDRESS,
  )
  .pipe(bindAddressSchema)

const targetHostSchema = z
  .string()
  .trim()
  .min(1, '请输入目标主机')
  .max(MAX_HOST_LENGTH, `目标主机最多 ${MAX_HOST_LENGTH} 个字符`)
  .transform((value) =>
    value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value,
  )
  .refine(isValidHost, '请输入有效的目标主机名或 IP 地址')

const ruleBaseShape = {
  id: portForwardIdSchema,
  name: ruleNameSchema,
  connectionId: connectionIdSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
}

export const localForwardRuleSchema = z.strictObject({
  ...ruleBaseShape,
  type: z.literal('local'),
  bindAddress: bindAddressSchema,
  bindPort: portSchema,
  targetHost: targetHostSchema,
  targetPort: portSchema,
})

export const remoteForwardRuleSchema = z.strictObject({
  ...ruleBaseShape,
  type: z.literal('remote'),
  bindAddress: bindAddressSchema,
  bindPort: portSchema,
  targetHost: targetHostSchema,
  targetPort: portSchema,
})

export const dynamicForwardRuleSchema = z.strictObject({
  ...ruleBaseShape,
  type: z.literal('dynamic'),
  bindAddress: z.literal(DYNAMIC_FORWARD_BIND_ADDRESS),
  bindPort: portSchema,
})

export const portForwardRuleSchema = z.discriminatedUnion('type', [
  localForwardRuleSchema,
  remoteForwardRuleSchema,
  dynamicForwardRuleSchema,
])

const createBaseShape = {
  name: ruleNameSchema,
  connectionId: connectionIdSchema,
}

export const localForwardCreateInputSchema = z.strictObject({
  ...createBaseShape,
  type: z.literal('local'),
  bindAddress: createBindAddressSchema,
  bindPort: portSchema,
  targetHost: targetHostSchema,
  targetPort: portSchema,
})

export const remoteForwardCreateInputSchema = z.strictObject({
  ...createBaseShape,
  type: z.literal('remote'),
  // Remote listening defaults to loopback; widening requires explicit
  // confirmation at start time, never a silent default.
  bindAddress: createBindAddressSchema,
  bindPort: portSchema,
  targetHost: targetHostSchema,
  targetPort: portSchema,
})

export const dynamicForwardCreateInputSchema = z.strictObject({
  ...createBaseShape,
  type: z.literal('dynamic'),
  bindPort: portSchema,
})

export const portForwardCreateInputSchema = z.discriminatedUnion('type', [
  localForwardCreateInputSchema,
  remoteForwardCreateInputSchema,
  dynamicForwardCreateInputSchema,
])

export const localForwardUpdateInputSchema = z.strictObject({
  type: z.literal('local'),
  name: ruleNameSchema,
  bindAddress: createBindAddressSchema,
  bindPort: portSchema,
  targetHost: targetHostSchema,
  targetPort: portSchema,
})

export const remoteForwardUpdateInputSchema = z.strictObject({
  type: z.literal('remote'),
  name: ruleNameSchema,
  bindAddress: createBindAddressSchema,
  bindPort: portSchema,
  targetHost: targetHostSchema,
  targetPort: portSchema,
})

export const dynamicForwardUpdateInputSchema = z.strictObject({
  type: z.literal('dynamic'),
  name: ruleNameSchema,
  bindPort: portSchema,
})

export const portForwardUpdateInputSchema = z.discriminatedUnion('type', [
  localForwardUpdateInputSchema,
  remoteForwardUpdateInputSchema,
  dynamicForwardUpdateInputSchema,
])

export const portForwardStoreStateSchema = z.strictObject({
  rules: z
    .array(portForwardRuleSchema)
    .max(PORT_FORWARD_LIMITS.maxRules, `最多保存 ${PORT_FORWARD_LIMITS.maxRules} 条转发规则`),
})

export const persistedPortForwardsSchema = z
  .strictObject({
    version: z.literal(PORT_FORWARD_STORE_VERSION),
    data: portForwardStoreStateSchema,
  })
  .superRefine((envelope, context) => {
    const seen = new Set<string>()
    for (const [index, rule] of envelope.data.rules.entries()) {
      if (seen.has(rule.id)) {
        context.addIssue({
          code: 'custom',
          message: '端口转发规则 ID 不能重复',
          path: ['data', 'rules', index, 'id'],
        })
      }
      seen.add(rule.id)
    }
  })

export const startPortForwardInputSchema = z.strictObject({
  ruleId: portForwardIdSchema,
  sessionId: sshSessionIdSchema,
  confirmExposure: z.boolean().default(false),
})

export const removePortForwardInputSchema = z.strictObject({
  ruleId: portForwardIdSchema,
})

export const connectionRemovalOptionsSchema = z.strictObject({
  cascadePortForwards: z.boolean().default(false),
})
