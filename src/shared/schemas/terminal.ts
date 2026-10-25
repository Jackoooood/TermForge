import { z } from 'zod'
import { sshSessionIdSchema } from './ssh'

export const MAX_TERMINAL_WRITE_LENGTH = 65_536
export const MAX_TERMINAL_COLUMNS = 2_000
export const MAX_TERMINAL_ROWS = 1_000

export const terminalSizeSchema = z.strictObject({
  cols: z
    .number({ message: '终端列数必须是数字' })
    .int('终端列数必须是整数')
    .min(1, '终端列数至少为 1')
    .max(MAX_TERMINAL_COLUMNS, '终端列数超出允许范围'),
  rows: z
    .number({ message: '终端行数必须是数字' })
    .int('终端行数必须是整数')
    .min(1, '终端行数至少为 1')
    .max(MAX_TERMINAL_ROWS, '终端行数超出允许范围'),
})

export const terminalSessionIdSchema = sshSessionIdSchema

export const terminalWriteDataSchema = z
  .string({ message: '终端输入必须是字符串' })
  .max(MAX_TERMINAL_WRITE_LENGTH, '单次终端输入超出允许长度')
