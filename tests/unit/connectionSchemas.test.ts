import { describe, expect, it } from 'vitest'
import {
  connectionBulkActionSchema,
  connectionCatalogSchema,
  connectionInputSchema,
  connectionProfileSchema,
  parsePersistedConnectionCatalog,
  persistedConnectionCatalogSchema,
} from '@shared/schemas/connection'
import {
  hostKeyRecordSchema,
  persistedHostKeysSchema,
  presentedHostKeySchema,
} from '@shared/schemas/hostKey'
import { MAX_JUMP_HOPS, MAX_TAGS } from '@shared/constants/app'
import type {
  ConnectionCatalog,
  ConnectionInput,
  ConnectionProfile,
  ConnectionTag,
} from '@shared/types'

const TAGS: ConnectionTag[] = [
  { id: 'tag-ops', name: 'ops', color: 'green' },
  { id: 'tag-web', name: 'web', color: 'cyan' },
]

const INPUT: ConnectionInput = {
  name: 'ops-node',
  host: '10.20.4.99',
  port: 22,
  username: 'deploy',
  authMethod: 'sshAgent',
  groupId: 'production',
  tagIds: ['tag-ops'],
  jumpConnectionIds: [],
}

const PROFILE: ConnectionProfile = {
  ...INPUT,
  id: 'conn-ops-node',
  favorite: false,
  createdAt: '2026-10-22T08:00:00.000Z',
  updatedAt: '2026-10-22T08:00:00.000Z',
}

const CATALOG: ConnectionCatalog = {
  tags: TAGS,
  groups: [{ id: 'production', name: '生产环境', tone: 'production', sortOrder: 1 }],
  connections: [PROFILE],
}

const FINGERPRINT = `SHA256:${'A'.repeat(43)}`

