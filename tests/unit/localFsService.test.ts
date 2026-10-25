// @vitest-environment node

import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFsService } from '../../src/main/services/localFs/LocalFsService'
import { normalizeLocalPath } from '../../src/shared/localFs/localPath'

const bases: string[] = []

async function createBase(): Promise<string> {
  const base = await fsp.mkdtemp(join(tmpdir(), 'termforge-localfs-'))
  bases.push(base)
  return base
}

afterEach(async () => {
  for (const base of bases.splice(0)) {
    await fsp.rm(base, { recursive: true, force: true })
  }
})

describe('LocalFsService', () => {
  it('lists metadata with kinds, sizes and hidden flags against a real directory', async () => {
    const base = await createBase()
    await fsp.writeFile(join(base, 'alpha.txt'), 'hello')
    await fsp.mkdir(join(base, 'folder'))
    await fsp.writeFile(join(base, '.env'), 'secret')
    await fsp.symlink(
      join(base, 'folder'),
      join(base, 'link-dir'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const service = new LocalFsService({
      getHomeDirectory: () => base,
      now: () => new Date('2026-10-23T00:00:00.000Z'),
    })
    const listing = await service.list(base)

    expect(listing).toMatchObject({
      path: normalizeLocalPath(base),
      parentPath: dirname(normalizeLocalPath(base)),
      truncated: false,
      loadedAt: '2026-10-23T00:00:00.000Z',
    })

    const byName = new Map(listing.entries.map((entry) => [entry.name, entry]))
    expect(byName.get('.env')).toMatchObject({ kind: 'file', hidden: true, sizeBytes: 6 })
    expect(byName.get('alpha.txt')).toMatchObject({ kind: 'file', hidden: false, sizeBytes: 5 })
    expect(byName.get('folder')).toMatchObject({ kind: 'directory', sizeBytes: null })
    expect(byName.get('link-dir')).toMatchObject({ kind: 'symlink', sizeBytes: null })
    expect(listing.entries).toHaveLength(4)

    for (const entry of listing.entries) {
      expect(entry.path).toBe(join(normalizeLocalPath(base), entry.name))
      expect(entry.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }

    // Directories and links come before plain files regardless of name.
    const kinds = listing.entries.map((entry) => entry.kind)
    expect(kinds.slice(0, 2)).toEqual(['directory', 'symlink'])
    expect(kinds.slice(2).every((kind) => kind === 'file')).toBe(true)
  })

  it('marks a listing as truncated once the entry cap is exceeded', async () => {
    const base = await createBase()
    for (const index of [1, 2, 3, 4, 5]) {
      await fsp.writeFile(join(base, `file-${index}.txt`), 'x')
    }

    const service = new LocalFsService({ getHomeDirectory: () => base, maxEntries: 3 })
    const listing = await service.list(base)

    expect(listing.truncated).toBe(true)
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      'file-1.txt',
      'file-2.txt',
      'file-3.txt',
    ])
  })

  it('reports roots with the injected home directory', async () => {
    const base = await createBase()
    const service = new LocalFsService({ getHomeDirectory: () => base })
    const result = await service.roots()

    expect(result.home).toBe(normalizeLocalPath(base))
    expect(result.roots[0]).toEqual({
      name: '主目录',
      path: normalizeLocalPath(base),
      kind: 'home',
    })
    if (process.platform !== 'win32') {
      expect(result.roots).toContainEqual({ name: '/', path: '/', kind: 'root' })
    }
  })

  it('translates filesystem and input failures into operation error codes', async () => {
    const base = await createBase()
    await fsp.writeFile(join(base, 'plain.txt'), 'x')
    const service = new LocalFsService({ getHomeDirectory: () => base })

    await expect(service.list(join(base, 'missing'))).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(service.list(join(base, 'plain.txt'))).rejects.toMatchObject({
      code: 'not-a-directory',
    })
    await expect(service.list('relative\\dir')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(service.list('\\\\?\\C:\\x')).rejects.toMatchObject({ code: 'invalid-input' })
  })
})