import { z } from 'zod'
import {
  COMMAND_HISTORY_STORE_VERSION,
  QUICK_COMMAND_LIMITS,
  QUICK_COMMAND_STORE_VERSION,
} from '../constants/quickCommands'
import {
  hasDisallowedControlCharacters,
  parseQuickCommandTemplate,
} from '../quickCommands/template'
import { connectionIdSchema } from './ipc'
import { sshClientIdSchema, sshSessionIdSchema } from './ssh'

const CUSTOM_COMMAND_ID = /^qc-[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const BUILT_IN_COMMAND_ID = /^builtin-[a-z0-9][a-z0-9-]{0,63}$/
const COMMAND_REFERENCE_ID = /^(?:qc-[A-Za-z0-9][A-Za-z0-9_-]{0,95}|builtin-[a-z0-9][a-z0-9-]{0,63})$/
const HISTORY_ENTRY_ID = /^ch-[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/
const TEMPLATE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/

const isoDateSchema = z.iso.datetime({ offset: true, message: '时间必须是有效的 ISO 8601 时间' })

export const customQuickCommandIdSchema = z
  .string()
  .min(1, '缺少命令 ID')
  .max(100, '命令 ID 过长')
  .regex(CUSTOM_COMMAND_ID, '自定义命令 ID 格式无效')

export const builtInQuickCommandIdSchema = z
  .string()
  .min(1, '缺少内置命令 ID')
  .max(72, '内置命令 ID 过长')
  .regex(BUILT_IN_COMMAND_ID, '内置命令 ID 格式无效')

export const quickCommandReferenceIdSchema = z
  .string()
  .min(1, '缺少命令 ID')
  .max(100, '命令 ID 过长')
  .regex(COMMAND_REFERENCE_ID, '命令 ID 格式无效')

export const commandHistoryIdSchema = z
  .string()
  .min(1, '缺少历史记录 ID')
  .max(100, '历史记录 ID 过长')
  .regex(HISTORY_ENTRY_ID, '历史记录 ID 格式无效')

const requestIdSchema = z
  .string()
  .min(8, '请求 ID 格式无效')
  .max(96, '请求 ID 过长')
  .regex(REQUEST_ID, '请求 ID 格式无效')

const commandNameSchema = z
  .string()
  .trim()
  .min(1, '请输入命令名称')
  .max(QUICK_COMMAND_LIMITS.maxNameLength, `命令名称最多 ${QUICK_COMMAND_LIMITS.maxNameLength} 个字符`)
  .refine((value) => !hasDisallowedControlCharacters(value), '命令名称不能包含控制字符')

const commandCategorySchema = z
  .string()
  .trim()
  .min(1, '请输入命令分类')
  .max(
    QUICK_COMMAND_LIMITS.maxCategoryLength,
    `命令分类最多 ${QUICK_COMMAND_LIMITS.maxCategoryLength} 个字符`,
  )
  .refine((value) => !hasDisallowedControlCharacters(value), '命令分类不能包含控制字符')

const commandDescriptionSchema = z
  .string()
  .trim()
  .max(
    QUICK_COMMAND_LIMITS.maxDescriptionLength,
    `命令说明最多 ${QUICK_COMMAND_LIMITS.maxDescriptionLength} 个字符`,
  )
  .refine((value) => !hasDisallowedControlCharacters(value), '命令说明不能包含控制字符')

const commandTextBaseSchema = z
  .string()
  .min(1, '命令内容不能为空')
  .max(QUICK_COMMAND_LIMITS.maxBodyLength, `命令内容最多 ${QUICK_COMMAND_LIMITS.maxBodyLength} 个字符`)
  .refine((value) => value.trim().length > 0, '命令内容不能为空')
  .refine(
    (value) => !hasDisallowedControlCharacters(value),
    '命令内容必须为单行，且不能包含控制字符',
  )

export const quickCommandBodySchema = commandTextBaseSchema

/** History stores rendered command text, so literal braces are allowed here. */
export const commandHistoryBodySchema = commandTextBaseSchema

export const quickCommandParameterNameSchema = z
  .string()
  .min(1, '参数名称不能为空')
  .max(32, '参数名称最多 32 个字符')
  .regex(TEMPLATE_IDENTIFIER, '参数名称必须以字母或下划线开头，且只包含字母、数字和下划线')

const parameterDefaultValueSchema = z
  .string()
  .trim()
  .max(
    QUICK_COMMAND_LIMITS.maxParameterValueLength,
    `参数默认值最多 ${QUICK_COMMAND_LIMITS.maxParameterValueLength} 个字符`,
  )
  .refine((value) => !hasDisallowedControlCharacters(value), '参数默认值不能包含控制字符')

export const quickCommandParameterSchema = z.strictObject({
  name: quickCommandParameterNameSchema,
  defaultValue: parameterDefaultValueSchema,
})

export const quickCommandParameterValueSchema = z
  .string()
  .trim()
  .min(1, '参数值不能为空')
  .max(
    QUICK_COMMAND_LIMITS.maxParameterValueLength,
    `参数值最多 ${QUICK_COMMAND_LIMITS.maxParameterValueLength} 个字符`,
  )
  .refine((value) => !hasDisallowedControlCharacters(value), '参数值不能包含换行或控制字符')

const quickCommandDraftShape = {
  name: commandNameSchema,
  category: commandCategorySchema,
  description: commandDescriptionSchema,
  body: quickCommandBodySchema,
  parameters: z
    .array(quickCommandParameterSchema)
    .max(QUICK_COMMAND_LIMITS.maxParameters, `一条命令最多包含 ${QUICK_COMMAND_LIMITS.maxParameters} 个参数`),
}

type TemplateParameterDraft = {
  body: string
  parameters: Array<{ name: string }>
}

function validateTemplateParameters(value: TemplateParameterDraft, context: z.RefinementCtx): void {
  const parsed = parseQuickCommandTemplate(value.body)
  if (!parsed.ok) {
    context.addIssue({ code: 'custom', message: parsed.message, path: ['body'] })
    return
  }

  const declared = value.parameters.map((parameter) => parameter.name)
  if (new Set(declared).size !== declared.length) {
    context.addIssue({ code: 'custom', message: '参数名称不能重复', path: ['parameters'] })
    return
  }
  if (
    declared.length !== parsed.parameters.length ||
    declared.some((name, index) => name !== parsed.parameters[index])
  ) {
    context.addIssue({
      code: 'custom',
      message: '参数列表必须与命令中的 {{identifier}} 占位符一致',
      path: ['parameters'],
    })
  }
}

export const quickCommandDraftSchema = z
  .strictObject(quickCommandDraftShape)
  .superRefine(validateTemplateParameters)

export const persistedCustomQuickCommandSchema = z
  .strictObject({
    id: customQuickCommandIdSchema,
    ...quickCommandDraftShape,
    favorite: z.boolean(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .superRefine(validateTemplateParameters)

export const quickCommandExecuteInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    requestId: requestIdSchema,
    commandId: quickCommandReferenceIdSchema,
    parameterValues: z
      .record(quickCommandParameterNameSchema, quickCommandParameterValueSchema)
      .superRefine((values, context) => {
        if (Object.keys(values).length > QUICK_COMMAND_LIMITS.maxParameters) {
          context.addIssue({
            code: 'custom',
            message: `一条命令最多包含 ${QUICK_COMMAND_LIMITS.maxParameters} 个参数`,
          })
        }
      }),
    tabId: sshClientIdSchema,
    sessionId: sshSessionIdSchema,
    recordHistory: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('history'),
    requestId: requestIdSchema,
    body: commandHistoryBodySchema,
    tabId: sshClientIdSchema,
    sessionId: sshSessionIdSchema,
    recordHistory: z.boolean(),
  }),
])

export const quickCommandFavoriteInputSchema = z.strictObject({
  id: quickCommandReferenceIdSchema,
  favorite: z.boolean(),
})

export const quickCommandRemoveInputSchema = z.strictObject({
  id: customQuickCommandIdSchema,
})

export const persistedQuickCommandsSchema = z
  .strictObject({
    version: z.literal(QUICK_COMMAND_STORE_VERSION),
    data: z.strictObject({
      customCommands: z
        .array(persistedCustomQuickCommandSchema)
        .max(
          QUICK_COMMAND_LIMITS.maxCustomCommands,
          `最多保存 ${QUICK_COMMAND_LIMITS.maxCustomCommands} 条自定义命令`,
        ),
      builtInFavoriteIds: z
        .array(builtInQuickCommandIdSchema)
        .max(
          QUICK_COMMAND_LIMITS.maxBuiltInFavorites,
          `最多收藏 ${QUICK_COMMAND_LIMITS.maxBuiltInFavorites} 条内置命令`,
        ),
    }),
  })
  .superRefine((envelope, context) => {
    const commandIds = new Set<string>()
    for (const [index, command] of envelope.data.customCommands.entries()) {
      if (commandIds.has(command.id)) {
        context.addIssue({
          code: 'custom',
          message: '自定义命令 ID 不能重复',
          path: ['data', 'customCommands', index, 'id'],
        })
      }
      commandIds.add(command.id)
    }
    const favoriteIds = new Set<string>()
    for (const [index, id] of envelope.data.builtInFavoriteIds.entries()) {
      if (favoriteIds.has(id)) {
        context.addIssue({
          code: 'custom',
          message: '内置命令收藏 ID 不能重复',
          path: ['data', 'builtInFavoriteIds', index],
        })
      }
      favoriteIds.add(id)
    }
  })

const commandSourceLabelSchema = z
  .string()
  .trim()
  .min(1, '缺少目标连接名称')
  .max(
    QUICK_COMMAND_LIMITS.maxConnectionNameLength,
    `目标连接名称最多 ${QUICK_COMMAND_LIMITS.maxConnectionNameLength} 个字符`,
  )
  .refine((value) => !hasDisallowedControlCharacters(value), '目标连接名称不能包含控制字符')

const targetHostSchema = z
  .string()
  .trim()
  .min(1, '缺少目标主机')
  .max(QUICK_COMMAND_LIMITS.maxHostLength, `目标主机最多 ${QUICK_COMMAND_LIMITS.maxHostLength} 个字符`)
  .refine((value) => !hasDisallowedControlCharacters(value), '目标主机不能包含控制字符')

export const commandHistoryEntrySchema = z.strictObject({
  id: commandHistoryIdSchema,
  body: commandHistoryBodySchema,
  sentAt: isoDateSchema,
  tabId: sshClientIdSchema,
  sessionId: sshSessionIdSchema,
  connectionId: connectionIdSchema,
  connectionName: commandSourceLabelSchema,
  host: targetHostSchema,
})

export const persistedCommandHistorySchema = z
  .strictObject({
    version: z.literal(COMMAND_HISTORY_STORE_VERSION),
    data: z.strictObject({
      entries: z
        .array(commandHistoryEntrySchema)
        .max(
          QUICK_COMMAND_LIMITS.maxHistoryEntries,
          `命令历史最多保存 ${QUICK_COMMAND_LIMITS.maxHistoryEntries} 条`,
        ),
    }),
  })
  .superRefine((envelope, context) => {
    const seen = new Set<string>()
    for (const [index, entry] of envelope.data.entries.entries()) {
      if (seen.has(entry.id)) {
        context.addIssue({
          code: 'custom',
          message: '命令历史记录 ID 不能重复',
          path: ['data', 'entries', index, 'id'],
        })
      }
      seen.add(entry.id)
    }
  })

export const commandHistoryRemoveInputSchema = z.strictObject({
  id: commandHistoryIdSchema,
})
