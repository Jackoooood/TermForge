import { z } from 'zod'
import {
  MAX_CONNECTION_GROUPS,
  MAX_CONNECTIONS,
  MAX_CONNECTION_TAGS,
  MAX_JUMP_HOPS,
  MAX_TAG_LENGTH,
  MAX_TAGS,
} from '../constants/app'
import { AUTH_METHODS, CONNECTION_TAG_COLORS } from '../types/connection'
import type { ConnectionCatalog, ConnectionProfile, ConnectionTag } from '../types/connection'

const MAX_HOST_LENGTH = 253
const MAX_NAME_LENGTH = 64
const MAX_USERNAME_LENGTH = 64
const MAX_CREDENTIAL_REF_LENGTH = 512
const MAX_GROUP_ID_LENGTH = 64
const MAX_TAG_ID_LENGTH = 128
const MAX_GROUP_NAME_LENGTH = 64

const HOSTNAME_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const IPV6_CHARS = /^[0-9a-fA-F:]+$/
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/
const GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const TAG_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i

function isIpv6(value: string): boolean {
  if (!IPV6_CHARS.test(value)) return false

  const compressionParts = value.split('::')
  if (compressionParts.length > 2) return false

  const isCompressed = compressionParts.length === 2
  const groups = value.split(':').filter((group) => group.length > 0)

  if (!groups.every((group) => IPV6_GROUP.test(group))) return false
  if (isCompressed) return groups.length < 8
  return groups.length === 8
}

