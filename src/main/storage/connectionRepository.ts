import { randomUUID } from 'node:crypto'
import {
  MAX_CONNECTION_GROUPS,
  MAX_CONNECTION_TAGS,
  MAX_CONNECTIONS,
  MAX_TAGS,
} from '../../shared/constants/app'
import {
  CONNECTION_STORE_VERSION,
  connectionBulkActionSchema,
  connectionCatalogSchema,
  connectionGroupDraftSchema,
  connectionGroupIdSchema,
  connectionGroupSchema,
  connectionInputSchema,
  connectionProfileSchema,
  connectionTagDraftSchema,
  connectionTagIdSchema,
  connectionTagSchema,
  parsePersistedConnectionCatalog,
} from '../../shared/schemas/connection'
import { connectionIdSchema } from '../../shared/schemas/ipc'
import type {
  ConnectionBulkAction,
  ConnectionBulkFailure,
  ConnectionBulkResult,
  ConnectionCatalog,
  ConnectionGroup,
  ConnectionGroupDraft,
  ConnectionInput,
  ConnectionProfile,
  ConnectionTagDraft,
} from '../../shared/types/connection'
import { SEED_CONNECTION_CATALOG } from '../../shared/fixtures/connectionSeed'
import { AppOperationError } from '../errors'
import { readJsonFile, writeJsonFileAtomic } from './jsonFile'

function cloneCatalog(catalog: ConnectionCatalog): ConnectionCatalog {
  return structuredClone(catalog)
}

function cloneConnection(connection: ConnectionProfile): ConnectionProfile {
  return structuredClone(connection)
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function parseInput(input: ConnectionInput): ConnectionInput {
  const parsed = connectionInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '连接配置未通过校验，请检查字段后重试。')
  }
  return parsed.data
}

function parseConnectionId(id: string): string {
  const parsed = connectionIdSchema.safeParse(id)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '连接 ID 格式无效。')
  }
  return parsed.data
}

function parseGroupId(id: string): string {
  const parsed = connectionGroupIdSchema.safeParse(id)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '分组 ID 格式无效。')
  }
  return parsed.data
}

function parseTagId(id: string): string {
  const parsed = connectionTagIdSchema.safeParse(id)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '标签 ID 格式无效。')
  }
  return parsed.data
}

function parseGroupDraft(draft: ConnectionGroupDraft): ConnectionGroupDraft {
  const parsed = connectionGroupDraftSchema.safeParse(draft)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '分组名称未通过校验。')
  }
  return parsed.data
}

function parseTagDraft(draft: ConnectionTagDraft): ConnectionTagDraft {
  const parsed = connectionTagDraftSchema.safeParse(draft)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '标签定义未通过校验。')
  }
  return parsed.data
}

export interface ConnectionStore {
  list(): Promise<ConnectionCatalog>
  create(input: ConnectionInput): Promise<ConnectionProfile>
  update(id: string, input: ConnectionInput): Promise<ConnectionProfile>
  remove(id: string): Promise<{ id: string }>
  setFavorite(id: string, favorite: boolean): Promise<ConnectionProfile>
}

export interface ConnectionOrganizationStore extends ConnectionStore {
  createGroup(draft: ConnectionGroupDraft): Promise<ConnectionCatalog>
  updateGroup(id: string, draft: ConnectionGroupDraft): Promise<ConnectionCatalog>
  removeGroup(id: string): Promise<ConnectionCatalog>
  reorderGroups(ids: string[]): Promise<ConnectionCatalog>
  createTag(draft: ConnectionTagDraft): Promise<ConnectionCatalog>
  updateTag(id: string, draft: ConnectionTagDraft): Promise<ConnectionCatalog>
  removeTag(id: string): Promise<ConnectionCatalog>
  bulkUpdate(ids: string[], action: ConnectionBulkAction): Promise<ConnectionBulkResult>
}

export class ConnectionRepository implements ConnectionOrganizationStore {
  private catalog: ConnectionCatalog | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly seed: ConnectionCatalog

  constructor(
    private readonly filePath: string,
    seed: ConnectionCatalog = SEED_CONNECTION_CATALOG,
  ) {
    const parsedSeed = connectionCatalogSchema.safeParse(seed)
    if (!parsedSeed.success) {
      throw new Error('Invalid built-in connection seed')
    }
    this.seed = cloneCatalog(parsedSeed.data)
  }

