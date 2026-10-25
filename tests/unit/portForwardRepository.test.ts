// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PORT_FORWARD_STORE_VERSION } from '@shared/constants/portForward'
import type { PortForwardCreateInput, PortForwardRule } from '@shared/types'
import { PortForwardRepository } from '../../src/main/storage/portForwardRepository'

const ISO = '2026-10-23T08:00:00.000Z'

function localInput(overrides: Partial<PortForwardCreateInput> = {}): PortForwardCreateInput {
  return {
    type: 'local',
    name: 'web console',
    connectionId: 'conn-a',
    bindPort: 8080,
    targetHost: '10.0.0.9',
    targetPort: 80,
    ...overrides,
  } as PortForwardCreateInput
}

function storedRule(index: number): PortForwardRule {
  return {
    id: `pf-${index}`,
    name: `rule-${index}`,
    type: 'local',
    connectionId: 'conn-a',
    bindAddress: '127.0.0.1',
    bindPort: 2000 + index,
    targetHost: '10.0.0.9',
    targetPort: 80,
    createdAt: ISO,
    updatedAt: ISO,
  }
}

describe('port forward repository', () => {
  let directory: string
  let filePath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-port-forwards-'))
    filePath = join(directory, 'port-forwards.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('creates an empty versioned store on first load and persists rules atomically', async () => {
    const repository = new PortForwardRepository(filePath)
    await expect(repository.list()).resolves.toEqual({ rules: [] })

    const empty = JSON.parse(await readFile(filePath, 'utf8')) as { version: number }
    expect(empty.version).toBe(PORT_FORWARD_STORE_VERSION)

    const rule = await repository.create(localInput({ name: '  web console  ' }))
    expect(rule.id).toMatch(/^pf-[0-9a-f-]{36}$/)
    expect(rule.name).toBe('web console')
    expect(rule.bindAddress).toBe('127.0.0.1')

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      data: { rules: PortForwardRule[] }
    }
    expect(persisted.version).toBe(PORT_FORWARD_STORE_VERSION)
    expect(persisted.data.rules).toEqual([rule])

    await expect(new PortForwardRepository(filePath).list()).resolves.toEqual({ rules: [rule] })
  })

  it('forces dynamic rules onto the loopback interface', async () => {
    const rule = await new PortForwardRepository(filePath).create({
      type: 'dynamic',
      name: 'socks',
      connectionId: 'conn-a',
      bindPort: 1080,
    })
    expect(rule).toMatchObject({
      type: 'dynamic',
      bindAddress: '127.0.0.1',
      bindPort: 1080,
    })
    expect(rule).not.toHaveProperty('targetHost')
  })

  it('updates a rule without letting callers move it to another connection or type', async () => {
    const repository = new PortForwardRepository(filePath)
    const created = await repository.create(localInput())

    const updated = await repository.update(created.id, {
      type: 'local',
      name: 'renamed',
      bindAddress: '[::1]',
      bindPort: 9090,
      targetHost: 'db.internal',
      targetPort: 5432,
    })
    expect(updated).toMatchObject({
      id: created.id,
      connectionId: 'conn-a',
      createdAt: created.createdAt,
      name: 'renamed',
      bindAddress: '::1',
      bindPort: 9090,
      targetHost: 'db.internal',
      targetPort: 5432,
    })
    expect(updated.updatedAt >= created.updatedAt).toBe(true)

    await expect(
      repository.update(created.id, {
        type: 'remote',
        name: 'switch',
        bindPort: 8081,
        targetHost: '10.0.0.9',
        targetPort: 80,
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    await expect(
      repository.update(created.id, {
        ...localInput({ name: 'leak' }),
        password: 'secret',
      } as unknown as PortForwardCreateInput),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    await expect(repository.update('pf-missing', localInput())).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('rejects invalid rules without writing them to disk', async () => {
    const repository = new PortForwardRepository(filePath)
    await repository.list()

    await expect(
      repository.create(localInput({ bindPort: 0 } as Partial<PortForwardCreateInput>)),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      repository.create({ ...localInput(), privateKey: 'leak' } as unknown as PortForwardCreateInput),
    ).rejects.toMatchObject({ code: 'invalid-input' })

    await expect(repository.list()).resolves.toEqual({ rules: [] })
  })

  it('removes one rule or every rule belonging to a connection', async () => {
    const repository = new PortForwardRepository(filePath)
    const first = await repository.create(localInput({ bindPort: 8080 }))
    const second = await repository.create(localInput({ bindPort: 8081 }))
    const other = await repository.create(
      localInput({ bindPort: 8082, connectionId: 'conn-b' } as Partial<PortForwardCreateInput>),
    )

    await expect(repository.remove(first.id)).resolves.toEqual({ id: first.id })
    await expect(repository.remove(first.id)).rejects.toMatchObject({ code: 'not-found' })

    const removal = await repository.removeForConnection('conn-a')
    expect(removal.ids).toEqual([second.id])
    await expect(repository.list()).resolves.toEqual({ rules: [other] })
    await expect(repository.removeForConnection('conn-a')).resolves.toEqual({ ids: [] })
  })

  it('enforces the rule limit before writing', async () => {
    const rules = Array.from({ length: 100 }, (_, index) => storedRule(index))
    await writeFile(
      filePath,
      JSON.stringify({ version: PORT_FORWARD_STORE_VERSION, data: { rules } }),
      'utf8',
    )

    const repository = new PortForwardRepository(filePath)
    await expect(repository.create(localInput())).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect((await repository.list()).rules).toHaveLength(100)
  })

  it('refuses to overwrite corrupt or unsupported files', async () => {
    await writeFile(filePath, '{not-json', 'utf8')
    await expect(new PortForwardRepository(filePath).list()).rejects.toMatchObject({
      code: 'storage-corrupt',
    })
    expect(await readFile(filePath, 'utf8')).toBe('{not-json')

    const unsupported = JSON.stringify({ version: 99, data: { rules: [] } })
    await writeFile(filePath, unsupported, 'utf8')
    await expect(new PortForwardRepository(filePath).list()).rejects.toMatchObject({
      code: 'storage-corrupt',
    })
    expect(await readFile(filePath, 'utf8')).toBe(unsupported)
  })

  it('serializes concurrent creates into one complete file', async () => {
    const repository = new PortForwardRepository(filePath)
    const rules = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        repository.create(localInput({ bindPort: 3000 + index } as Partial<PortForwardCreateInput>)),
      ),
    )
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(5)

    const reloaded = await new PortForwardRepository(filePath).list()
    expect(reloaded.rules).toHaveLength(5)
    expect(new Set(reloaded.rules.map((rule) => rule.bindPort))).toEqual(
      new Set([3000, 3001, 3002, 3003, 3004]),
    )
  })
})
