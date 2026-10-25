import type { ConnectionCatalog, ConnectionService } from './connectionService'
import { ipcConnectionService } from './ipcConnectionService'

/**
 * Single composition point for renderer data access. Connections are persisted
 * by the main process; SFTP goes through the frozen preload `sftp` bridge.
 */
export const connectionService: ConnectionService = ipcConnectionService

export type { ConnectionCatalog }