  list(): Promise<ConnectionCatalog> {
    return this.exclusive(async () => cloneCatalog(await this.loadState()))
  }

  create(input: ConnectionInput): Promise<ConnectionProfile> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const parsedInput = parseInput(input)
      this.assertGroupExists(state, parsedInput.groupId)
      this.assertTagReferences(state, parsedInput.tagIds)

      const now = new Date().toISOString()
      const profile = connectionProfileSchema.parse({
        ...parsedInput,
        id: `conn-${randomUUID()}`,
        favorite: false,
        createdAt: now,
        updatedAt: now,
      })
      this.assertJumpReferences(state, profile.jumpConnectionIds, profile.id)
      const next: ConnectionCatalog = {
        ...state,
        connections: [profile, ...state.connections],
      }
      await this.persist(next)
      this.catalog = next
      return cloneConnection(profile)
    })
  }

  update(id: string, input: ConnectionInput): Promise<ConnectionProfile> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const connectionId = parseConnectionId(id)
      const existingIndex = state.connections.findIndex(
        (connection) => connection.id === connectionId,
      )
      const existing = state.connections[existingIndex]
      if (!existing) {
        throw new AppOperationError('not-found', '找不到该连接，可能已被删除。')
      }

      const parsedInput = parseInput(input)
      this.assertGroupExists(state, parsedInput.groupId)
      this.assertTagReferences(state, parsedInput.tagIds)
      const updated = connectionProfileSchema.parse({
        ...existing,
        ...parsedInput,
        updatedAt: new Date().toISOString(),
      })
      this.assertJumpReferences(state, updated.jumpConnectionIds, updated.id)
      const connections = [...state.connections]
      connections[existingIndex] = updated
      const next: ConnectionCatalog = { ...state, connections }
      await this.persist(next)
      this.catalog = next
      return cloneConnection(updated)
    })
  }

  remove(id: string): Promise<{ id: string }> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const connectionId = parseConnectionId(id)
      if (!state.connections.some((connection) => connection.id === connectionId)) {
        throw new AppOperationError('not-found', '找不到该连接，可能已被删除。')
      }

      // Jump references to the removed connection are stripped in the same
      // atomic write; dangling references would invalidate the whole catalog.
      const now = new Date().toISOString()
      const next: ConnectionCatalog = {
        ...state,
        connections: state.connections
          .filter((connection) => connection.id !== connectionId)
          .map((connection) =>
            connection.jumpConnectionIds.includes(connectionId)
              ? {
                  ...connection,
                  jumpConnectionIds: connection.jumpConnectionIds.filter(
                    (jumpId) => jumpId !== connectionId,
                  ),
                  updatedAt: now,
                }
              : connection,
          ),
      }
      await this.persist(next)
      this.catalog = next
      return { id: connectionId }
    })
  }

  setFavorite(id: string, favorite: boolean): Promise<ConnectionProfile> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const connectionId = parseConnectionId(id)
      const existingIndex = state.connections.findIndex(
        (connection) => connection.id === connectionId,
      )
      const existing = state.connections[existingIndex]
      if (!existing) {
        throw new AppOperationError('not-found', '找不到该连接，可能已被删除。')
      }
      if (typeof favorite !== 'boolean') {
        throw new AppOperationError('invalid-input', '收藏状态格式无效。')
      }
      if (existing.favorite === favorite) return cloneConnection(existing)

      const updated = connectionProfileSchema.parse({
        ...existing,
        favorite,
        updatedAt: new Date().toISOString(),
      })
      const connections = [...state.connections]
      connections[existingIndex] = updated
      const next: ConnectionCatalog = { ...state, connections }
      await this.persist(next)
      this.catalog = next
      return cloneConnection(updated)
    })
  }

  createGroup(draft: ConnectionGroupDraft): Promise<ConnectionCatalog> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const parsedDraft = parseGroupDraft(draft)
      this.assertGroupNameAvailable(state, parsedDraft.name)
      if (state.groups.length >= MAX_CONNECTION_GROUPS) {
        throw new AppOperationError('invalid-input', '分组数量已达上限。')
      }

      let groups = state.groups
      if (groups.length > 0 && Math.max(...groups.map((group) => group.sortOrder)) >= 10_000) {
        groups = groups.map((group, index) => ({ ...group, sortOrder: index + 1 }))
      }
      const sortOrder = groups.reduce((max, group) => Math.max(max, group.sortOrder), 0) + 1
      const group = connectionGroupSchema.parse({
        id: `group-${randomUUID()}`,
        name: parsedDraft.name,
        tone: 'neutral',
        sortOrder,
      })
      const next: ConnectionCatalog = { ...state, groups: [...groups, group] }
      await this.persist(next)
      this.catalog = next
      return cloneCatalog(next)
    })
  }

  updateGroup(id: string, draft: ConnectionGroupDraft): Promise<ConnectionCatalog> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const groupId = parseGroupId(id)
      const parsedDraft = parseGroupDraft(draft)
      const existingIndex = state.groups.findIndex((group) => group.id === groupId)
      const existing = state.groups[existingIndex]
      if (!existing) {
        throw new AppOperationError('not-found', '找不到该分组，可能已被删除。')
      }
      this.assertGroupNameAvailable(state, parsedDraft.name, groupId)
      if (existing.name === parsedDraft.name) return cloneCatalog(state)

      const groups = [...state.groups]
      groups[existingIndex] = connectionGroupSchema.parse({
        ...existing,
        name: parsedDraft.name,
      })
      const next: ConnectionCatalog = { ...state, groups }
      await this.persist(next)
      this.catalog = next
      return cloneCatalog(next)
    })
  }

  removeGroup(id: string): Promise<ConnectionCatalog> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const groupId = parseGroupId(id)
      if (!state.groups.some((group) => group.id === groupId)) {
        throw new AppOperationError('not-found', '找不到该分组，可能已被删除。')
      }

      const now = new Date().toISOString()
      const next: ConnectionCatalog = {
        ...state,
        groups: state.groups.filter((group) => group.id !== groupId),
        connections: state.connections.map((connection) =>
          connection.groupId === groupId
            ? { ...connection, groupId: null, updatedAt: now }
            : connection,
        ),
      }
      await this.persist(next)
      this.catalog = next
      return cloneCatalog(next)
    })
  }

  reorderGroups(ids: string[]): Promise<ConnectionCatalog> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      if (!Array.isArray(ids) || ids.length !== state.groups.length) {
        throw new AppOperationError('invalid-input', '分组排序必须包含全部现有分组。')
      }
      const parsedIds = ids.map(parseGroupId)
      if (!hasUniqueValues(parsedIds)) {
        throw new AppOperationError('invalid-input', '分组排序不能包含重复分组。')
      }

      const byId = new Map(state.groups.map((group) => [group.id, group]))
      if (!parsedIds.every((groupId) => byId.has(groupId))) {
        throw new AppOperationError('invalid-input', '分组排序必须包含全部现有分组。')
      }

      const current = [...state.groups].sort((left, right) => left.sortOrder - right.sortOrder)
      if (current.every((group, index) => group.id === parsedIds[index])) {
        return cloneCatalog(state)
      }

      const groups = parsedIds.map((groupId, index) => ({
        ...(byId.get(groupId) as ConnectionGroup),
        sortOrder: index + 1,
      }))
      const next: ConnectionCatalog = { ...state, groups }
      await this.persist(next)
      this.catalog = next
      return cloneCatalog(next)
    })
  }

  createTag(draft: ConnectionTagDraft): Promise<ConnectionCatalog> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const parsedDraft = parseTagDraft(draft)
      this.assertTagNameAvailable(state, parsedDraft.name)
      if (state.tags.length >= MAX_CONNECTION_TAGS) {
        throw new AppOperationError('invalid-input', '标签数量已达上限。')
      }

      const tag = connectionTagSchema.parse({
        id: `tag-${randomUUID()}`,
        name: parsedDraft.name,
        color: parsedDraft.color,
      })
      const next: ConnectionCatalog = { ...state, tags: [...state.tags, tag] }
      await this.persist(next)
      this.catalog = next
      return cloneCatalog(next)
    })
  }

  updateTag(id: string, draft: ConnectionTagDraft): Promise<ConnectionCatalog> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const tagId = parseTagId(id)
      const parsedDraft = parseTagDraft(draft)
      const existingIndex = state.tags.findIndex((tag) => tag.id === tagId)
      const existing = state.tags[existingIndex]
      if (!existing) {
        throw new AppOperationError('not-found', '找不到该标签，可能已被删除。')
      }
      this.assertTagNameAvailable(state, parsedDraft.name, tagId)
      if (existing.name === parsedDraft.name && existing.color === parsedDraft.color) {
        return cloneCatalog(state)
      }

      const tags = [...state.tags]
      tags[existingIndex] = connectionTagSchema.parse({
        ...existing,
        name: parsedDraft.name,
        color: parsedDraft.color,
      })
      const next: ConnectionCatalog = { ...state, tags }
      await this.persist(next)
      this.catalog = next
      return cloneCatalog(next)
    })
  }

  removeTag(id: string): Promise<ConnectionCatalog> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const tagId = parseTagId(id)
      if (!state.tags.some((tag) => tag.id === tagId)) {
        throw new AppOperationError('not-found', '找不到该标签，可能已被删除。')
      }

      const now = new Date().toISOString()
      const next: ConnectionCatalog = {
        ...state,
        tags: state.tags.filter((tag) => tag.id !== tagId),
        connections: state.connections.map((connection) =>
          connection.tagIds.includes(tagId)
            ? {
                ...connection,
                tagIds: connection.tagIds.filter((tagIdValue) => tagIdValue !== tagId),
                updatedAt: now,
              }
            : connection,
        ),
      }
      await this.persist(next)
      this.catalog = next
      return cloneCatalog(next)
    })
  }

  bulkUpdate(ids: string[], action: ConnectionBulkAction): Promise<ConnectionBulkResult> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CONNECTIONS) {
        throw new AppOperationError('invalid-input', '请选择要更新的连接。')
      }
      const parsedAction = connectionBulkActionSchema.safeParse(action)
      if (!parsedAction.success) {
        throw new AppOperationError('invalid-input', '批量操作参数未通过校验。')
      }
      const parsedIds = Array.from(new Set(ids.map(parseConnectionId)))
      const parsed = parsedAction.data

      this.assertBulkActionReferences(state, parsed)

      const byId = new Map(state.connections.map((connection) => [connection.id, connection]))
      const failures: ConnectionBulkFailure[] = []
      const updated: ConnectionProfile[] = []
      const now = new Date().toISOString()

      for (const connectionId of parsedIds) {
        const existing = byId.get(connectionId)
        if (!existing) {
          failures.push({
            id: connectionId,
            code: 'not-found',
            message: '找不到该连接，可能已被删除。',
          })
          continue
        }

        let nextProfile: ConnectionProfile | null = null
        switch (parsed.type) {
          case 'favorite':
            if (existing.favorite !== parsed.favorite) {
              nextProfile = connectionProfileSchema.parse({
                ...existing,
                favorite: parsed.favorite,
                updatedAt: now,
              })
            }
            break
          case 'set-group':
            if (existing.groupId !== parsed.groupId) {
              nextProfile = connectionProfileSchema.parse({
                ...existing,
                groupId: parsed.groupId,
                updatedAt: now,
              })
            }
            break
          case 'add-tags': {
            const addTagIds = parsed.tagIds
            const combined = Array.from(new Set([...existing.tagIds, ...addTagIds]))
            if (combined.length > MAX_TAGS) {
              failures.push({
                id: connectionId,
                code: 'invalid-input',
                message: `标签数量不能超过 ${MAX_TAGS} 个。`,
              })
              break
            }
            if (combined.length !== existing.tagIds.length) {
              nextProfile = connectionProfileSchema.parse({
                ...existing,
                tagIds: combined,
                updatedAt: now,
              })
            }
            break
          }
          case 'remove-tags': {
            const removeTagIds = parsed.tagIds
            const remaining = existing.tagIds.filter((tagId) => !removeTagIds.includes(tagId))
            if (remaining.length !== existing.tagIds.length) {
              nextProfile = connectionProfileSchema.parse({
                ...existing,
                tagIds: remaining,
                updatedAt: now,
              })
            }
            break
          }
        }

        if (nextProfile) {
          byId.set(connectionId, nextProfile)
          updated.push(cloneConnection(nextProfile))
        }
      }

      if (updated.length > 0) {
        const next: ConnectionCatalog = {
          ...state,
          connections: state.connections.map((connection) => byId.get(connection.id) ?? connection),
        }
        await this.persist(next)
        this.catalog = next
      }

      return { updated, failures }
    })
  }

  private assertGroupExists(catalog: ConnectionCatalog, groupId: string | null): void {
    if (groupId === null) return
    if (!catalog.groups.some((group) => group.id === groupId)) {
      throw new AppOperationError('invalid-input', '所选分组不存在，请重新选择。')
    }
  }

  private assertTagReferences(catalog: ConnectionCatalog, tagIds: string[]): void {
    if (tagIds.length === 0) return
    const existing = new Set(catalog.tags.map((tag) => tag.id))
    if (!tagIds.every((tagId) => existing.has(tagId))) {
      throw new AppOperationError('invalid-input', '所选标签不存在，请重新选择。')
    }
  }

  private assertTagNameAvailable(
    catalog: ConnectionCatalog,
    name: string,
    exceptTagId?: string,
  ): void {
    const normalized = normalizeName(name)
    if (
      catalog.tags.some((tag) => tag.id !== exceptTagId && normalizeName(tag.name) === normalized)
    ) {
      throw new AppOperationError('invalid-input', '标签名称已存在，请使用其他名称。')
    }
  }

  private assertGroupNameAvailable(
    catalog: ConnectionCatalog,
    name: string,
    exceptGroupId?: string,
  ): void {
    const normalized = normalizeName(name)
    if (
      catalog.groups.some(
        (group) => group.id !== exceptGroupId && normalizeName(group.name) === normalized,
      )
    ) {
      throw new AppOperationError('invalid-input', '分组名称已存在，请使用其他名称。')
    }
  }

  private assertBulkActionReferences(
    catalog: ConnectionCatalog,
    action: ConnectionBulkAction,
  ): void {
    if (action.type === 'set-group' && action.groupId !== null) {
      this.assertGroupExists(catalog, action.groupId)
    }
    if (action.type === 'add-tags' || action.type === 'remove-tags') {
      this.assertTagReferences(catalog, action.tagIds)
    }
  }

  private assertJumpReferences(
    catalog: ConnectionCatalog,
    jumpConnectionIds: string[],
    sourceId: string,
  ): void {
    if (jumpConnectionIds.length === 0) return

    const byId = new Map(catalog.connections.map((connection) => [connection.id, connection]))
    for (const jumpId of jumpConnectionIds) {
      if (jumpId === sourceId) {
        throw new AppOperationError('invalid-input', '连接不能把自身设为跳板。')
      }
      if (!byId.has(jumpId)) {
        throw new AppOperationError('invalid-input', '所选跳板连接不存在，请重新选择。')
      }
    }

    // Only the edited connection's outgoing edges can change, so a new cycle
    // must run through `sourceId`; walking the jump graph proves that it does not.
    const edges = new Map<string, readonly string[]>()
    for (const connection of catalog.connections) {
      edges.set(
        connection.id,
        connection.id === sourceId ? jumpConnectionIds : connection.jumpConnectionIds,
      )
    }
    edges.set(sourceId, jumpConnectionIds)

    const visited = new Set<string>()
    const stack = [...jumpConnectionIds]
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (current === sourceId) {
        throw new AppOperationError('invalid-input', '跳板配置会形成循环引用，请调整跳板顺序。')
      }
      if (visited.has(current)) continue
      visited.add(current)
      for (const next of edges.get(current) ?? []) {
        if (!visited.has(next)) stack.push(next)
      }
    }
  }

  private async loadState(): Promise<ConnectionCatalog> {
    if (this.catalog) return this.catalog

    const raw = await readJsonFile(this.filePath, '本地连接配置')
    if (raw === null) {
      await this.persist(this.seed)
      this.catalog = cloneCatalog(this.seed)
      return this.catalog
    }

    const parsed = parsePersistedConnectionCatalog(raw)
    if (!parsed) {
      throw new AppOperationError(
        'storage-corrupt',
        '本地连接配置损坏或版本不受支持，已停止加载以避免覆盖现有数据。',
      )
    }

    // Legacy files are upgraded and written back once so subsequent loads take
    // the current path; a failed write aborts before the catalog is trusted.
    if (parsed.migratedFromVersion !== null) {
      await this.persist(parsed.catalog)
    }

    const catalog = parsed.catalog
    this.catalog = catalog
    return catalog
  }

  private async persist(catalog: ConnectionCatalog): Promise<void> {
    const envelope = {
      version: CONNECTION_STORE_VERSION,
      data: catalog,
    }
    await writeJsonFileAtomic(this.filePath, envelope, '本地连接配置')
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
