import type {
  ConnectionCatalog,
  ConnectionInput,
  ConnectionProfile,
  ConnectionRemovalOptions,
} from '@shared/types'
import type { OperationErrorCode, OperationResult } from '@shared/types/ipc'
import { connectionCatalogSchema, connectionProfileSchema } from '@shared/schemas/connection'
import type { ConnectionService } from './connectionService'

export type ConnectionServiceErrorCode =
  OperationErrorCode | 'bridge-unavailable' | 'invalid-response'

export class ConnectionServiceError extends Error {
  readonly code: ConnectionServiceErrorCode

  constructor(code: ConnectionServiceErrorCode, message: string) {
    super(message)
    this.name = 'ConnectionServiceError'
    this.code = code
  }
}

function bridge() {
  const value = window.termforge
  if (!value) {
    throw new ConnectionServiceError(
      'bridge-unavailable',
      '本地连接存储仅在 Electron 桌面应用中可用；当前无法读取或保存连接。',
    )
  }
  return value
}

function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new ConnectionServiceError(result.error.code, result.error.message)
  return result.value
}

async function invoke<T>(operation: () => Promise<OperationResult<T>>): Promise<T> {
  try {
    return unwrap(await operation())
  } catch (error) {
    if (error instanceof ConnectionServiceError) throw error
    throw new ConnectionServiceError('internal', '本地连接存储操作未能完成，请稍后重试。')
  }
}

function parseCatalog(value: unknown): ConnectionCatalog {
  const parsed = connectionCatalogSchema.safeParse(value)
  if (!parsed.success) {
    throw new ConnectionServiceError('invalid-response', '本地连接数据格式无效，请重启应用。')
  }
  return parsed.data
}

function parseProfile(value: unknown): ConnectionProfile {
  const parsed = connectionProfileSchema.safeParse(value)
  if (!parsed.success) {
    throw new ConnectionServiceError('invalid-response', '本地连接数据格式无效，请重启应用。')
  }
  return parsed.data
}

export const ipcConnectionService: ConnectionService = {
  async load() {
    return parseCatalog(await invoke(() => bridge().connections.list()))
  },

  async create(input: ConnectionInput) {
    return parseProfile(await invoke(() => bridge().connections.create(input)))
  },

  async update(id: string, input: ConnectionInput) {
    return parseProfile(await invoke(() => bridge().connections.update(id, input)))
  },

  async remove(id: string, options?: ConnectionRemovalOptions) {
    const result = await invoke(() => bridge().connections.remove(id, options))
    if (result.id !== id) {
      throw new ConnectionServiceError('invalid-response', '本地连接数据格式无效，请重启应用。')
    }
  },

  async setFavorite(id: string, favorite: boolean) {
    return parseProfile(await invoke(() => bridge().connections.setFavorite(id, favorite)))
  },
}
