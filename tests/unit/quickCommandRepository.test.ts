// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUICK_COMMAND_STORE_VERSION } from '@shared/constants/quickCommands'
import type { QuickCommandDraft } from '@shared/types'
import { QuickCommandRepository } from '../../src/main/storage/quickCommandRepository'

function draft(overrides: Partial<QuickCommandDraft> = {}): QuickCommandDraft {
  return {
    name: '查看服务状态',
    category: '服务诊断',
    description: '',
    body: 'systemctl status {{service}} --no-pager',
    parameters: [{ name: 'service', defaultValue: 'sshd' }],
    ...overrides,
  }
}

describe('quick command repository', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-quick-commands-'))
    filePath = join(directory, 'quick-commands.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('starts empty without creating a file', async () => {
    const repository = new QuickCommandRepository(filePath)
    await expect(repository.list()).resolves.toEqual({
      customCommands: [],
      builtInFavoriteIds: [],
    })
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates validated custom commands and reloads them across instances', async () => {
    const repository = new QuickCommandRepository(filePath)
    const command = await repository.create(
      draft({ name: '  查看服务状态  ', description: '  只读检查  ' }),
    )

    expect(command.id).toMatch(/^qc-[0-9a-f-]{36}$/)
    expect(command.name).toBe('查看服务状态')
    expect(command.description).toBe('只读检查')
    expect(command.parameters).toEqual([{ name: 'service', defaultValue: 'sshd' }])
    expect(command.favorite).toBe(false)

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      data: { customCommands: unknown[] }
    }
    expect(persisted.version).toBe(QUICK_COMMAND_STORE_VERSION)
    expect(persisted.data.customCommands).toEqual([command])

    await expect(new QuickCommandRepository(filePath).list()).resolves.toEqual({
      customCommands: [command],
      builtInFavoriteIds: [],
    })
  })

  it('rejects drafts whose parameters do not match the body placeholders', async () => {
    const repository = new QuickCommandRepository(filePath)
    await expect(
      repository.create(draft({ parameters: [{ name: 'other', defaultValue: '' }] })),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(repository.create(draft({ body: 'echo {{name' }))).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('updates only custom commands and preserves identity and favorites', async () => {
    const repository = new QuickCommandRepository(filePath)
    const created = await repository.create(draft())
    await repository.setFavorite(created.id, true)

    const updated = await repository.update(
      created.id,
      draft({
        name: '查看服务日志',
        body: 'journalctl -u {{service}} -n 100 --no-pager',
      }),
    )
    expect(updated.id).toBe(created.id)
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.favorite).toBe(true)
    expect(updated.name).toBe('查看服务日志')
    expect(updated.updatedAt >= created.updatedAt).toBe(true)

    await expect(repository.update('builtin-uptime', draft())).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(repository.remove('builtin-uptime')).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('persists built-in favorites and removes custom commands', async () => {
    const repository = new QuickCommandRepository(filePath)
    const created = await repository.create(draft())

    await repository.setFavorite('builtin-uptime', true)
    await repository.setFavorite('builtin-uptime', true)
    await repository.setFavorite('builtin-memory', true)
    await repository.setFavorite('builtin-uptime', false)

    await expect(repository.list()).resolves.toMatchObject({
      builtInFavoriteIds: ['builtin-memory'],
    })
    await expect(repository.remove(created.id)).resolves.toEqual({ id: created.id })
    await expect(repository.remove(created.id)).rejects.toMatchObject({ code: 'not-found' })
    await expect(repository.list()).resolves.toMatchObject({ customCommands: [] })
  })

  it('serializes concurrent creations', async () => {
    const repository = new QuickCommandRepository(filePath)
    await Promise.all([
      repository.create(draft({ name: '命令 A' })),
      repository.create(draft({ name: '命令 B' })),
      repository.create(draft({ name: '命令 C' })),
    ])

    const state = await repository.list()
    expect(state.customCommands.map((command) => command.name)).toEqual([
      '命令 A',
      '命令 B',
      '命令 C',
    ])
  })

  it('never overwrites a corrupt store on load', async () => {
    const original = JSON.stringify({ version: 1, data: { customCommands: 'broken' } })
    await writeFile(filePath, original, 'utf8')

    const repository = new QuickCommandRepository(filePath)
    await expect(repository.list()).rejects.toMatchObject({ code: 'storage-corrupt' })
    await expect(repository.create(draft())).rejects.toMatchObject({ code: 'storage-corrupt' })
    expect(await readFile(filePath, 'utf8')).toBe(original)
  })
})
