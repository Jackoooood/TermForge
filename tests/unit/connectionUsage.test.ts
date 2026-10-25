// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_CONNECTION_USAGE_RECORDS } from '@shared/constants/app'
import type { ConnectionUsageRecord } from '@shared/types'
import { ConnectionUsageRepository } from '../../src/main/storage/connectionUsageRepository'

const BASE_TIME = Date.parse('2026-10-01T00:00:00.000Z')

function iso(seconds: number): string {
  return new Date(BASE_TIME + seconds * 1_000).toISOString()
}

function usageRecord(index: number): ConnectionUsageRecord {
  return {
    connectionId: `conn-${String(index).padStart(3, '0')}`,
    lastAttemptAt: iso(index),
    lastConnectedAt: null,
    attemptCount: 1,
    successCount: 0,
  }
}

describe('connection usage repository', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-usage-'))
    filePath = join(directory, 'connection-usage.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('records attempts and successes without inventing success data', async () => {
    const repository = new ConnectionUsageRepository(filePath)
    expect(await repository.list()).toEqual([])

    const attempt = await repository.recordAttempt('conn-a', '2026-10-01T08:00:00+08:00')
    expect(attempt).toEqual({
      connectionId: 'conn-a',
      lastAttemptAt: '2026-10-01T00:00:00.000Z',
      lastConnectedAt: null,
      attemptCount: 1,
      successCount: 0,
    })

    const connected = await repository.recordConnected('conn-a', iso(60))
    expect(connected).toEqual({
      connectionId: 'conn-a',
      lastAttemptAt: '2026-10-01T00:00:00.000Z',
      lastConnectedAt: iso(60),
      attemptCount: 1,
      successCount: 1,
    })

    const retried = await repository.recordAttempt('conn-a', iso(120))
    expect(retried).toMatchObject({
      lastAttemptAt: iso(120),
      lastConnectedAt: iso(60),
      attemptCount: 2,
      successCount: 1,
    })

    const direct = await repository.recordConnected('conn-b', iso(180))
    expect(direct).toMatchObject({ attemptCount: 1, successCount: 1, lastConnectedAt: iso(180) })

    const reloaded = await new ConnectionUsageRepository(filePath).list()
    expect(reloaded).toEqual([direct, retried])

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      records: ConnectionUsageRecord[]
    }
    expect(raw.version).toBe(1)
    expect(Object.keys(raw.records[0] ?? {}).sort()).toEqual([
      'attemptCount',
      'connectionId',
      'lastAttemptAt',
      'lastConnectedAt',
      'successCount',
    ])
  })

  it('keeps the latest timestamps when older events arrive out of order', async () => {
    const repository = new ConnectionUsageRepository(filePath)
    await repository.recordAttempt('conn-a', iso(200))
    const late = await repository.recordAttempt('conn-a', iso(100))
    expect(late).toMatchObject({ lastAttemptAt: iso(200), attemptCount: 2 })

    await repository.recordConnected('conn-a', iso(300))
    const olderSuccess = await repository.recordConnected('conn-a', iso(150))
    expect(olderSuccess).toMatchObject({
      lastConnectedAt: iso(300),
      attemptCount: 2,
      successCount: 2,
    })
  })

  it('sorts by latest attempt and keeps only the newest 100 records', async () => {
    const records = Array.from({ length: MAX_CONNECTION_USAGE_RECORDS }, (_, index) =>
      usageRecord(index),
    )
    await writeFile(filePath, JSON.stringify({ version: 1, records }), 'utf8')

    const repository = new ConnectionUsageRepository(filePath)
    await repository.recordAttempt('conn-new', iso(1_000))

    const list = await repository.list()
    expect(list).toHaveLength(MAX_CONNECTION_USAGE_RECORDS)
    expect(list[0]?.connectionId).toBe('conn-new')
    expect(list[1]?.connectionId).toBe('conn-099')
    expect(list.some((record) => record.connectionId === 'conn-000')).toBe(false)

    const reloaded = await new ConnectionUsageRepository(filePath).list()
    expect(reloaded).toHaveLength(MAX_CONNECTION_USAGE_RECORDS)
    expect(reloaded[0]?.connectionId).toBe('conn-new')
  })

  it('removes and clears records with accurate acknowledgements', async () => {
    const repository = new ConnectionUsageRepository(filePath)
    await repository.recordAttempt('conn-a', iso(10))
    await repository.recordAttempt('conn-b', iso(20))

    await expect(repository.remove('conn-a')).resolves.toEqual({
      connectionId: 'conn-a',
      removed: true,
    })
    await expect(repository.remove('conn-a')).resolves.toEqual({
      connectionId: 'conn-a',
      removed: false,
    })
    await expect(repository.clear()).resolves.toEqual({ cleared: 1 })
    await expect(repository.clear()).resolves.toEqual({ cleared: 0 })
    expect(await repository.list()).toEqual([])

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      records: unknown[]
    }
    expect(raw).toEqual({ version: 1, records: [] })
  })

  it('stops on corrupted, unsupported or invalid files without overwriting them', async () => {
    await writeFile(filePath, '{ not json', 'utf8')
    await expect(new ConnectionUsageRepository(filePath).list()).rejects.toMatchObject({
      code: 'storage-corrupt',
    })
    expect(await readFile(filePath, 'utf8')).toBe('{ not json')

    const unsupported = JSON.stringify({ version: 2, records: [] })
    await writeFile(filePath, unsupported, 'utf8')
    await expect(new ConnectionUsageRepository(filePath).list()).rejects.toMatchObject({
      code: 'storage-corrupt',
    })
    expect(await readFile(filePath, 'utf8')).toBe(unsupported)

    const duplicate = JSON.stringify({
      version: 1,
      records: [usageRecord(1), { ...usageRecord(1), lastAttemptAt: iso(2) }],
    })
    await writeFile(filePath, duplicate, 'utf8')
    await expect(new ConnectionUsageRepository(filePath).list()).rejects.toMatchObject({
      code: 'storage-corrupt',
    })
    expect(await readFile(filePath, 'utf8')).toBe(duplicate)

    const impossible = JSON.stringify({
      version: 1,
      records: [{ ...usageRecord(1), successCount: 2 }],
    })
    await writeFile(filePath, impossible, 'utf8')
    await expect(new ConnectionUsageRepository(filePath).list()).rejects.toMatchObject({
      code: 'storage-corrupt',
    })
  })

  it('rejects invalid ids, timestamps and saturated counters before writing', async () => {
    const repository = new ConnectionUsageRepository(filePath)
    await expect(repository.recordAttempt('../escape')).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(repository.recordAttempt('conn-a', 'not-a-time')).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(repository.remove('../escape')).rejects.toMatchObject({ code: 'invalid-input' })
    expect(await readFile(filePath, 'utf8').catch(() => null)).toBeNull()

    const saturated = JSON.stringify({
      version: 1,
      records: [
        {
          ...usageRecord(1),
          attemptCount: 1_000_000_000,
          successCount: 1,
          lastConnectedAt: iso(1),
        },
      ],
    })
    await writeFile(filePath, saturated, 'utf8')
    await expect(
      new ConnectionUsageRepository(filePath).recordAttempt('conn-001', iso(5)),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(await readFile(filePath, 'utf8')).toBe(saturated)
  })
})
