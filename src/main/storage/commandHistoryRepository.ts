import { randomUUID } from 'node:crypto'
import {
  COMMAND_HISTORY_ID_PREFIX,
  COMMAND_HISTORY_STORE_VERSION,
  QUICK_COMMAND_LIMITS,
} from '../../shared/constants/quickCommands'
import {
  commandHistoryEntrySchema,
  commandHistoryIdSchema,
  persistedCommandHistorySchema,
} from '../../shared/schemas/quickCommands'
import type {
  CommandHistoryAppendInput,
  CommandHistoryClearAck,
  CommandHistoryEntry,
  CommandHistoryStoreState,
} from '../../shared/types/quickCommands'
import { AppOperationError } from '../errors'
import { readJsonFile, writeJsonFileAtomic } from './jsonFile'

const STORAGE_LABEL = '命令历史'

function cloneState(state: CommandHistoryStoreState): CommandHistoryStoreState {
  return structuredClone(state)
}

export interface CommandHistoryStore {
  list(): Promise<CommandHistoryStoreState>
  append(input: CommandHistoryAppendInput): Promise<CommandHistoryEntry>
  remove(id: string): Promise<{ id: string }>
  clear(): Promise<CommandHistoryClearAck>
}

/**
 * Command history is deliberately separate from application logs. It stores
 * only the rendered command text and target metadata; terminal output, exit
 * codes and credentials are never captured here.
 */
export class CommandHistoryRepository implements CommandHistoryStore {
  private state: CommandHistoryStoreState | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  list(): Promise<CommandHistoryStoreState> {
    return this.exclusive(async () => cloneState(await this.loadState()))
  }

  append(input: CommandHistoryAppendInput): Promise<CommandHistoryEntry> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const entry = commandHistoryEntrySchema.parse({
        ...input,
        id: `${COMMAND_HISTORY_ID_PREFIX}${randomUUID()}`,
        sentAt: new Date().toISOString(),
      })
      const entries = [entry, ...state.entries].slice(0, QUICK_COMMAND_LIMITS.maxHistoryEntries)
      const next: CommandHistoryStoreState = { entries }
      await this.persist(next)
      this.state = next
      return structuredClone(entry)
    })
  }

  remove(id: string): Promise<{ id: string }> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const parsed = commandHistoryIdSchema.safeParse(id)
      if (!parsed.success) {
        throw new AppOperationError('invalid-input', '历史记录 ID 格式无效。')
      }
      if (!state.entries.some((entry) => entry.id === parsed.data)) {
        throw new AppOperationError('not-found', '找不到该历史记录，可能已被删除。')
      }
      const next: CommandHistoryStoreState = {
        entries: state.entries.filter((entry) => entry.id !== parsed.data),
      }
      await this.persist(next)
      this.state = next
      return { id: parsed.data }
    })
  }

  /**
   * Clearing is the only operation allowed to replace a corrupt history file;
   * ordinary loads never overwrite data they cannot parse.
   */
  clear(): Promise<CommandHistoryClearAck> {
    return this.exclusive(async () => {
      let cleared = 0
      try {
        cleared = (await this.loadState()).entries.length
      } catch {
        cleared = 0
      }
      const next: CommandHistoryStoreState = { entries: [] }
      await this.persist(next)
      this.state = next
      return { cleared }
    })
  }

  private async loadState(): Promise<CommandHistoryStoreState> {
    if (this.state) return this.state

    const raw = await readJsonFile(this.filePath, STORAGE_LABEL)
    if (raw === null) {
      this.state = { entries: [] }
      return this.state
    }

    const parsed = persistedCommandHistorySchema.safeParse(raw)
    if (!parsed.success) {
      throw new AppOperationError(
        'storage-corrupt',
        '本地命令历史损坏或版本不受支持，已停止加载以避免覆盖现有数据；可在设置中清除历史。',
      )
    }

    this.state = parsed.data.data
    return this.state
  }

  private async persist(state: CommandHistoryStoreState): Promise<void> {
    await writeJsonFileAtomic(
      this.filePath,
      { version: COMMAND_HISTORY_STORE_VERSION, data: state },
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
