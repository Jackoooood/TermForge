// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { mapSshClientError, SshFailureError } from '../../src/main/services/ssh/sshFailure'

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error('transport failure'), { code })
}

describe('SSH failure mapping', () => {
  it('maps DNS, refusal, timeout and network errors to stable codes', () => {
    expect(mapSshClientError(coded('ENOTFOUND'), 'password').code).toBe('dns-failed')
    expect(mapSshClientError(coded('EAI_AGAIN'), 'password').code).toBe('dns-failed')
    expect(mapSshClientError(coded('ECONNREFUSED'), 'password').code).toBe('connection-refused')
    expect(mapSshClientError(coded('ETIMEDOUT'), 'password').code).toBe('connection-timeout')
    expect(mapSshClientError(coded('ECONNRESET'), 'password').code).toBe('network-error')
    expect(mapSshClientError(coded('ENETUNREACH'), 'password').code).toBe('network-error')
  })

  it('attaches the credential kind to authentication failures', () => {
    const password = mapSshClientError(
      Object.assign(new Error('All configured authentication methods failed'), {
        level: 'client-authentication',
      }),
      'password',
    )
    expect(password).toMatchObject({
      code: 'authentication-failed',
      credentialKind: 'password',
    })

    const privateKey = mapSshClientError(new Error('authentication failed'), 'privateKey')
    expect(privateKey).toMatchObject({
      code: 'authentication-failed',
      credentialKind: 'privateKey',
    })

    const agent = mapSshClientError(new Error('authentication failed'), 'sshAgent')
    expect(agent.credentialKind).toBeUndefined()
  })

  it('distinguishes passphrase, key format and host-key failures', () => {
    expect(mapSshClientError(new Error('Bad passphrase supplied'), 'privateKey')).toMatchObject({
      code: 'credential-invalid',
      credentialKind: 'passphrase',
    })
    expect(
      mapSshClientError(
        new Error('Encrypted private key detected, no passphrase supplied'),
        'privateKey',
      ),
    ).toMatchObject({ code: 'credential-required', credentialKind: 'passphrase' })
    expect(mapSshClientError(new Error('Cannot parse privateKey'), 'privateKey').code).toBe(
      'private-key-invalid',
    )
    expect(mapSshClientError(new Error('no matching host key type found'), 'password').code).toBe(
      'host-key-verification-failed',
    )
    expect(mapSshClientError(new Error('Host denied (verification failed)'), 'password').code).toBe(
      'host-key-verification-failed',
    )
  })

  it('passes typed failures through unchanged', () => {
    const failure = new SshFailureError('host-key-timeout')
    expect(mapSshClientError(failure, 'password')).toBe(failure.failure)
  })

  it('never echoes raw error details that may contain secrets or addresses', () => {
    const mapped = mapSshClientError(
      Object.assign(
        new Error(
          'connect ECONNRESET deploy@10.20.4.11 password=hunter2 key=-----BEGIN OPENSSH PRIVATE KEY-----',
        ),
        { code: 'ECONNRESET' },
      ),
      'password',
    )
    expect(mapped.code).toBe('network-error')
    expect(mapped.message).not.toContain('hunter2')
    expect(mapped.message).not.toContain('10.20.4.11')
    expect(mapped.message).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(mapped)).not.toContain('hunter2')

    const unknown = mapSshClientError(new Error('password=hunter2 at 10.20.4.11'), 'password')
    expect(unknown).toEqual({
      code: 'internal',
      message: 'SSH 连接过程中发生内部错误，请重试。',
    })
    expect(JSON.stringify(unknown)).not.toContain('hunter2')
  })
})