describe('connection runtime schemas', () => {
  it('normalizes non-sensitive input and never accepts secret-bearing fields', () => {
    const parsed = connectionInputSchema.parse({
      ...INPUT,
      name: '  ops-node  ',
      tagIds: ['tag-web', 'tag-ops'],
      credentialRef: '  vault://team/ops  ',
    })
    expect(parsed.name).toBe('ops-node')
    expect(parsed.tagIds).toEqual(['tag-web', 'tag-ops'])
    expect(parsed.credentialRef).toBe('vault://team/ops')

    for (const field of ['password', 'passphrase', 'privateKey', 'secret']) {
      expect(connectionInputSchema.safeParse({ ...INPUT, [field]: 'leak-me' }).success).toBe(false)
      expect(connectionProfileSchema.safeParse({ ...PROFILE, [field]: 'leak-me' }).success).toBe(
        false,
      )
    }

    expect(
      connectionInputSchema.safeParse({
        ...INPUT,
        credentialRef: '-----BEGIN OPENSSH PRIVATE KEY-----',
      }).success,
    ).toBe(false)
    expect(connectionInputSchema.safeParse({ ...INPUT, host: 'https://example.com' }).success).toBe(
      false,
    )
    expect(connectionInputSchema.safeParse({ ...INPUT, port: 0 }).success).toBe(false)
    expect(connectionInputSchema.safeParse({ ...INPUT, authMethod: 'telnet' }).success).toBe(false)
  })

  it('accepts ungrouped connections and rejects duplicate or oversized tag lists', () => {
    expect(connectionInputSchema.safeParse({ ...INPUT, groupId: null }).success).toBe(true)
    expect(
      connectionInputSchema.safeParse({ ...INPUT, tagIds: ['tag-ops', 'tag-ops'] }).success,
    ).toBe(false)
    expect(connectionInputSchema.safeParse({ ...INPUT, tagIds: ['../escape'] }).success).toBe(false)
    expect(
      connectionInputSchema.safeParse({
        ...INPUT,
        tagIds: Array.from({ length: MAX_TAGS + 1 }, (_, index) => `tag-${index}`),
      }).success,
    ).toBe(false)
  })

  it('rejects duplicate identifiers, dangling references and invalid tag catalogs', () => {
    expect(connectionCatalogSchema.safeParse(CATALOG).success).toBe(true)
    expect(
      connectionCatalogSchema.safeParse({
        ...CATALOG,
        connections: [{ ...PROFILE, groupId: null }],
      }).success,
    ).toBe(true)

    expect(
      connectionCatalogSchema.safeParse({
        ...CATALOG,
        connections: [PROFILE, { ...PROFILE }],
      }).success,
    ).toBe(false)

    expect(
      connectionCatalogSchema.safeParse({
        ...CATALOG,
        groups: [...CATALOG.groups, { ...CATALOG.groups[0], name: '重复' }],
      }).success,
    ).toBe(false)

    expect(
      connectionCatalogSchema.safeParse({
        ...CATALOG,
        connections: [{ ...PROFILE, groupId: 'missing' }],
      }).success,
    ).toBe(false)

    expect(
      connectionCatalogSchema.safeParse({
        ...CATALOG,
        tags: [TAGS[0], { ...TAGS[0], name: 'other' }],
      }).success,
    ).toBe(false)

    expect(
      connectionCatalogSchema.safeParse({
        ...CATALOG,
        tags: [TAGS[0], { ...TAGS[1], name: 'OPS' }],
      }).success,
    ).toBe(false)

    expect(
      connectionCatalogSchema.safeParse({
        ...CATALOG,
        tags: [{ ...TAGS[0], color: 'gold' }],
      }).success,
    ).toBe(false)

    expect(
      connectionCatalogSchema.safeParse({
        ...CATALOG,
        connections: [{ ...PROFILE, tagIds: ['tag-missing'] }],
      }).success,
    ).toBe(false)
  })

  it('requires the current versioned envelope with no unknown keys', () => {
    expect(persistedConnectionCatalogSchema.safeParse({ version: 3, data: CATALOG }).success).toBe(
      true,
    )
    // Older versions are migrated by parsePersistedConnectionCatalog, never parsed directly.
    expect(persistedConnectionCatalogSchema.safeParse({ version: 2, data: CATALOG }).success).toBe(
      false,
    )
    expect(persistedConnectionCatalogSchema.safeParse({ version: 1, data: CATALOG }).success).toBe(
      false,
    )
    expect(
      persistedConnectionCatalogSchema.safeParse({ version: 3, data: CATALOG, extra: true })
        .success,
    ).toBe(false)
  })

  it('validates the bulk action union', () => {
    expect(connectionBulkActionSchema.safeParse({ type: 'favorite', favorite: true }).success).toBe(
      true,
    )
    expect(connectionBulkActionSchema.safeParse({ type: 'set-group', groupId: null }).success).toBe(
      true,
    )
    expect(
      connectionBulkActionSchema.safeParse({ type: 'add-tags', tagIds: ['tag-ops'] }).success,
    ).toBe(true)
    expect(
      connectionBulkActionSchema.safeParse({ type: 'remove-tags', tagIds: ['tag-ops'] }).success,
    ).toBe(true)

    expect(connectionBulkActionSchema.safeParse({ type: 'add-tags', tagIds: [] }).success).toBe(
      false,
    )
    expect(
      connectionBulkActionSchema.safeParse({
        type: 'add-tags',
        tagIds: ['tag-ops', 'tag-ops'],
      }).success,
    ).toBe(false)
    expect(
      connectionBulkActionSchema.safeParse({ type: 'favorite', favorite: true, extra: 1 }).success,
    ).toBe(false)
    expect(connectionBulkActionSchema.safeParse({ type: 'delete' }).success).toBe(false)
  })
})

function jumpProfile(id: string, jumpConnectionIds: string[] = []): ConnectionProfile {
  return {
    ...INPUT,
    id,
    jumpConnectionIds,
    favorite: false,
    createdAt: '2026-10-22T08:00:00.000Z',
    updatedAt: '2026-10-22T08:00:00.000Z',
  }
}

