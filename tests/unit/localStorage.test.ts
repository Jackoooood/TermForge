// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionInput } from '@shared/types'
import { readJsonFile, writeJsonFileAtomic } from '../../src/main/storage/jsonFile'
import { ConnectionRepository } from '../../src/main/storage/connectionRepository'

const INPUT: ConnectionInput = {
  name: 'ops-node',
  host: '10.20.4.99',
  port: 22,
  username: 'deploy',
  authMethod: 'sshAgent',
  groupId: 'production',
  tagIds: [],
  jumpConnectionIds: [],
}

describe('local connection storage', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-store-'))
    filePath = join(directory, 'connections.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('seeds once, then persists create, update, favorite and delete across instances', async () => {
    const first = new ConnectionRepository(filePath)
    const seeded = await first.list()
    expect(seeded.connections).toHaveLength(7)
    expect(seeded.groups).toHaveLength(3)
    expect(seeded.tags).toHaveLength(12)

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { version: number }
    expect(persisted.version).toBe(3)

    const created = await first.create(INPUT)
    const updated = await first.update(created.id, { ...INPUT, name: 'ops-node-2' })
    expect(updated.name).toBe('ops-node-2')
    expect(updated.id).toBe(created.id)

    const favorited = await first.setFavorite(created.id, true)
    expect(favorited.favorite).toBe(true)

    const reloaded = new ConnectionRepository(filePath)
    const afterRestart = await reloaded.list()
    expect(afterRestart.connections).toHaveLength(8)
    expect(afterRestart.connections.find((item) => item.id === created.id)).toMatchObject({
      name: 'ops-node-2',
      favorite: true,
    })

    await reloaded.remove('conn-prod-db-01')
    const afterDelete = await new ConnectionRepository(filePath).list()
    expect(afterDelete.connections).toHaveLength(7)
    expect(afterDelete.connections.some((item) => item.id === 'conn-prod-db-01')).toBe(false)
  })

  it('keeps the built-in seed from reappearing after every connection is deleted', async () => {
    const repository = new ConnectionRepository(filePath)
    const seed = await repository.list()
    for (const connection of seed.connections) await repository.remove(connection.id)

    const empty = await new ConnectionRepository(filePath).list()
    expect(empty.connections).toHaveLength(0)
    expect(empty.groups).toHaveLength(3)
  })

  it('validates inputs and repository operations without writing', async () => {
    const repository = new ConnectionRepository(filePath)
    await repository.list()
    const before = await readFile(filePath, 'utf8')

    await expect(repository.create({ ...INPUT, groupId: 'missing' })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(repository.create({ ...INPUT, tagIds: ['tag-missing'] })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(
      repository.create({ ...INPUT, password: 'plaintext' } as ConnectionInput),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(repository.update('missing-id', INPUT)).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(repository.remove('../escape')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(repository.setFavorite('missing-id', true)).rejects.toMatchObject({
      code: 'not-found',
    })

    expect(await readFile(filePath, 'utf8')).toBe(before)
  })

  it('serializes concurrent mutations without losing updates', async () => {
    const repository = new ConnectionRepository(filePath)
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        repository.create({ ...INPUT, name: `node-${index}` }),
      ),
    )

    const catalog = await new ConnectionRepository(filePath).list()
    expect(catalog.connections).toHaveLength(12)
    expect(new Set(catalog.connections.map((item) => item.id)).size).toBe(12)
  })

  it('stops loading corrupted or unsupported files instead of overwriting them', async () => {
    await writeFile(filePath, '{ not json', 'utf8')
    const corrupt = new ConnectionRepository(filePath)
    await expect(corrupt.list()).rejects.toMatchObject({ code: 'storage-corrupt' })
    expect(await readFile(filePath, 'utf8')).toBe('{ not json')

    await writeFile(filePath, JSON.stringify({ version: 99, data: { connections: [], groups: [] } }))
    await expect(new ConnectionRepository(filePath).list()).rejects.toMatchObject({
      code: 'storage-corrupt',
    })
  })

  it('validates jump references on create and update', async () => {
    const repository = new ConnectionRepository(filePath)
    await repository.list()

    await expect(
      repository.create({ ...INPUT, jumpConnectionIds: ['conn-missing'] }),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      message: '所选跳板连接不存在，请重新选择。',
    })

    const created = await repository.create({
      ...INPUT,
      jumpConnectionIds: ['conn-stage-bastion'],
    })
    expect(created.jumpConnectionIds).toEqual(['conn-stage-bastion'])

    await expect(
      repository.update(created.id, { ...INPUT, jumpConnectionIds: [created.id] }),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      message: '连接不能把自身设为跳板。',
    })

    // The seed already routes conn-stage-api-01 through conn-stage-bastion, so
    // the reverse edge would close a two-node loop.
    await expect(
      repository.update('conn-stage-bastion', {
        ...INPUT,
        jumpConnectionIds: ['conn-stage-api-01'],
      }),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      message: '跳板配置会形成循环引用，请调整跳板顺序。',
    })
  })

  it('strips jump references to a removed connection in the same write', async () => {
    const repository = new ConnectionRepository(filePath)
    const seed = await repository.list()
    const api = seed.connections.find((item) => item.id === 'conn-stage-api-01')
    expect(api?.jumpConnectionIds).toEqual(['conn-stage-bastion'])

    await repository.remove('conn-stage-bastion')

    const after = await new ConnectionRepository(filePath).list()
    const updatedApi = after.connections.find((item) => item.id === 'conn-stage-api-01')
    expect(after.connections.some((item) => item.id === 'conn-stage-bastion')).toBe(false)
    expect(updatedApi?.jumpConnectionIds).toEqual([])
    expect(updatedApi?.updatedAt).not.toBe(api?.updatedAt)

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { version: number }
    expect(raw.version).toBe(3)
  })

  it('upgrades legacy v1 and v2 files in place and refuses files that fail re-validation', async () => {
    const legacyProfile = {
      id: 'conn-legacy',
      name: 'legacy',
      host: '10.20.4.99',
      port: 22,
      username: 'deploy',
      authMethod: 'sshAgent',
      groupId: 'production',
      tags: ['Ops', 'web'],
      favorite: false,
      createdAt: '2026-10-22T08:00:00.000Z',
      updatedAt: '2026-10-22T08:00:00.000Z',
    }
    const groups = [{ id: 'production', name: '生产环境', tone: 'production', sortOrder: 1 }]

    await writeFile(
      filePath,
      JSON.stringify({ version: 1, data: { connections: [legacyProfile], groups } }),
      'utf8',
    )

    const catalog = await new ConnectionRepository(filePath).list()
    expect(catalog.connections[0]).toMatchObject({
      tagIds: ['tag-ops', 'tag-web'],
      jumpConnectionIds: [],
    })
    expect(catalog.tags).toEqual([
      { id: 'tag-ops', name: 'Ops', color: 'neutral' },
      { id: 'tag-web', name: 'web', color: 'neutral' },
    ])

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      data: {
        tags: Array<{ id: string }>
        connections: Array<{ tagIds: string[]; jumpConnectionIds: string[] }>
      }
    }
    expect(raw.version).toBe(3)
    expect(raw.data.connections[0]?.jumpConnectionIds).toEqual([])
    expect(raw.data.connections[0]?.tagIds).toEqual(['tag-ops', 'tag-web'])
    expect(raw.data.tags.map((tag) => tag.id)).toEqual(['tag-ops', 'tag-web'])

    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        data: {
          connections: [{ ...legacyProfile, jumpConnectionIds: [], tags: ['database'] }],
          groups,
        },
      }),
      'utf8',
    )
    const migratedFromV2 = await new ConnectionRepository(filePath).list()
    expect(migratedFromV2.connections[0]?.tagIds).toEqual(['tag-database'])
    expect(
      (JSON.parse(await readFile(filePath, 'utf8')) as { version: number }).version,
    ).toBe(3)

    const broken = JSON.stringify({
      version: 1,
      data: { connections: [{ ...legacyProfile, groupId: 'missing' }], groups: [] },
    })
    await writeFile(filePath, broken, 'utf8')
    await expect(new ConnectionRepository(filePath).list()).rejects.toMatchObject({
      code: 'storage-corrupt',
    })
    expect(await readFile(filePath, 'utf8')).toBe(broken)
  })

  it('reports safe read and write failures', async () => {
    expect(await readJsonFile(join(directory, 'missing.json'), '本地连接配置')).toBeNull()

    await writeFile(filePath, '{broken', 'utf8')
    await expect(readJsonFile(filePath, '本地连接配置')).rejects.toMatchObject({
      code: 'storage-corrupt',
    })

    await mkdir(join(directory, 'target.json'))
    await expect(
      writeJsonFileAtomic(join(directory, 'target.json'), { version: 1 }, '本地连接配置'),
    ).rejects.toMatchObject({
      code: 'storage-write-failed',
    })

    const leftovers = (await readdir(directory)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})
