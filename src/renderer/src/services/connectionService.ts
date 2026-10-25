import type {
  ConnectionCatalog,
  ConnectionGroup,
  ConnectionInput,
  ConnectionProfile,
  ConnectionRemovalOptions,
} from '@shared/types'

export interface ConnectionService {
  load(): Promise<ConnectionCatalog>
  create(input: ConnectionInput): Promise<ConnectionProfile>
  update(id: string, input: ConnectionInput): Promise<ConnectionProfile>
  remove(id: string, options?: ConnectionRemovalOptions): Promise<void>
  setFavorite(id: string, favorite: boolean): Promise<ConnectionProfile>
}

export type { ConnectionCatalog, ConnectionGroup, ConnectionProfile }
