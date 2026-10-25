import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AppOperationError } from '../errors'

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export async function readJsonFile(filePath: string, label: string): Promise<unknown | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw new AppOperationError(
      'storage-read-failed',
      `无法读取${label}。请检查本机用户数据目录的访问权限。`,
    )
  }

  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new AppOperationError(
      'storage-corrupt',
      `${label}文件损坏，已停止加载以避免覆盖现有数据。`,
    )
  }
}

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100]

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Windows can transiently reject `rename` with EPERM/EACCES/EBUSY while a
 * scanner or indexer holds the freshly written file. Retry those codes only.
 */
export async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = errorCode(error)
      const delay = RENAME_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  label: string,
): Promise<void> {
  const directory = dirname(filePath)
  const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await renameWithRetry(temporaryPath, filePath)
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw new AppOperationError(
      'storage-write-failed',
      `无法保存${label}。请检查磁盘空间和本机用户数据目录的写入权限。`,
    )
  }
}
