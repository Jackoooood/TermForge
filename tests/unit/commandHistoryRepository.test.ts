// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMMAND_HISTORY_STORE_VERSION,
  QUICK_COMMAND_LIMITS,
} from '@shared/constants/quickCommands'
import type { CommandHistoryAppendInput, CommandHistoryEntry } from '@shared/types'
import { CommandHistoryRepository } from '../../src/main/storage/commandHistoryRepository'

function input(overrides: Partial<CommandHistoryAppendInput> = {}): CommandHistoryAppendInput {
  return {
    body: 'df -h',
    tabId: 'sshtab-1',
    sessionId: 'ssh-1',
    connectionId: 'conn-a',
    connectionName: '生产服务器',
    host: '10.0.0.9',
    ...overrides,
  }
}

function storedEntry(index: number): CommandHistoryEntry {
  return {
    id: `ch-${String(index).padStart(3, '0')}`,
    body: `echo ${index}`,
    sentAt: '2026-10-23T08:00:00.000Z',
    tabId: 'sshtab-1',
    sessionId: 'ssh-1',
    connectionId: 'conn-a',
    connectionName: '生产服务器',
    host: '10.0.0.9',
  }
}

describe('command history repository', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-command-history-'))
    filePath = join(directory, 'command-history.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('starts empty without creating a file', async () => {
    const repository = new CommandHistoryRepository(filePath)
    await expect(repository.list()).resolves.toEqual({ entries: [] })
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('appends newest-first entries with target metadata only', async () => {
    const repository = new CommandHistoryRepository(filePath)
    const first = await repository.append(input())
    const second = await repository.append(input({ body: 'uptime' }))

    expect(first.id).toMatch(/^ch-[0-9a-f-]{36}$/)
    expect(first.body).toBe('df -h')
    expect(first.connectionName).toBe('生产服务器')
    expect(first).not.toHaveProperty('output')
    expect(first).not.toHaveProperty('exitCode')

    const state = await repository.list()
    expect(state.entries.map((entry) => entry.id)).toEqual([second.id, first.id])

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      data: { entries: CommandHistoryEntry[] }
    }
    expect(persisted.version).toBe(COMMAND_HISTORY_STORE_VERSION)
    expect(persisted.data.entries.map((entry) => entry.id)).toEqual([second.id, first.id])

    await expect(new CommandHistoryRepository(filePath).list()).resolves.toEqual(state)
  })

  it('keeps only the newest entries at the storage limit', async () => {
    const entries = Array.from(
      { length: QUICK_COMMAND_LIMITS.maxHistoryEntries },
      (_, index) => storedEntry(index),
    )
    await writeFile(
      filePath,
      JSON.stringify({ version: COMMAND_HISTORY_STORE_VERSION, data: { entries } }),
      'utf8',
    )

    const repository = new CommandHistoryRepository(filePath)
    const appended = await repository.append(input({ body: 'free -h' }))
    const state = await repository.list()

    expect(state.entries).toHaveLength(QUICK_COMMAND_LIMITS.maxHistoryEntries)
    expect(state.entries[0]).toEqual(appended)
    expect(state.entries.some((entry) => entry.id === 'ch-199')).toBe(false)
    expect(state.entries.at(-1)?.id).toBe('ch-198')
  })

  it('removes a single entry and reports the removal', async () => {
    const repository = new CommandHistoryRepository(filePath)
    const entry = await repository.append(input())

    await expect(repository.remove(entry.id)).resolves.toEqual({ id: entry.id })
    await expect(repository.remove(entry.id)).rejects.toMatchObject({ code: 'not-found' })
    await expect(repository.list()).resolves.toEqual({ entries: [] })
  })

  it('refuses to load a corrupt history file but allows an explicit clear', async () => {
    const original = JSON.stringify({ version: 1, data: { entries: 'broken' } })
    await writeFile(filePath, original, 'utf8')

    const repository = new CommandHistoryRepository(filePath)
    await expect(repository.list()).rejects.toMatchObject({ code: 'storage-corrupt' })
    await expect(repository.append(input())).rejects.toMatchObject({ code: 'storage-corrupt' })
    expect(await readFile(filePath, 'utf8')).toBe(original)

    await expect(repository.clear()).resolves.toEqual({ cleared: 0 })
    await expect(repository.list()).resolves.toEqual({ entries: [] })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      data: { entries: unknown[] }
    }
    expect(persisted.version).toBe(COMMAND_HISTORY_STORE_VERSION)
    expect(persisted.data.entries).toEqual([])
  })
})
