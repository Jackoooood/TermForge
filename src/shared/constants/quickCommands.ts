export const QUICK_COMMAND_STORE_VERSION = 1 as const
export const COMMAND_HISTORY_STORE_VERSION = 1 as const

export const CUSTOM_QUICK_COMMAND_ID_PREFIX = 'qc-'
export const BUILT_IN_COMMAND_ID_PREFIX = 'builtin-'
export const COMMAND_HISTORY_ID_PREFIX = 'ch-'

export const QUICK_COMMAND_LIMITS = {
  maxCustomCommands: 500,
  maxHistoryEntries: 200,
  maxBuiltInFavorites: 64,
  maxNameLength: 64,
  maxCategoryLength: 32,
  maxDescriptionLength: 256,
  maxBodyLength: 4_096,
  maxParameters: 16,
  maxParameterValueLength: 512,
  maxConnectionNameLength: 128,
  maxHostLength: 253,
} as const