export function isValidHost(rawValue: string): boolean {
  const value = rawValue.trim()
  if (value.length === 0 || value.length > MAX_HOST_LENGTH) return false
  if (/[\s/\\@?#]/.test(value) || value.includes('://')) return false

  if (value.startsWith('[') || value.endsWith(']')) {
    if (!value.startsWith('[') || !value.endsWith(']')) return false
    return isIpv6(value.slice(1, -1))
  }

  if (value.includes(':')) return isIpv6(value)

  if (IPV4.test(value)) {
    return value.split('.').every((octet) => Number(octet) <= 255)
  }

  const labels = value.split('.')
  if (labels.length === 0) return false
  return labels.every(
    (label) => label.length > 0 && label.length <= 63 && HOSTNAME_LABEL.test(label),
  )
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
}

function isNonSecretReference(value: string): boolean {
  if (hasControlCharacters(value)) return false
  return !PRIVATE_KEY_MARKER.test(value)
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  return tags.filter((tag) => {
    const normalized = tag.toLowerCase()
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

const nameSchema = z
  .string()
  .trim()
  .min(1, '请输入连接名称')
  .max(MAX_NAME_LENGTH, `连接名称最多 ${MAX_NAME_LENGTH} 个字符`)

const hostSchema = z
  .string()
  .trim()
  .min(1, '请输入主机地址')
  .max(MAX_HOST_LENGTH, `主机地址最多 ${MAX_HOST_LENGTH} 个字符`)
  .refine(isValidHost, '请输入有效的主机名或 IP 地址（不要在主机框中填写端口或协议）')

const portSchema = z
  .number({ message: '端口必须是数字' })
  .int('端口必须为整数')
  .min(1, '端口范围为 1–65535')
  .max(65535, '端口范围为 1–65535')

const usernameSchema = z
  .string()
  .trim()
  .min(1, '请输入用户名')
  .max(MAX_USERNAME_LENGTH, `用户名最多 ${MAX_USERNAME_LENGTH} 个字符`)

const groupIdSchema = z
  .string()
  .trim()
  .min(1, '请选择服务器分组')
  .max(MAX_GROUP_ID_LENGTH, '分组标识过长')
  .regex(GROUP_ID, '分组标识格式无效')

export const connectionGroupIdSchema = groupIdSchema

const nullableGroupIdSchema = groupIdSchema.nullable()

export const connectionTagIdSchema = z
  .string()
  .trim()
  .min(1, '缺少标签 ID')
  .max(MAX_TAG_ID_LENGTH, '标签标识过长')
  .regex(TAG_ID, '标签标识格式无效')

const groupNameSchema = z
  .string()
  .trim()
  .min(1, '分组名称不能为空')
  .max(MAX_GROUP_NAME_LENGTH, `分组名称最多 ${MAX_GROUP_NAME_LENGTH} 个字符`)

const tagNameSchema = z
  .string()
  .trim()
  .min(1, '标签名称不能为空')
  .max(MAX_TAG_LENGTH, `标签名称最多 ${MAX_TAG_LENGTH} 个字符`)

export const connectionTagColorSchema = z.enum(CONNECTION_TAG_COLORS)

export const connectionGroupDraftSchema = z.strictObject({
  name: groupNameSchema,
})

export const connectionTagDraftSchema = z.strictObject({
  name: tagNameSchema,
  color: connectionTagColorSchema,
})

export const connectionTagSchema = z.strictObject({
  id: connectionTagIdSchema,
  name: tagNameSchema,
  color: connectionTagColorSchema,
})

const credentialRefSchema = z
  .string()
  .trim()
  .max(MAX_CREDENTIAL_REF_LENGTH, `凭据引用最多 ${MAX_CREDENTIAL_REF_LENGTH} 个字符`)
  .refine(isNonSecretReference, '凭据引用只能包含非机密的路径或标识，不能包含密钥内容')
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined))

const legacyTagSchema = z
  .string()
  .trim()
  .min(1, '标签不能为空')
  .max(MAX_TAG_LENGTH, `单个标签最多 ${MAX_TAG_LENGTH} 个字符`)

const legacyTagsSchema = z
  .array(legacyTagSchema)
  .max(MAX_TAGS, `最多添加 ${MAX_TAGS} 个标签`)
  .transform(dedupeTags)

const tagIdsSchema = z
  .array(connectionTagIdSchema, { message: '标签列表格式无效' })
  .max(MAX_TAGS, `最多添加 ${MAX_TAGS} 个标签`)
  .refine(hasUniqueValues, '标签不能重复')

const isoDateSchema = z.iso.datetime({ offset: true, message: '时间必须是有效的 ISO 8601 时间' })

/**
 * Ordered jump-host references (nearest hop first). Order is meaningful, so
 * duplicates are rejected instead of deduplicated.
 */
const jumpConnectionIdsSchema = z
  .array(z.string().regex(CONNECTION_ID, '跳板引用 ID 格式无效'), {
    message: '跳板列表格式无效',
  })
  .max(MAX_JUMP_HOPS, `跳板数量不能超过 ${MAX_JUMP_HOPS} 个`)
  .refine((ids) => new Set(ids).size === ids.length, '跳板列表不能包含重复的连接')

const bulkTagIdsSchema = z
  .array(connectionTagIdSchema, { message: '标签列表格式无效' })
  .min(1, '请选择标签')
  .max(MAX_TAGS, `最多添加 ${MAX_TAGS} 个标签`)
  .refine(hasUniqueValues, '标签不能重复')

export const connectionBulkActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('favorite'), favorite: z.boolean() }),
  z.strictObject({ type: z.literal('set-group'), groupId: nullableGroupIdSchema }),
  z.strictObject({ type: z.literal('add-tags'), tagIds: bulkTagIdsSchema }),
  z.strictObject({ type: z.literal('remove-tags'), tagIds: bulkTagIdsSchema }),
])

/**
 * Strict persisted/service shape. Unknown keys are rejected so a stray
 * `password`, `privateKey` or passphrase field can never be serialized.
 */
export const connectionInputSchema = z.strictObject({
  name: nameSchema,
  host: hostSchema,
  port: portSchema,
  username: usernameSchema,
  authMethod: z.enum(AUTH_METHODS, { message: '请选择认证方式' }),
  groupId: nullableGroupIdSchema,
  tagIds: tagIdsSchema,
  credentialRef: credentialRefSchema,
  // Defaults keep pre-P1-02 payloads and callers working unchanged.
  jumpConnectionIds: jumpConnectionIdsSchema.default([]),
})

export const connectionProfileSchema = z.strictObject({
  id: z.string().regex(CONNECTION_ID, '连接 ID 格式无效'),
  name: nameSchema,
  host: hostSchema,
  port: portSchema,
  username: usernameSchema,
  authMethod: z.enum(AUTH_METHODS, { message: '请选择认证方式' }),
  groupId: nullableGroupIdSchema,
  tagIds: tagIdsSchema,
  credentialRef: credentialRefSchema,
  jumpConnectionIds: jumpConnectionIdsSchema,
  favorite: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
})

