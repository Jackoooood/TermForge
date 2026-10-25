export const QUICK_COMMAND_SOURCES = ['built-in', 'custom'] as const

export type QuickCommandSource = (typeof QUICK_COMMAND_SOURCES)[number]

export interface QuickCommandParameter {
  name: string
  defaultValue: string
}

export interface QuickCommandDraft {
  name: string
  category: string
  description: string
  body: string
  parameters: QuickCommandParameter[]
}

export interface QuickCommand extends QuickCommandDraft {
  id: string
  source: QuickCommandSource
  favorite: boolean
  editable: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface PersistedCustomQuickCommand extends QuickCommandDraft {
  id: string
  favorite: boolean
  createdAt: string
  updatedAt: string
}

export interface QuickCommandStoreState {
  customCommands: PersistedCustomQuickCommand[]
  builtInFavoriteIds: string[]
}

export interface QuickCommandSnapshot {
  commands: QuickCommand[]
}

interface QuickCommandExecuteBase {
  requestId: string
  tabId: string
  sessionId: string
  recordHistory: boolean
}

export interface QuickCommandExecuteLibraryInput extends QuickCommandExecuteBase {
  kind: 'command'
  commandId: string
  parameterValues: Record<string, string>
}

/**
 * Re-sending a history entry is explicit: the body is shown verbatim in the
 * confirmation dialog before this input is produced.
 */
export interface QuickCommandExecuteHistoryInput extends QuickCommandExecuteBase {
  kind: 'history'
  body: string
}

export type QuickCommandExecuteInput =
  | QuickCommandExecuteLibraryInput
  | QuickCommandExecuteHistoryInput

export interface QuickCommandExecuteAck {
  requestId: string
  body: string
  writtenAt: string
  historyRecorded: boolean
  historyWarning: string | null
}

export interface CommandHistoryEntry {
  id: string
  body: string
  sentAt: string
  tabId: string
  sessionId: string
  connectionId: string
  connectionName: string
  host: string
}

export interface CommandHistoryAppendInput {
  body: string
  tabId: string
  sessionId: string
  connectionId: string
  connectionName: string
  host: string
}

export interface CommandHistoryStoreState {
  entries: CommandHistoryEntry[]
}

export interface CommandHistorySnapshot {
  entries: CommandHistoryEntry[]
}

export interface CommandHistoryClearAck {
  cleared: number
}