describe('jump host references', () => {
  it('accepts an ordered chain and rejects duplicates, bad ids and oversized lists on input', () => {
    expect(
      connectionInputSchema.safeParse({
        ...INPUT,
        jumpConnectionIds: ['conn-a', 'conn-b'],
      }).success,
    ).toBe(true)

    expect(
      connectionInputSchema.safeParse({
        ...INPUT,
        jumpConnectionIds: ['conn-a', 'conn-a'],
      }).success,
    ).toBe(false)

    expect(
      connectionInputSchema.safeParse({
        ...INPUT,
        jumpConnectionIds: ['../escape'],
      }).success,
    ).toBe(false)

    expect(
      connectionInputSchema.safeParse({
        ...INPUT,
        jumpConnectionIds: Array.from({ length: MAX_JUMP_HOPS + 1 }, (_, index) => `conn-${index}`),
      }).success,
    ).toBe(false)

    expect(
      connectionInputSchema.safeParse({
        ...INPUT,
        jumpConnectionIds: Array.from({ length: MAX_JUMP_HOPS }, (_, index) => `conn-${index}`),
      }).success,
    ).toBe(true)
  })

  it('defaults a missing jump list so pre-P1-02 payloads keep working', () => {
    const parsed = connectionInputSchema.parse({
      name: 'legacy-node',
      host: '10.20.4.99',
      port: 22,
      username: 'deploy',
      authMethod: 'sshAgent',
      groupId: 'production',
      tagIds: ['tag-ops'],
    })
    expect(parsed.jumpConnectionIds).toEqual([])
  })

  it('rejects self references and dangling references inside a catalog', () => {
    const groups = CATALOG.groups

    expect(
      connectionCatalogSchema.safeParse({
        tags: TAGS,
        groups,
        connections: [jumpProfile('conn-a', ['conn-a'])],
      }).success,
    ).toBe(false)

    expect(
      connectionCatalogSchema.safeParse({
        tags: TAGS,
        groups,
        connections: [jumpProfile('conn-a', ['conn-missing'])],
      }).success,
    ).toBe(false)

    expect(
      connectionCatalogSchema.safeParse({
        tags: TAGS,
        groups,
        connections: [
          jumpProfile('conn-a', ['conn-b']),
          jumpProfile('conn-b', ['conn-c']),
          jumpProfile('conn-c'),
        ],
      }).success,
    ).toBe(true)
  })

  it('rejects two-node and three-node jump cycles', () => {
    const groups = CATALOG.groups

    expect(
      connectionCatalogSchema.safeParse({
        tags: TAGS,
        groups,
        connections: [jumpProfile('conn-a', ['conn-b']), jumpProfile('conn-b', ['conn-a'])],
      }).success,
    ).toBe(false)

    expect(
      connectionCatalogSchema.safeParse({
        tags: TAGS,
        groups,
        connections: [
          jumpProfile('conn-a', ['conn-b']),
          jumpProfile('conn-b', ['conn-c']),
          jumpProfile('conn-c', ['conn-a']),
        ],
      }).success,
    ).toBe(false)
  })
})

function legacyProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-legacy',
    name: 'legacy',
    host: '10.20.4.99',
    port: 22,
    username: 'deploy',
    authMethod: 'sshAgent',
    groupId: 'production',
    tags: ['Ops', ' ops ', 'web'],
    favorite: false,
    createdAt: '2026-10-22T08:00:00.000Z',
    updatedAt: '2026-10-22T08:00:00.000Z',
    ...overrides,
  }
}