export const connectionGroupSchema = z.strictObject({
  id: groupIdSchema,
  name: groupNameSchema,
  tone: z.enum(['neutral', 'production', 'testing', 'local']),
  sortOrder: z.number().int().min(0).max(10_000),
})

interface CatalogReferenceData {
  groups: Array<{ id: string }>
  connections: Array<{
    id: string
    groupId: string | null
    jumpConnectionIds: string[]
  }>
}

const JUMP_VISITING = 1
const JUMP_DONE = 2

function hasJumpCycle(catalog: CatalogReferenceData): boolean {
  const byId = new Map(catalog.connections.map((connection) => [connection.id, connection]))
  const status = new Map<string, number>()
  let cycle = false

  const visit = (id: string): void => {
    status.set(id, JUMP_VISITING)
    for (const next of byId.get(id)?.jumpConnectionIds ?? []) {
      if (!byId.has(next)) continue
      const state = status.get(next) ?? 0
      if (state === JUMP_VISITING) {
        cycle = true
        return
      }
      if (state === 0) {
        visit(next)
        if (cycle) return
      }
    }
    status.set(id, JUMP_DONE)
  }

  for (const connection of catalog.connections) {
    if ((status.get(connection.id) ?? 0) === 0) {
      visit(connection.id)
      if (cycle) return true
    }
  }
  return false
}

function addCatalogReferenceIssues(catalog: CatalogReferenceData, context: z.RefinementCtx): void {
  const connectionIds = new Set<string>()
  for (const [index, connection] of catalog.connections.entries()) {
    if (connectionIds.has(connection.id)) {
      context.addIssue({
        code: 'custom',
        message: '连接 ID 不能重复',
        path: ['connections', index, 'id'],
      })
    }
    connectionIds.add(connection.id)
  }

  const groupIds = new Set<string>()
  for (const [index, group] of catalog.groups.entries()) {
    if (groupIds.has(group.id)) {
      context.addIssue({
        code: 'custom',
        message: '分组 ID 不能重复',
        path: ['groups', index, 'id'],
      })
    }
    groupIds.add(group.id)
  }

  for (const [index, connection] of catalog.connections.entries()) {
    if (connection.groupId !== null && !groupIds.has(connection.groupId)) {
      context.addIssue({
        code: 'custom',
        message: '连接引用了不存在的分组',
        path: ['connections', index, 'groupId'],
      })
    }
  }

  for (const [index, connection] of catalog.connections.entries()) {
    for (const [jumpIndex, jumpId] of connection.jumpConnectionIds.entries()) {
      if (jumpId === connection.id) {
        context.addIssue({
          code: 'custom',
          message: '连接不能把自身设为跳板',
          path: ['connections', index, 'jumpConnectionIds', jumpIndex],
        })
      } else if (!connectionIds.has(jumpId)) {
        context.addIssue({
          code: 'custom',
          message: '跳板引用了不存在的连接',
          path: ['connections', index, 'jumpConnectionIds', jumpIndex],
        })
      }
    }
  }

  if (hasJumpCycle(catalog)) {
    context.addIssue({
      code: 'custom',
      message: '跳板引用不能形成循环',
      path: ['connections'],
    })
  }
}

export const connectionCatalogSchema = z
  .strictObject({
    tags: z.array(connectionTagSchema).max(MAX_CONNECTION_TAGS),
    connections: z.array(connectionProfileSchema).max(MAX_CONNECTIONS),
    groups: z.array(connectionGroupSchema).max(MAX_CONNECTION_GROUPS),
  })
  .superRefine((catalog, context) => {
    addCatalogReferenceIssues(catalog, context)

    const tagIds = new Set<string>()
    const tagNames = new Set<string>()
    for (const [index, tag] of catalog.tags.entries()) {
      if (tagIds.has(tag.id)) {
        context.addIssue({
          code: 'custom',
          message: '标签 ID 不能重复',
          path: ['tags', index, 'id'],
        })
      }
      const normalizedName = tag.name.toLowerCase()
      if (tagNames.has(normalizedName)) {
        context.addIssue({
          code: 'custom',
          message: '标签名称不能重复',
          path: ['tags', index, 'name'],
        })
      }
      tagIds.add(tag.id)
      tagNames.add(normalizedName)
    }

    for (const [index, connection] of catalog.connections.entries()) {
      for (const [tagIndex, tagId] of connection.tagIds.entries()) {
        if (!tagIds.has(tagId)) {
          context.addIssue({
            code: 'custom',
            message: '连接引用了不存在的标签',
            path: ['connections', index, 'tagIds', tagIndex],
          })
        }
      }
    }
  })

