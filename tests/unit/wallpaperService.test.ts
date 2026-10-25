// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeImage } from 'electron'

const electronMock = vi.hoisted(() => ({
  createFromPath: vi.fn(),
}))

vi.mock('electron', () => ({
  nativeImage: { createFromPath: electronMock.createFromPath },
}))

import { WallpaperService } from '../../src/main/services/wallpaper/WallpaperService'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const MAX_SOURCE_BYTES = 20 * 1024 * 1024

function fakeImage(options: {
  width: number
  height: number
  jpeg?: Buffer
  empty?: boolean
}): NativeImage {
  const image = {
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width: options.width, height: options.height }),
    resize: vi.fn(() => image),
    toJPEG: vi.fn(() => options.jpeg ?? JPEG),
  }
  return image as unknown as NativeImage
}

describe('wallpaper service', () => {
  let directory: string
  let sourceDirectory: string
  let pickFile: Mock<() => Promise<string | null>>
  let service: WallpaperService

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-wallpaper-'))
    sourceDirectory = await mkdtemp(join(tmpdir(), 'termforge-wallpaper-source-'))
    pickFile = vi.fn<() => Promise<string | null>>()
    service = new WallpaperService(directory, pickFile)
    electronMock.createFromPath.mockReset()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
    await rm(sourceDirectory, { recursive: true, force: true })
  })

  async function sourceFile(name: string, bytes: string | Buffer = 'image-bytes'): Promise<string> {
    const path = join(sourceDirectory, name)
    await writeFile(path, bytes)
    return path
  }

  it('returns an empty state before any wallpaper is imported', async () => {
    await expect(service.get()).resolves.toEqual({
      dataUrl: null,
      fileName: null,
      updatedAt: null,
    })
  })

  it('returns the current state unchanged when the picker is canceled', async () => {
    pickFile.mockResolvedValue(null)
    await expect(service.choose()).resolves.toEqual({
      state: { dataUrl: null, fileName: null, updatedAt: null },
      canceled: true,
    })
    expect(electronMock.createFromPath).not.toHaveBeenCalled()
  })

  it('rejects unsupported extensions, missing files and non-files without decoding', async () => {
    const gif = await sourceFile('animation.gif')
    pickFile.mockResolvedValue(gif)
    await expect(service.choose()).rejects.toMatchObject({ code: 'unsupported' })

    pickFile.mockResolvedValue(join(sourceDirectory, 'missing.png'))
    await expect(service.choose()).rejects.toMatchObject({ code: 'storage-read-failed' })

    const folder = join(sourceDirectory, 'folder.png')
    await mkdir(folder)
    pickFile.mockResolvedValue(folder)
    await expect(service.choose()).rejects.toMatchObject({ code: 'unsupported' })

    expect(electronMock.createFromPath).not.toHaveBeenCalled()
  })

  it('rejects empty and oversized source files before decoding', async () => {
    const empty = await sourceFile('empty.png', Buffer.alloc(0))
    pickFile.mockResolvedValue(empty)
    await expect(service.choose()).rejects.toMatchObject({ code: 'invalid-input' })

    const huge = join(sourceDirectory, 'huge.png')
    await writeFile(huge, 'seed')
    await truncate(huge, MAX_SOURCE_BYTES + 1)
    pickFile.mockResolvedValue(huge)
    await expect(service.choose()).rejects.toMatchObject({ code: 'invalid-input' })

    expect(electronMock.createFromPath).not.toHaveBeenCalled()
  })

  it('rejects images that cannot be decoded', async () => {
    const source = await sourceFile('broken.png')
    pickFile.mockResolvedValue(source)

    electronMock.createFromPath.mockReturnValue(fakeImage({ width: 0, height: 0, empty: true }))
    await expect(service.choose()).rejects.toMatchObject({ code: 'unsupported' })

    electronMock.createFromPath.mockReturnValue(fakeImage({ width: 0, height: 0 }))
    await expect(service.choose()).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('downscales large images, stores a bounded JPEG and serves only a data URL', async () => {
    const source = await sourceFile('My Desk.png')
    pickFile.mockResolvedValue(source)
    const image = fakeImage({ width: 3000, height: 1000 })
    electronMock.createFromPath.mockReturnValue(image)

    const result = await service.choose()
    expect(result.canceled).toBe(false)
    expect(image.resize).toHaveBeenCalledWith({ width: 2560, height: 853, quality: 'good' })
    expect(image.toJPEG).toHaveBeenCalledWith(85)

    expect(result.state.dataUrl).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`)
    expect(result.state.fileName).toBe('My Desk.png')
    expect(result.state.updatedAt).not.toBeNull()

    expect(await readFile(join(directory, 'wallpaper.jpg'))).toEqual(JPEG)
    const metadata = JSON.parse(await readFile(join(directory, 'wallpaper.json'), 'utf8')) as {
      version: number
      fileName: string
      updatedAt: string
    }
    expect(metadata).toMatchObject({ version: 1, fileName: 'My Desk.png' })
    expect(JSON.stringify(result)).not.toContain(sourceDirectory)

    const reloaded = await new WallpaperService(directory, pickFile).get()
    expect(reloaded).toEqual(result.state)
  })

  it('keeps images within the edge limit without upscaling smaller ones', async () => {
    const source = await sourceFile('small.jpeg')
    pickFile.mockResolvedValue(source)
    const image = fakeImage({ width: 1280, height: 720 })
    electronMock.createFromPath.mockReturnValue(image)

    await expect(service.choose()).resolves.toMatchObject({ canceled: false })
    expect(image.resize).not.toHaveBeenCalled()
  })

  it('reports an encoding failure and leaves no partial files', async () => {
    const source = await sourceFile('empty-output.png')
    pickFile.mockResolvedValue(source)
    electronMock.createFromPath.mockReturnValue(
      fakeImage({ width: 800, height: 600, jpeg: Buffer.alloc(0) }),
    )

    await expect(service.choose()).rejects.toMatchObject({ code: 'storage-write-failed' })
    await expect(readFile(join(directory, 'wallpaper.jpg'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('reports write failures without leaving temporary files', async () => {
    const blockingPath = join(sourceDirectory, 'not-a-directory')
    await writeFile(blockingPath, 'file')
    const blocked = new WallpaperService(blockingPath, pickFile)
    const source = await sourceFile('desk.png')
    pickFile.mockResolvedValue(source)
    electronMock.createFromPath.mockReturnValue(fakeImage({ width: 640, height: 480 }))

    await expect(blocked.choose()).rejects.toMatchObject({ code: 'storage-write-failed' })
    const leftovers = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])

    const writeBlocked = new WallpaperService(join(sourceDirectory, 'write-blocked'), pickFile)
    await mkdir(join(sourceDirectory, 'write-blocked', 'wallpaper.jpg'), { recursive: true })
    await expect(writeBlocked.choose()).rejects.toMatchObject({ code: 'storage-write-failed' })
    expect(
      (await readdir(join(sourceDirectory, 'write-blocked'))).filter((name) => name.endsWith('.tmp')),
    ).toEqual([])
  })

  it('ignores damaged metadata while still serving the stored image', async () => {
    await writeFile(join(directory, 'wallpaper.jpg'), JPEG)
    await writeFile(join(directory, 'wallpaper.json'), '{not-json', 'utf8')

    await expect(service.get()).resolves.toEqual({
      dataUrl: `data:image/jpeg;base64,${JPEG.toString('base64')}`,
      fileName: null,
      updatedAt: null,
    })
  })

  it('removes both stored files and returns to the empty state', async () => {
    const source = await sourceFile('desk.png')
    pickFile.mockResolvedValue(source)
    electronMock.createFromPath.mockReturnValue(fakeImage({ width: 800, height: 600 }))
    await service.choose()

    await expect(service.remove()).resolves.toEqual({
      dataUrl: null,
      fileName: null,
      updatedAt: null,
    })
    await expect(service.get()).resolves.toEqual({
      dataUrl: null,
      fileName: null,
      updatedAt: null,
    })
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