describe('legacy catalog migration', () => {
  it('upgrades v2 free-text tags into a deterministic tag catalog', () => {
    const migrated = parsePersistedConnectionCatalog({
      version: 2,
      data: {
        connections: [{ ...legacyProfile(), jumpConnectionIds: [] }],
        groups: CATALOG.groups,
      },
    })

    expect(migrated?.migratedFromVersion).toBe(2)
    expect(migrated?.catalog.tags).toEqual([
      { id: 'tag-ops', name: 'Ops', color: 'neutral' },
      { id: 'tag-web', name: 'web', color: 'neutral' },
    ])
    expect(migrated?.catalog.connections[0]).toMatchObject({
      groupId: 'production',
      tagIds: ['tag-ops', 'tag-web'],
      jumpConnectionIds: [],
    })

    const repeated = parsePersistedConnectionCatalog({
      version: 2,
      data: {
        connections: [{ ...legacyProfile(), jumpConnectionIds: [] }],
        groups: CATALOG.groups,
      },
    })
    expect(repeated?.catalog).toEqual(migrated?.catalog)
  })

  it('disambiguates colliding slugs and preserves the first observed spelling', () => {
    const migrated = parsePersistedConnectionCatalog({
      version: 2,
      data: {
        connections: [{ ...legacyProfile({ tags: ['Ops', 'OPS!'] }), jumpConnectionIds: [] }],
        groups: CATALOG.groups,
      },
    })

    expect(migrated?.catalog.tags).toEqual([
      { id: 'tag-ops', name: 'Ops', color: 'neutral' },
      { id: 'tag-ops-2', name: 'OPS!', color: 'neutral' },
    ])
    expect(migrated?.catalog.connections[0]?.tagIds).toEqual(['tag-ops', 'tag-ops-2'])
  })

  it('upgrades v1 envelopes with an empty jump list and writes nothing itself', () => {
    const raw = {
      version: 1,
      data: { connections: [legacyProfile()], groups: CATALOG.groups },
    }
    const migrated = parsePersistedConnectionCatalog(raw)
    expect(migrated?.migratedFromVersion).toBe(1)
    expect(migrated?.catalog.connections[0]?.jumpConnectionIds).toEqual([])
    expect(migrated?.catalog.tags.map((tag) => tag.id)).toEqual(['tag-ops', 'tag-web'])
    expect(raw).not.toHaveProperty('data.tags')
  })

  it('leaves current envelopes untouched and rejects unknown or invalid files', () => {
    const current = parsePersistedConnectionCatalog({ version: 3, data: CATALOG })
    expect(current?.migratedFromVersion).toBeNull()
    expect(current?.catalog.connections[0]?.name).toBe('ops-node')

    expect(parsePersistedConnectionCatalog({ version: 4, data: CATALOG })).toBeNull()
    expect(parsePersistedConnectionCatalog({ foo: 'bar' })).toBeNull()
    expect(
      parsePersistedConnectionCatalog({
        version: 2,
        data: {
          connections: [{ ...legacyProfile({ groupId: 'missing' }), jumpConnectionIds: [] }],
          groups: CATALOG.groups,
        },
      }),
    ).toBeNull()
    expect(
      parsePersistedConnectionCatalog({
        version: 1,
        data: {
          connections: [legacyProfile(), legacyProfile()],
          groups: CATALOG.groups,
        },
      }),
    ).toBeNull()
  })
})

describe('host key schemas', () => {
  const presented = {
    host: '10.20.4.11',
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprint: FINGERPRINT,
  }
  const record = {
    ...presented,
    trustedAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000Z',
  }

  it('accepts OpenSSH SHA256 fingerprints only', () => {
    expect(presentedHostKeySchema.safeParse(presented).success).toBe(true)
    expect(
      presentedHostKeySchema.safeParse({ ...presented, fingerprint: 'MD5:aa:bb' }).success,
    ).toBe(false)
    expect(presentedHostKeySchema.safeParse({ ...presented, algorithm: 'ssh-dss' }).success).toBe(
      false,
    )
    expect(presentedHostKeySchema.safeParse({ ...presented, extra: true }).success).toBe(false)
  })

  it('validates timestamps and unique endpoints in the persisted store', () => {
    expect(hostKeyRecordSchema.safeParse(record).success).toBe(true)
    expect(
      hostKeyRecordSchema.safeParse({
        ...record,
        trustedAt: '2026-10-21T08:00:00.000Z',
        updatedAt: '2026-10-20T08:00:00.000Z',
      }).success,
    ).toBe(false)

    expect(persistedHostKeysSchema.safeParse({ version: 1, records: [record] }).success).toBe(true)
    expect(
      persistedHostKeysSchema.safeParse({
        version: 1,
        records: [record, { ...record, host: '10.20.4.11' }],
      }).success,
    ).toBe(false)
    expect(
      persistedHostKeysSchema.safeParse({
        version: 1,
        records: [{ ...record, fingerprint: 'SHA256:short' }],
      }).success,
    ).toBe(false)
  })
})
