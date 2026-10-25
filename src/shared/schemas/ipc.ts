import { z } from 'zod'

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export const connectionIdSchema = z
  .string()
  .min(1, '缺少连接 ID')
  .max(128, '连接 ID 过长')
  .regex(CONNECTION_ID, '连接 ID 格式无效')

export const setFavoriteInputSchema = z.strictObject({
  id: connectionIdSchema,
  favorite: z.boolean(),
})
