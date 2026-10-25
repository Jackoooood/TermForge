import { describe, expect, it } from 'vitest'
import {
  dynamicForwardCreateInputSchema,
  localForwardCreateInputSchema,
  localForwardRuleSchema,
  persistedPortForwardsSchema,
  portForwardCreateInputSchema,
  portForwardRuleSchema,
  portForwardUpdateInputSchema,
  startPortForwardInputSchema,
} from '@shared/schemas/portForward'
import { PORT_FORWARD_LIMITS, PORT_FORWARD_STORE_VERSION } from '@shared/constants/portForward'
import type { PortForwardRule } from '@shared/types'

const ISO = '2026-10-23T08:00:00.000Z'

const LOCAL_CREATE = {
  type: 'local',
  name: '  web console  ',
  connectionId: 'conn-web',
  bindAddress: '127.0.0.1',
  bindPort: 8080,
  targetHost: '10.20.4.11',
  targetPort: 80,
}

function localRule(id: string, overrides: Partial<PortForwardRule> = {}): PortForwardRule {
  return {
    id,
    name: 'web console',
    type: 'local',
    connectionId: 'conn-web',
    bindAddress: '127.0.0.1',
    bindPort: 8080,
    targetHost: '10.20.4.11',
    targetPort: 80,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  } as PortForwardRule
}

describe('port forward schemas', () => {
  it('defaults local and remote binds to loopback and canonicalizes literals', () => {
    const local = localForwardCreateInputSchema.parse({
      ...LOCAL_CREATE,
      bindAddress: undefined,
    })
    expect(local.name).toBe('web console')
    expect(local.bindAddress).toBe('127.0.0.1')

    expect(
      localForwardCreateInputSchema.parse({ ...LOCAL_CREATE, bindAddress: '[::1]' }).bindAddress,
    ).toBe('::1')
    expect(
      localForwardCreateInputSchema.parse({ ...LOCAL_CREATE, targetHost: '[::1]' }).targetHost,
    ).toBe('::1')
    expect(
      portForwardCreateInputSchema.parse({
        ...LOCAL_CREATE,
        type: 'remote',
        bindAddress: undefined,
      }).type,
    ).toBe('remote')
  })

  it('forces dynamic forwarding to bind loopback and rejects client-chosen addresses', () => {
    const dynamic = dynamicForwardCreateInputSchema.parse({
      type: 'dynamic',
      name: 'socks',
      connectionId: 'conn-web',
      bindPort: 1080,
    })
    expect(dynamic).not.toHaveProperty('bindAddress')
    expect(
      dynamicForwardCreateInputSchema.safeParse({
        type: 'dynamic',
        name: 'socks',
        connectionId: 'conn-web',
        bindAddress: '0.0.0.0',
        bindPort: 1080,
      }).success,
    ).toBe(false)
  })

  it('rejects invalid ports, hostnames and secret-bearing fields', () => {
    for (const bindPort of [0, 65_536, 1.5, Number.NaN]) {
      expect(localForwardCreateInputSchema.safeParse({ ...LOCAL_CREATE, bindPort }).success).toBe(
        false,
      )
    }
    expect(
      localForwardCreateInputSchema.safeParse({
        ...LOCAL_CREATE,
        targetHost: 'https://10.20.4.11',
      }).success,
    ).toBe(false)
    expect(
      localForwardCreateInputSchema.safeParse({ ...LOCAL_CREATE, bindAddress: 'localhost' })
        .success,
    ).toBe(false)

    for (const field of ['password', 'passphrase', 'privateKey', 'secret']) {
      expect(
        localForwardCreateInputSchema.safeParse({ ...LOCAL_CREATE, [field]: 'leak-me' }).success,
      ).toBe(false)
      expect(localForwardRuleSchema.safeParse({ ...localRule('pf-1'), [field]: 'x' }).success).toBe(
        false,
      )
    }

    expect(
      localForwardCreateInputSchema.safeParse({ ...LOCAL_CREATE, name: 'bad\u0007name' }).success,
    ).toBe(false)
  })

  it('keeps rule types discriminated for updates and rejects type switches', () => {
    const update = {
      type: 'local' as const,
      name: 'web console',
      bindAddress: '127.0.0.1',
      bindPort: 8080,
      targetHost: '10.20.4.11',
      targetPort: 80,
    }
    expect(portForwardUpdateInputSchema.safeParse(update).success).toBe(true)
    expect(
      portForwardUpdateInputSchema.safeParse({
        ...update,
        type: 'dynamic',
        targetHost: undefined,
      }).success,
    ).toBe(false)
    expect(
      portForwardUpdateInputSchema.safeParse({ ...update, connectionId: 'conn-other' }).success,
    ).toBe(false)
    expect(
      portForwardUpdateInputSchema.safeParse({ ...update, bindAddress: undefined }).success,
    ).toBe(true)
  })

  it('requires a supported versioned envelope with non-duplicated rules', () => {
    const envelope = {
      version: PORT_FORWARD_STORE_VERSION,
      data: { rules: [localRule('pf-a')] },
    }
    expect(persistedPortForwardsSchema.safeParse(envelope).success).toBe(true)
    expect(portForwardRuleSchema.safeParse(localRule('pf-a')).success).toBe(true)

    expect(persistedPortForwardsSchema.safeParse({ ...envelope, version: 2 }).success).toBe(false)
    expect(persistedPortForwardsSchema.safeParse({ ...envelope, extra: true }).success).toBe(false)
    expect(persistedPortForwardsSchema.safeParse({ version: 1, rules: [] }).success).toBe(false)
    expect(
      persistedPortForwardsSchema.safeParse({
        ...envelope,
        data: { rules: [localRule('pf-a'), localRule('pf-a', { bindPort: 8081 })] },
      }).success,
    ).toBe(false)

    expect(
      persistedPortForwardsSchema.safeParse({
        version: PORT_FORWARD_STORE_VERSION,
        data: {
          rules: Array.from({ length: PORT_FORWARD_LIMITS.maxRules + 1 }, (_, index) =>
            localRule(`pf-${index}`, { bindPort: 1000 + index }),
          ),
        },
      }).success,
    ).toBe(false)
  })

  it('validates start requests and defaults exposure confirmation to false', () => {
    const parsed = startPortForwardInputSchema.parse({
      ruleId: 'pf-abc',
      sessionId: 'ssh-abc',
    })
    expect(parsed.confirmExposure).toBe(false)
    expect(
      startPortForwardInputSchema.safeParse({ ruleId: 'conn-abc', sessionId: 'ssh-abc' }).success,
    ).toBe(false)
    expect(
      startPortForwardInputSchema.safeParse({ ruleId: 'pf-abc', sessionId: 'sshtab-abc' }).success,
    ).toBe(false)
  })
})
