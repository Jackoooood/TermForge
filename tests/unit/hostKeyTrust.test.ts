// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PresentedHostKey } from '@shared/types'
import { evaluateHostKey, FileHostKeyStore } from '../../src/main/storage/hostKeyRepository'

const BASE: PresentedHostKey = {
  host: '10.20.4.11',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprint: `SHA256:${'A'.repeat(43)}`,
}

describe('host key trust', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-hosts-'))
    filePath = join(directory, 'known-hosts.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('evaluates unknown, trusted and changed without any storage', () => {
    expect(evaluateHostKey(BASE, null)).toBe('unknown')
    expect(
      evaluateHostKey(BASE, {
        ...BASE,
        trustedAt: '2026-10-20T08:00:00.000Z',
        updatedAt: '2026-10-20T08:00:00.000Z',
      }),
    ).toBe('trusted')
    expect(
      evaluateHostKey(
        { ...BASE, fingerprint: `SHA256:${'B'.repeat(43)}` },
        {
          ...BASE,
          trustedAt: '2026-10-20T08:00:00.000Z',
          updatedAt: '2026-10-20T08:00:00.000Z',
        },
      ),
    ).toBe('changed')
    expect(
      evaluateHostKey(
        { ...BASE, algorithm: 'rsa-sha2-256' },
        {
          ...BASE,
          trustedAt: '2026-10-20T08:00:00.000Z',
          updatedAt: '2026-10-20T08:00:00.000Z',
        },
      ),
    ).toBe('changed')
  })

  it('never writes on verify and persists only an explicit trust decision', async () => {
    const store = new FileHostKeyStore(filePath)
    await expect(store.verify(BASE)).resolves.toBe('unknown')
    await expect(access(filePath)).rejects.toThrow()

    const trusted = await store.trust(BASE)
    expect(trusted).toMatchObject(BASE)
    expect(trusted.trustedAt).toBeTruthy()
    expect(trusted.updatedAt).toBeTruthy()

    const restarted = new FileHostKeyStore(filePath)
    await expect(restarted.verify(BASE)).resolves.toBe('trusted')
    await expect(restarted.list()).resolves.toHaveLength(1)
  })

  it('reports a changed key without replacing the stored trust decision', async () => {
    const store = new FileHostKeyStore(filePath)
    const trusted = await store.trust(BASE)
    const before = await readFile(filePath, 'utf8')

    const changed = { ...BASE, fingerprint: `SHA256:${'B'.repeat(43)}` }
    await expect(store.verify(changed)).resolves.toBe('changed')
    await expect(store.verify(changed)).resolves.toBe('changed')
    expect(await readFile(filePath, 'utf8')).toBe(before)
    await expect(new FileHostKeyStore(filePath).verify(BASE)).resolves.toBe('trusted')

    const replaced = await store.trust(changed)
    expect(replaced.fingerprint).toBe(changed.fingerprint)
    const records = await new FileHostKeyStore(filePath).list()
    expect(records).toHaveLength(1)
    expect(records[0]?.fingerprint).toBe(changed.fingerprint)
    expect(records[0]?.trustedAt).toBeTruthy()
    expect(Date.parse(trusted.updatedAt)).not.toBeNaN()
  })

  it('matches endpoints case-insensitively and removes records explicitly', async () => {
    const store = new FileHostKeyStore(filePath)
    await store.trust({ ...BASE, host: 'OPS-01.local' })
    await expect(store.verify({ ...BASE, host: 'ops-01.local' })).resolves.toBe('trusted')

    await expect(store.remove('OPS-01.local', 22)).resolves.toBe(true)
    await expect(store.verify({ ...BASE, host: 'ops-01.local' })).resolves.toBe('unknown')
    await expect(store.remove('ops-01.local', 22)).resolves.toBe(false)
    await expect(store.remove('bad host', 22)).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('stops loading corrupted trust records instead of overwriting them', async () => {
    await writeFile(filePath, JSON.stringify({ version: 1, records: [{ host: 'x' }] }))
    const store = new FileHostKeyStore(filePath)
    await expect(store.verify(BASE)).rejects.toMatchObject({ code: 'storage-corrupt' })
    await expect(store.trust(BASE)).rejects.toMatchObject({ code: 'storage-corrupt' })
  })
})
