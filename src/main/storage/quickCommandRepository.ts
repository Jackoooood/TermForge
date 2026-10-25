import { randomUUID } from 'node:crypto'
import {
  BUILT_IN_COMMAND_ID_PREFIX,
  CUSTOM_QUICK_COMMAND_ID_PREFIX,
  QUICK_COMMAND_LIMITS,
  QUICK_COMMAND_STORE_VERSION,
} from '../../shared/constants/quickCommands'
import {
  customQuickCommandIdSchema,
  persistedCustomQuickCommandSchema,
  persistedQuickCommandsSchema,
  quickCommandDraftSchema,
  quickCommandReferenceIdSchema,
} from '../../shared/schemas/quickCommands'
import type {
  PersistedCustomQuickCommand,
  QuickCommandDraft,
  QuickCommandStoreState,
} from '../../shared/types/quickCommands'
import { AppOperationError } from '../errors'
import { readJsonFile, writeJsonFileAtomic } from './jsonFile'

const STORAGE_LABEL = '快速命令'

function emptyState(): QuickCommandStoreState {
  return { customCommands: [], builtInFavoriteIds: [] }
}

function cloneState(state: QuickCommandStoreState): QuickCommandStoreState {
  return structuredClone(state)
}

export interface QuickCommandStore {
  list(): Promise<QuickCommandStoreState>
  create(input: QuickCommandDraft): Promise<PersistedCustomQuickCommand>
  update(id: string, input: QuickCommandDraft): Promise<PersistedCustomQuickCommand>
  remove(id: string): Promise<{ id: string }>
  setFavorite(id: string, favorite: boolean): Promise<QuickCommandStoreState>
}

export class QuickCommandRepository implements QuickCommandStore {
  private state: QuickCommandStoreState | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  list(): Promise<QuickCommandStoreState> {
    return this.exclusive(async () => cloneState(await this.loadState()))
  }

  create(input: QuickCommandDraft): Promise<PersistedCustomQuickCommand> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const parsed = quickCommandDraftSchema.safeParse(input)
      if (!parsed.success) {
        throw new AppOperationError('invalid-input', '快速命令未通过校验，请检查字段后重试。')
      }
      if (state.customCommands.length >= QUICK_COMMAND_LIMITS.maxCustomCommands) {
        throw new AppOperationError(
          'limit-exceeded',
          `自定义命令数量已达到上限（${QUICK_COMMAND_LIMITS.maxCustomCommands} 条）。`,
        )
      }

      const now = new Date().toISOString()
      const command = persistedCustomQuickCommandSchema.parse({
        ...parsed.data,
        id: `${CUSTOM_QUICK_COMMAND_ID_PREFIX}${randomUUID()}`,
        favorite: false,
        createdAt: now,
        updatedAt: now,
      })
      const next: QuickCommandStoreState = {
        ...state,
        customCommands: [...state.customCommands, command],
      }
      await this.persist(next)
      this.state = next
      return structuredClone(command)
    })
  }

  update(id: string, input: QuickCommandDraft): Promise<PersistedCustomQuickCommand> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const commandId = this.parseCustomId(id)
      const index = state.customCommands.findIndex((command) => command.id === commandId)
      const existing = state.customCommands[index]
      if (!existing) {
        throw new AppOperationError('not-found', '找不到该自定义命令，可能已被删除。')
      }

      const parsed = quickCommandDraftSchema.safeParse(input)
      if (!parsed.success) {
        throw new AppOperationError('invalid-input', '快速命令未通过校验，请检查字段后重试。')
      }

      const updated = persistedCustomQuickCommandSchema.parse({
        ...parsed.data,
        id: existing.id,
        favorite: existing.favorite,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      })
      const customCommands = [...state.customCommands]
      customCommands[index] = updated
      const next: QuickCommandStoreState = { ...state, customCommands }
      await this.persist(next)
      this.state = next
      return structuredClone(updated)
    })
  }

  remove(id: string): Promise<{ id: string }> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const commandId = this.parseCustomId(id)
      if (!state.customCommands.some((command) => command.id === commandId)) {
        throw new AppOperationError('not-found', '找不到该自定义命令，可能已被删除。')
      }
      const next: QuickCommandStoreState = {
        ...state,
        customCommands: state.customCommands.filter((command) => command.id !== commandId),
      }
      await this.persist(next)
      this.state = next
      return { id: commandId }
    })
  }

  setFavorite(id: string, favorite: boolean): Promise<QuickCommandStoreState> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const parsed = quickCommandReferenceIdSchema.safeParse(id)
      if (!parsed.success) {
        throw new AppOperationError('invalid-input', '命令 ID 格式无效。')
      }
      const commandId = parsed.data

      if (commandId.startsWith(BUILT_IN_COMMAND_ID_PREFIX)) {
        const alreadyFavorite = state.builtInFavoriteIds.includes(commandId)
        if (favorite && !alreadyFavorite) {
          if (state.builtInFavoriteIds.length >= QUICK_COMMAND_LIMITS.maxBuiltInFavorites) {
            throw new AppOperationError('limit-exceeded', '内置命令收藏数量已达到上限。')
          }
        }
        const builtInFavoriteIds = favorite
          ? alreadyFavorite
            ? state.builtInFavoriteIds
            : [...state.builtInFavoriteIds, commandId]
          : state.builtInFavoriteIds.filter((favoriteId) => favoriteId !== commandId)
        if (builtInFavoriteIds === state.builtInFavoriteIds) return cloneState(state)

        const next: QuickCommandStoreState = { ...state, builtInFavoriteIds }
        await this.persist(next)
        this.state = next
        return cloneState(next)
      }

      const index = state.customCommands.findIndex((command) => command.id === commandId)
      const existing = state.customCommands[index]
      if (!existing) {
        throw new AppOperationError('not-found', '找不到该自定义命令，可能已被删除。')
      }
      if (existing.favorite === favorite) return cloneState(state)

      const customCommands = [...state.customCommands]
      customCommands[index] = { ...existing, favorite }
      const next: QuickCommandStoreState = { ...state, customCommands }
      await this.persist(next)
      this.state = next
      return cloneState(next)
    })
  }

  private parseCustomId(id: string): string {
    const parsed = customQuickCommandIdSchema.safeParse(id)
    if (!parsed.success) {
      throw new AppOperationError('invalid-input', '命令 ID 格式无效。')
    }
    return parsed.data
  }

  private async loadState(): Promise<QuickCommandStoreState> {
    if (this.state) return this.state

    const raw = await readJsonFile(this.filePath, STORAGE_LABEL)
    if (raw === null) {
      this.state = emptyState()
      return this.state
    }

    const parsed = persistedQuickCommandsSchema.safeParse(raw)
    if (!parsed.success) {
      throw new AppOperationError(
        'storage-corrupt',
        '本地快速命令数据损坏或版本不受支持，已停止加载以避免覆盖现有数据。',
      )
    }

    this.state = parsed.data.data
    return this.state
  }

  private async persist(state: QuickCommandStoreState): Promise<void> {
    await writeJsonFileAtomic(
      this.filePath,
      { version: QUICK_COMMAND_STORE_VERSION, data: state },
      STORAGE_LABEL,
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
