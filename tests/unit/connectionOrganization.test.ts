// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TAGS } from '@shared/constants/app'
import type { ConnectionInput, ConnectionProfile } from '@shared/types'
import { ConnectionRepository } from '../../src/main/storage/connectionRepository'

function toInput(connection: ConnectionProfile): ConnectionInput {
  return {
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMethod: connection.authMethod,
    groupId: connection.groupId,
    tagIds: [...connection.tagIds],
    credentialRef: connection.credentialRef,
    jumpConnectionIds: [...connection.jumpConnectionIds],
  }
}

describe('connection organization repository', () => {
  let directory: string
  let filePath: string
  let repository: ConnectionRepository

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-organization-'))
    filePath = join(directory, 'connections.json')
    repository = new ConnectionRepository(filePath)
    await repository.list()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('creates and renames groups with unique names and sortable order', async () => {
    const created = await repository.createGroup({ name: '  预发布  ' })
    const group = created.groups.find((item) => item.name === '预发布')
    expect(group).toMatchObject({ tone: 'neutral', sortOrder: 4 })
    expect(group?.id).toMatch(/^group-/)

    await expect(repository.createGroup({ name: '预发布' })).rejects.toMatchObject({
      code: 'invalid-input',
      message: '分组名称已存在，请使用其他名称。',
    })
    await expect(repository.createGroup({ name: '   ' })).rejects.toMatchObject({
      code: 'invalid-input',
    })

    const renamed = await repository.updateGroup(group?.id as string, { name: 'Staging' })
    expect(renamed.groups.find((item) => item.id === group?.id)?.name).toBe('Staging')

    await expect(
      repository.updateGroup(group?.id as string, { name: '生产环境' }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(repository.updateGroup('group-missing', { name: 'x' })).rejects.toMatchObject({
      code: 'not-found',
    })

    const reloaded = await new ConnectionRepository(filePath).list()
    expect(reloaded.groups.find((item) => item.id === group?.id)?.name).toBe('Staging')
  })

  it('deletes a group and moves its members to ungrouped in one write', async () => {
    const before = await repository.list()
    const member = before.connections.find((connection) => connection.groupId === 'production')
    expect(member).toBeDefined()

    const after = await repository.removeGroup('production')
    expect(after.groups.some((group) => group.id === 'production')).toBe(false)
    const moved = after.connections.find((connection) => connection.id === member?.id)
    expect(moved?.groupId).toBeNull()
    expect(moved?.updatedAt).not.toBe(member?.updatedAt)
    const formerMembers = before.connections.filter(
      (connection) => connection.groupId === 'production',
    )
    expect(formerMembers.length).toBeGreaterThan(1)
    for (const formerMember of formerMembers) {
      expect(
        after.connections.find((connection) => connection.id === formerMember.id)?.groupId,
      ).toBeNull()
    }

    await expect(repository.removeGroup('production')).rejects.toMatchObject({ code: 'not-found' })

    const reloaded = await new ConnectionRepository(filePath).list()
    expect(reloaded.groups.some((group) => group.id === 'production')).toBe(false)
    expect(reloaded.connections.find((connection) => connection.id === member?.id)?.groupId).toBeNull()
  })

  it('reorders groups only when the full set is supplied', async () => {
    const groups = (await repository.list()).groups
    const reversed = [...groups].reverse().map((group) => group.id)

    const reordered = await repository.reorderGroups(reversed)
    expect(reordered.groups.map((group) => group.id)).toEqual(reversed)
    expect(reordered.groups.map((group) => group.sortOrder)).toEqual([1, 2, 3])

    await expect(repository.reorderGroups(reversed.slice(1))).rejects.toMatchObject({
      code: 'invalid-input',
      message: '分组排序必须包含全部现有分组。',
    })
    await expect(
      repository.reorderGroups([...reversed.slice(0, -1), 'group-missing']),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      repository.reorderGroups([reversed[0], reversed[0], reversed[2]]),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      message: '分组排序不能包含重复分组。',
    })

    const reloaded = await new ConnectionRepository(filePath).list()
    expect(reloaded.groups.map((group) => group.id)).toEqual(reversed)
  })

  it('creates, edits and deletes tags while keeping connections coherent', async () => {
    const created = await repository.createTag({ name: 'Prod', color: 'purple' })
    const tag = created.tags.find((item) => item.name === 'Prod')
    expect(tag).toMatchObject({ color: 'purple' })
    expect(tag?.id).toMatch(/^tag-/)

    await expect(repository.createTag({ name: ' prod ', color: 'red' })).rejects.toMatchObject({
      code: 'invalid-input',
      message: '标签名称已存在，请使用其他名称。',
    })
    await expect(
      repository.createTag({ name: 'bad', color: 'gold' } as never),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    const renamed = await repository.updateTag(tag?.id as string, {
      name: 'production',
      color: 'red',
    })
    expect(renamed.tags.find((item) => item.id === tag?.id)).toMatchObject({
      name: 'production',
      color: 'red',
    })
    await expect(
      repository.updateTag(tag?.id as string, { name: 'nginx', color: 'red' }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      repository.updateTag('tag-missing', { name: 'x', color: 'red' }),
    ).rejects.toMatchObject({ code: 'not-found' })

    const target = (await repository.list()).connections.find(
      (connection) => connection.id === 'conn-stage-bastion',
    ) as ConnectionProfile
    await repository.update(target.id, {
      ...toInput(target),
      tagIds: [...target.tagIds, tag?.id as string],
    })
    const assigned = (await repository.list()).connections.find(
      (connection) => connection.id === target.id,
    ) as ConnectionProfile
    expect(assigned.tagIds).toContain(tag?.id)

    const after = await repository.removeTag(tag?.id as string)
    expect(after.tags.some((item) => item.id === tag?.id)).toBe(false)
    const stripped = after.connections.find((connection) => connection.id === target.id)
    expect(stripped?.tagIds).toEqual(target.tagIds)
    expect(stripped?.updatedAt).not.toBe(assigned.updatedAt)

    await expect(repository.removeTag(tag?.id as string)).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('applies bulk favorites and group moves with per-item failures', async () => {
    const [first, second] = (await repository.list()).connections.filter(
      (connection) => !connection.favorite,
    )
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    const favorite = await repository.bulkUpdate([first.id, 'conn-missing'], {
      type: 'favorite',
      favorite: true,
    })
    expect(favorite.updated).toHaveLength(1)
    expect(favorite.updated[0]).toMatchObject({ id: first.id, favorite: true })
    expect(favorite.failures).toEqual([
      {
        id: 'conn-missing',
        code: 'not-found',
        message: '找不到该连接，可能已被删除。',
      },
    ])

    const moved = await repository.bulkUpdate([first.id, second.id], {
      type: 'set-group',
      groupId: null,
    })
    expect(moved.updated).toHaveLength(2)
    expect(moved.updated.every((connection) => connection.groupId === null)).toBe(true)

    await expect(
      repository.bulkUpdate([first.id], { type: 'set-group', groupId: 'missing' }),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      message: '所选分组不存在，请重新选择。',
    })
    await expect(
      repository.bulkUpdate([first.id], { type: 'favorite', favorite: true, extra: true } as never),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      repository.bulkUpdate([], { type: 'favorite', favorite: true }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(repository.bulkUpdate(['../bad'], { type: 'favorite', favorite: true })).rejects.toMatchObject(
      { code: 'invalid-input' },
    )

    const reloaded = await new ConnectionRepository(filePath).list()
    expect(reloaded.connections.find((item) => item.id === first.id)).toMatchObject({
      favorite: true,
      groupId: null,
    })
  })

  it('merges bulk tags, skips unchanged connections and enforces the tag limit per connection', async () => {
    const target = (await repository.list()).connections.find(
      (connection) => connection.id === 'conn-prod-web-01',
    ) as ConnectionProfile
    expect(target.tagIds).toHaveLength(2)

    const added = await repository.bulkUpdate([target.id], {
      type: 'add-tags',
      tagIds: ['tag-api', 'tag-nginx'],
    })
    expect(added.updated).toHaveLength(1)
    expect(added.updated[0]?.tagIds).toEqual([...target.tagIds, 'tag-api'])
    expect(added.failures).toEqual([])

    const unchanged = await repository.bulkUpdate([target.id], {
      type: 'add-tags',
      tagIds: ['tag-api'],
    })
    expect(unchanged).toEqual({ updated: [], failures: [] })

    const allTags = (await repository.list()).tags
    const tooMany = allTags
      .filter((tag) => !target.tagIds.includes(tag.id))
      .slice(0, MAX_TAGS)
      .map((tag) => tag.id)
    const overflow = await repository.bulkUpdate([target.id], {
      type: 'add-tags',
      tagIds: tooMany,
    })
    expect(overflow.updated).toEqual([])
    expect(overflow.failures).toEqual([
      {
        id: target.id,
        code: 'invalid-input',
        message: `标签数量不能超过 ${MAX_TAGS} 个。`,
      },
    ])

    const removed = await repository.bulkUpdate([target.id], {
      type: 'remove-tags',
      tagIds: [target.tagIds[0] as string],
    })
    expect(removed.updated[0]?.tagIds).toEqual([target.tagIds[1], 'tag-api'])

    await expect(
      repository.bulkUpdate([target.id], { type: 'remove-tags', tagIds: ['tag-missing'] }),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    const reloaded = await new ConnectionRepository(filePath).list()
    expect(reloaded.connections.find((item) => item.id === target.id)?.tagIds).toEqual([
      target.tagIds[1],
      'tag-api',
    ])
  })
})