export const CONNECTION_STORE_VERSION = 3 as const

export const persistedConnectionCatalogSchema = z.strictObject({
  version: z.literal(CONNECTION_STORE_VERSION),
  data: connectionCatalogSchema,
})

export type PersistedConnectionCatalog = z.infer<typeof persistedConnectionCatalogSchema>

/**
 * Frozen v2 shape (free-text tags, required group, no tag catalog). Historical
 * schemas are kept verbatim so legacy files keep parsing as the current schema
 * evolves.
 */
const legacyConnectionProfileV2Schema = z.strictObject({
  id: z.string().regex(CONNECTION_ID, '连接 ID 格式无效'),
  name: nameSchema,
  host: hostSchema,
  port: portSchema,
  username: usernameSchema,
  authMethod: z.enum(AUTH_METHODS, { message: '请选择认证方式' }),
  groupId: groupIdSchema,
  tags: legacyTagsSchema,
  credentialRef: credentialRefSchema,
  jumpConnectionIds: jumpConnectionIdsSchema,
  favorite: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
})

const legacyConnectionCatalogV2Schema = z
  .strictObject({
    connections: z.array(legacyConnectionProfileV2Schema).max(MAX_CONNECTIONS),
    groups: z.array(connectionGroupSchema).max(MAX_CONNECTION_GROUPS),
  })
  .superRefine(addCatalogReferenceIssues)

export const persistedConnectionCatalogV2Schema = z.strictObject({
  version: z.literal(2),
  data: legacyConnectionCatalogV2Schema,
})

export type PersistedConnectionCatalogV2 = z.infer<typeof persistedConnectionCatalogV2Schema>

/**
 * Frozen v1 shape (no `jumpConnectionIds`). v1 was never reference-validated
 * at parse time; it is re-validated after migration instead.
 */
export const persistedConnectionCatalogV1Schema = z.strictObject({
  version: z.literal(1),
  data: z.strictObject({
    connections: z
      .array(
        z.strictObject({
          id: z.string().regex(CONNECTION_ID, '连接 ID 格式无效'),
          name: nameSchema,
          host: hostSchema,
          port: portSchema,
          username: usernameSchema,
          authMethod: z.enum(AUTH_METHODS, { message: '请选择认证方式' }),
          groupId: groupIdSchema,
          tags: legacyTagsSchema,
          credentialRef: credentialRefSchema,
          favorite: z.boolean(),
          createdAt: isoDateSchema,
          updatedAt: isoDateSchema,
        }),
      )
      .max(MAX_CONNECTIONS),
    groups: z.array(connectionGroupSchema).max(MAX_CONNECTION_GROUPS),
  }),
})

export type PersistedConnectionCatalogV1 = z.infer<typeof persistedConnectionCatalogV1Schema>

export interface ParsedPersistedCatalog {
  catalog: ConnectionCatalog
  /** 1 or 2 when the file was upgraded from a legacy envelope; null when current. */
  migratedFromVersion: 1 | 2 | null
}

interface LegacyMigratableConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: ConnectionProfile['authMethod']
  groupId: string
  tags: string[]
  credentialRef?: string
  jumpConnectionIds?: string[]
  favorite: boolean
  createdAt: string
  updatedAt: string
}

function normalizeTagName(name: string): string {
  return name.trim().toLowerCase()
}

function tagIdSlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function buildMigratedTags(connections: LegacyMigratableConnection[]): {
  tags: ConnectionTag[]
  idByName: Map<string, string>
} {
  const idByName = new Map<string, string>()
  const usedIds = new Set<string>()
  const tags: ConnectionTag[] = []

  for (const connection of connections) {
    for (const rawName of connection.tags) {
      const name = rawName.trim()
      const key = normalizeTagName(name)
      if (idByName.has(key)) continue

      const base = `tag-${tagIdSlug(name) || tags.length + 1}`
      let candidate = base
      let suffix = 2
      while (usedIds.has(candidate)) {
        candidate = `${base}-${suffix}`
        suffix += 1
      }

      usedIds.add(candidate)
      idByName.set(key, candidate)
      tags.push({ id: candidate, name, color: 'neutral' })
    }
  }

  return { tags, idByName }
}

