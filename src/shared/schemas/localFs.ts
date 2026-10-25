import { z } from 'zod'
import { getLocalPathError, isAbsoluteLocalPath } from '../localFs/localPath'
import { MAX_LOCAL_PATH_LENGTH } from '../localFs/localPath'

export const localPathSchema = z
  .string()
  .min(1, '缺少本地路径')
  .max(MAX_LOCAL_PATH_LENGTH, '本地路径过长')
  .refine((value) => getLocalPathError(value) === null, { message: '本地路径格式无效' })
  .refine((value) => isAbsoluteLocalPath(value), { message: '请使用绝对本地路径' })

export const localFsListInputSchema = z.strictObject({
  path: localPathSchema,
})
