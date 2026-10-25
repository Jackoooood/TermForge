export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

export interface LogFileInfo {
  name: string
  sizeBytes: number
  modifiedAt: string
}

export interface LogInfo {
  directory: string
  level: LogLevel
  files: LogFileInfo[]
  writeFailures: number
}

export interface LogExportAck {
  exported: boolean
}

export interface LogFolderAck {
  opened: boolean
}