function migrateLegacyCatalog(
  groups: ConnectionCatalog['groups'],
  connections: LegacyMigratableConnection[],
): ConnectionCatalog | null {
  const { tags, idByName } = buildMigratedTags(connections)
  const migrated = {
    tags,
    groups,
    connections: connections.map((connection) => {
      const { tags: legacyTags, ...rest } = connection
      return {
        ...rest,
        jumpConnectionIds: connection.jumpConnectionIds ?? [],
        tagIds: Array.from(
          new Set(legacyTags.map((name) => idByName.get(normalizeTagName(name)) as string)),
        ),
      }
    }),
  }

  const parsed = connectionCatalogSchema.safeParse(migrated)
  return parsed.success ? parsed.data : null
}

/**
 * Parses either the current or a legacy persisted envelope. v2 free-text tags
 * become a deterministic tag catalog, and v1 files additionally gain an empty
 * jump list; the migrated catalog is re-validated before it is trusted.
 */
export function parsePersistedConnectionCatalog(raw: unknown): ParsedPersistedCatalog | null {
  const current = persistedConnectionCatalogSchema.safeParse(raw)
  if (current.success) {
    return { catalog: current.data.data, migratedFromVersion: null }
  }

  const versionTwo = persistedConnectionCatalogV2Schema.safeParse(raw)
  if (versionTwo.success) {
    const catalog = migrateLegacyCatalog(
      versionTwo.data.data.groups,
      versionTwo.data.data.connections,
    )
    return catalog ? { catalog, migratedFromVersion: 2 } : null
  }

  const versionOne = persistedConnectionCatalogV1Schema.safeParse(raw)
  if (!versionOne.success) return null

  const catalog = migrateLegacyCatalog(
    versionOne.data.data.groups,
    versionOne.data.data.connections.map((connection) => ({
      ...connection,
      jumpConnectionIds: [],
    })),
  )
  return catalog ? { catalog, migratedFromVersion: 1 } : null
}

/**
 * Form-level schema. `port` arrives as a string and an empty group selection is
 * normalized to `null` (unassigned).
 */
export const connectionFormSchema = z
  .strictObject({
    name: nameSchema,
    host: hostSchema,
    port: z
      .string()
      .trim()
      .min(1, '请输入端口')
      .regex(/^\d+$/, '端口必须是数字')
      .transform((value) => Number(value))
      .pipe(portSchema),
    username: usernameSchema,
    authMethod: z.enum(AUTH_METHODS, { message: '请选择认证方式' }),
    groupId: z.union([z.literal(''), groupIdSchema]),
    tagIds: tagIdsSchema,
    credentialRef: z
      .string()
      .trim()
      .max(MAX_CREDENTIAL_REF_LENGTH, `凭据引用最多 ${MAX_CREDENTIAL_REF_LENGTH} 个字符`)
      .refine(isNonSecretReference, '凭据引用只能包含非机密的路径或标识，不能包含密钥内容'),
    jumpConnectionIds: jumpConnectionIdsSchema,
  })
  .transform((values) => {
    const credentialRef = values.credentialRef.trim()
    return {
      ...values,
      groupId: values.groupId === '' ? null : values.groupId,
      credentialRef: credentialRef.length > 0 ? credentialRef : undefined,
    }
  })

export type ConnectionFormValues = z.input<typeof connectionFormSchema>
export type ConnectionFormOutput = z.output<typeof connectionFormSchema>

export interface ConnectionFieldErrors {
  name?: string
  host?: string
  port?: string
  username?: string
  authMethod?: string
  groupId?: string
  tagIds?: string
  credentialRef?: string
  jumpConnectionIds?: string
}

export function toConnectionFieldErrors(error: z.ZodError): ConnectionFieldErrors {
  const errors: ConnectionFieldErrors = {}
  for (const issue of error.issues) {
    const key = issue.path[0]
    if (typeof key !== 'string' || key in errors) continue
    if (
      key === 'name' ||
      key === 'host' ||
      key === 'port' ||
      key === 'username' ||
      key === 'authMethod' ||
      key === 'groupId' ||
      key === 'tagIds' ||
      key === 'credentialRef' ||
      key === 'jumpConnectionIds'
    ) {
      errors[key] = issue.message
    }
  }
  return errors
}
