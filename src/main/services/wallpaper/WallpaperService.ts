import { nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { WallpaperChooseResult, WallpaperState } from '../../../shared/types/wallpaper'
import { AppOperationError } from '../../errors'
import { renameWithRetry } from '../../storage/jsonFile'

const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_EDGE = 2560
const JPEG_QUALITY = 85
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])
const IMAGE_FILE = 'wallpaper.jpg'
const METADATA_FILE = 'wallpaper.json'
const METADATA_VERSION = 1

interface WallpaperMetadata {
  version: number
  fileName: string
  updatedAt: string
}

export interface WallpaperServicePort {
  get(): Promise<WallpaperState>
  choose(): Promise<WallpaperChooseResult>
  remove(): Promise<WallpaperState>
}

type PickWallpaperFile = () => Promise<string | null>

function emptyState(): WallpaperState {
  return { dataUrl: null, fileName: null, updatedAt: null }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function parseMetadata(raw: string): WallpaperMetadata | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const fileName = record.fileName
  const updatedAt = record.updatedAt
  if (typeof fileName !== 'string' || fileName.trim().length === 0 || fileName.length > 255) {
    return null
  }
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) return null
  return { version: METADATA_VERSION, fileName, updatedAt }
}

/**
 * Owns the imported wallpaper image. The renderer only ever receives a JPEG
 * data URL plus display metadata; the source path, file bytes and handles stay
 * in the main process. Images are re-encoded so the stored file has a bounded
 * edge and cannot smuggle arbitrary content into the renderer.
 */
export class WallpaperService implements WallpaperServicePort {
  private readonly imagePath: string
  private readonly metadataPath: string

  constructor(
    private readonly directory: string,
    private readonly pickFile: PickWallpaperFile,
  ) {
    this.imagePath = join(directory, IMAGE_FILE)
    this.metadataPath = join(directory, METADATA_FILE)
  }

  get(): Promise<WallpaperState> {
    return this.readState()
  }

  async choose(): Promise<WallpaperChooseResult> {
    const sourcePath = await this.pickFile()
    if (!sourcePath) {
      return { state: await this.readState(), canceled: true }
    }

    const extension = extname(sourcePath).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new AppOperationError('unsupported', '仅支持 PNG 或 JPEG 格式的图片。')
    }

    let sourceBytes: number
    try {
      const info = await stat(sourcePath)
      if (!info.isFile()) {
        throw new AppOperationError('unsupported', '所选项目不是普通文件。')
      }
      sourceBytes = info.size
    } catch (error) {
      if (error instanceof AppOperationError) throw error
      throw new AppOperationError(
        'storage-read-failed',
        '无法读取所选图片。请确认文件仍存在且可访问。',
      )
    }
    if (sourceBytes === 0 || sourceBytes > MAX_SOURCE_BYTES) {
      throw new AppOperationError('invalid-input', '图片大小必须在 20 MB 以内。')
    }

    const image = nativeImage.createFromPath(sourcePath)
    if (image.isEmpty()) {
      throw new AppOperationError(
        'unsupported',
        '无法解析所选图片，请选择有效的 PNG 或 JPEG 文件。',
      )
    }

    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) {
      throw new AppOperationError(
        'unsupported',
        '无法解析所选图片，请选择有效的 PNG 或 JPEG 文件。',
      )
    }

    const longestEdge = Math.max(width, height)
    const output =
      longestEdge > MAX_IMAGE_EDGE
        ? image.resize({
            width: Math.max(1, Math.round((width * MAX_IMAGE_EDGE) / longestEdge)),
            height: Math.max(1, Math.round((height * MAX_IMAGE_EDGE) / longestEdge)),
            quality: 'good',
          })
        : image

    const jpeg = output.toJPEG(JPEG_QUALITY)
    if (jpeg.byteLength === 0) {
      throw new AppOperationError(
        'storage-write-failed',
        '无法处理所选图片。请换一张图片后重试。',
      )
    }

    await this.writeFiles(jpeg, {
      version: METADATA_VERSION,
      fileName: basename(sourcePath).slice(0, 255),
      updatedAt: new Date().toISOString(),
    })
    return { state: await this.readState(), canceled: false }
  }

  async remove(): Promise<WallpaperState> {
    try {
      await Promise.all([
        rm(this.imagePath, { force: true }),
        rm(this.metadataPath, { force: true }),
      ])
    } catch {
      throw new AppOperationError(
        'storage-write-failed',
        '无法移除壁纸。请检查本机用户数据目录的写入权限。',
      )
    }
    return emptyState()
  }

  private async readState(): Promise<WallpaperState> {
    let image: Buffer
    try {
      image = await readFile(this.imagePath)
    } catch (error) {
      if (isNotFound(error)) return emptyState()
      throw new AppOperationError(
        'storage-read-failed',
        '无法读取已保存的壁纸。请检查本机用户数据目录的访问权限。',
      )
    }
    if (image.byteLength === 0) return emptyState()

    let metadata: WallpaperMetadata | null = null
    try {
      metadata = parseMetadata(await readFile(this.metadataPath, 'utf8'))
    } catch {
      metadata = null
    }

    return {
      dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`,
      fileName: metadata?.fileName ?? null,
      updatedAt: metadata?.updatedAt ?? null,
    }
  }

  private async writeFiles(jpeg: Buffer, metadata: WallpaperMetadata): Promise<void> {
    const temporaryImage = join(
      this.directory,
      `.${IMAGE_FILE}.${process.pid}.${randomUUID()}.tmp`,
    )
    const temporaryMetadata = join(
      this.directory,
      `.${METADATA_FILE}.${process.pid}.${randomUUID()}.tmp`,
    )

    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await writeFile(temporaryImage, jpeg, { mode: 0o600 })
      await writeFile(temporaryMetadata, `${JSON.stringify(metadata, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await renameWithRetry(temporaryImage, this.imagePath)
      await renameWithRetry(temporaryMetadata, this.metadataPath)
    } catch {
      await Promise.all([
        rm(temporaryImage, { force: true }),
        rm(temporaryMetadata, { force: true }),
      ]).catch(() => undefined)
      throw new AppOperationError(
        'storage-write-failed',
        '无法保存壁纸。请检查磁盘空间和本机用户数据目录的写入权限。',
      )
    }
  }
}
