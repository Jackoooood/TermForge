import { randomUUID } from 'node:crypto'
import {
  DYNAMIC_FORWARD_BIND_ADDRESS,
  PORT_FORWARD_ID_PREFIX,
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_STORE_VERSION,
} from '../../shared/constants/portForward'
import {
  persistedPortForwardsSchema,
  portForwardCreateInputSchema,
  portForwardIdSchema,
  portForwardRuleSchema,
  portForwardUpdateInputSchema,
} from '../../shared/schemas/portForward'
import { connectionIdSchema } from '../../shared/schemas/ipc'
import type {
  PortForwardCreateInput,
  PortForwardRule,
  PortForwardStoreState,
  PortForwardUpdateInput,
} from '../../shared/types/portForward'
import { AppOperationError } from '../errors'
import { readJsonFile, writeJsonFileAtomic } from './jsonFile'

const STORAGE_LABEL = '端口转发规则'

function cloneState(state: PortForwardStoreState): PortForwardStoreState {
  return structuredClone(state)
}

function parseRuleId(id: string): string {
  const parsed = portForwardIdSchema.safeParse(id)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '端口转发规则 ID 格式无效。')
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

export interface PortForwardStore {
  list(): Promise<PortForwardStoreState>
  create(input: PortForwardCreateInput): Promise<PortForwardRule>
  update(id: string, input: PortForwardUpdateInput): Promise<PortForwardRule>
  remove(id: string): Promise<{ id: string }>
  removeForConnection(connectionId: string): Promise<{ ids: string[] }>
}

export class PortForwardRepository implements PortForwardStore {
  private state: PortForwardStoreState | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  list(): Promise<PortForwardStoreState> {
    return this.exclusive(async () => cloneState(await this.loadState()))
  }

  create(input: PortForwardCreateInput): Promise<PortForwardRule> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const parsed = portForwardCreateInputSchema.safeParse(input)
      if (!parsed.success) {
        throw new AppOperationError('invalid-input', '转发规则未通过校验，请检查字段后重试。')
      }
      if (state.rules.length >= PORT_FORWARD_LIMITS.maxRules) {
        throw new AppOperationError(
          'limit-exceeded',
          `端口转发规则数量已达到上限（${PORT_FORWARD_LIMITS.maxRules} 条）。`,
        )
      }

      const now = new Date().toISOString()
      const draft =
        parsed.data.type === 'dynamic'
          ? {
              ...parsed.data,
              bindAddress: DYNAMIC_FORWARD_BIND_ADDRESS,
              id: `${PORT_FORWARD_ID_PREFIX}${randomUUID()}`,
              createdAt: now,
              updatedAt: now,
            }
          : {
              ...parsed.data,
              id: `${PORT_FORWARD_ID_PREFIX}${randomUUID()}`,
              createdAt: now,
              updatedAt: now,
            }
      const rule = portForwardRuleSchema.parse(draft)
      const next: PortForwardStoreState = { rules: [...state.rules, rule] }
      await this.persist(next)
      this.state = next
      return structuredClone(rule)
    })
  }

  update(id: string, input: PortForwardUpdateInput): Promise<PortForwardRule> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const ruleId = parseRuleId(id)
      const index = state.rules.findIndex((rule) => rule.id === ruleId)
      const existing = state.rules[index]
      if (!existing) {
        throw new AppOperationError('not-found', '找不到该端口转发规则，可能已被删除。')
      }

      const parsed = portForwardUpdateInputSchema.safeParse(input)
      if (!parsed.success) {
        throw new AppOperationError('invalid-input', '转发规则未通过校验，请检查字段后重试。')
      }
      if (parsed.data.type !== existing.type) {
        throw new AppOperationError('invalid-input', '不能修改已有转发规则的类型。')
      }

      const updated = portForwardRuleSchema.parse({
        ...existing,
        ...parsed.data,
        id: existing.id,
        connectionId: existing.connectionId,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      })
      const rules = [...state.rules]
      rules[index] = updated
      const next: PortForwardStoreState = { rules }
      await this.persist(next)
      this.state = next
      return structuredClone(updated)
    })
  }

  remove(id: string): Promise<{ id: string }> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const ruleId = parseRuleId(id)
      if (!state.rules.some((rule) => rule.id === ruleId)) {
        throw new AppOperationError('not-found', '找不到该端口转发规则，可能已被删除。')
      }
      const next: PortForwardStoreState = {
        rules: state.rules.filter((rule) => rule.id !== ruleId),
      }
      await this.persist(next)
      this.state = next
      return { id: ruleId }
    })
  }

  removeForConnection(connectionId: string): Promise<{ ids: string[] }> {
    return this.exclusive(async () => {
      const state = await this.loadState()
      const parsedConnectionId = parseConnectionId(connectionId)
      const removed = state.rules.filter((rule) => rule.connectionId === parsedConnectionId)
      if (removed.length === 0) return { ids: [] }

      const next: PortForwardStoreState = {
        rules: state.rules.filter((rule) => rule.connectionId !== parsedConnectionId),
      }
      await this.persist(next)
      this.state = next
      return { ids: removed.map((rule) => rule.id) }
    })
  }

  private async loadState(): Promise<PortForwardStoreState> {
    if (this.state) return this.state

    const raw = await readJsonFile(this.filePath, STORAGE_LABEL)
    if (raw === null) {
      const empty: PortForwardStoreState = { rules: [] }
      await this.persist(empty)
      this.state = empty
      return empty
    }

    const parsed = persistedPortForwardsSchema.safeParse(raw)
    if (!parsed.success) {
      throw new AppOperationError(
        'storage-corrupt',
        '本地端口转发规则损坏或版本不受支持，已停止加载以避免覆盖现有数据。',
      )
    }

    this.state = parsed.data.data
    return this.state
  }

  private async persist(state: PortForwardStoreState): Promise<void> {
    await writeJsonFileAtomic(
      this.filePath,
      { version: PORT_FORWARD_STORE_VERSION, data: state },
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
