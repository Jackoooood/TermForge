// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '@shared/types'
import type { CredentialStore } from '../../src/main/security/credentialStore'
import {
  credentialReference,
  SystemSshAgentLocator,
  VaultCredentialResolver,
} from '../../src/main/services/ssh/credentialResolver'
import {
  isEncryptedPrivateKey,
  resolvePrivateKeyPath,
} from '../../src/main/services/ssh/privateKey'
import { SshFailureError } from '../../src/main/services/ssh/sshFailure'

const STATUS = {
  available: true,
  protection: 'windows-dpapi',
  message: 'protected',
} as const

const OPENSSH_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n')

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'conn-1',
    name: 'prod',
    host: '10.20.4.11',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    groupId: 'production',
    tagIds: [],
    jumpConnectionIds: [],
    favorite: false,
    createdAt: '2026-10-22T08:00:00.000Z',
    updatedAt: '2026-10-22T08:00:00.000Z',
    ...overrides,
  }
}

function createStore(values: Record<string, string> = {}) {
  const entries = new Map(Object.entries(values))
  const save = vi.fn(async (reference: string, secret: string) => {
    entries.set(reference, secret)
  })
  const read = vi.fn(async (reference: string) => entries.get(reference) ?? null)
  const remove = vi.fn(async (reference: string) => entries.delete(reference))
  const store: CredentialStore = {
    getStatus: async () => STATUS,
    save,
    read,
    remove,
  }
  return { store, entries, save, read, remove }
}

describe('credential resolver', () => {
  it('reads password auth from the connection vault reference', async () => {
    const reference = credentialReference('conn-1', 'password')
    const { store, read } = createStore({ [reference]: 'vault-password' })
    const resolver = new VaultCredentialResolver({ credentials: store })

    await expect(resolver.resolve(profile())).resolves.toEqual({
      method: 'password',
      password: 'vault-password',
    })
    expect(read).toHaveBeenCalledWith(reference)
  })

  it('prefers an explicitly configured credential reference', async () => {
    const { store, read } = createStore({
      'vault://team/ops': 'team-password',
      [credentialReference('conn-1', 'password')]: 'fallback-password',
    })
    const resolver = new VaultCredentialResolver({ credentials: store })

    await expect(
      resolver.resolve(profile({ credentialRef: 'vault://team/ops' })),
    ).resolves.toEqual({ method: 'password', password: 'team-password' })
    expect(read).toHaveBeenNthCalledWith(1, 'vault://team/ops')
  })

  it('requests a password when none is stored and fails closed if the vault throws', async () => {
    const missing = new VaultCredentialResolver({ credentials: createStore().store })
    await expect(missing.resolve(profile())).rejects.toMatchObject({
      failure: { code: 'credential-required', credentialKind: 'password' },
    })

    const broken = createStore()
    broken.read.mockRejectedValueOnce(new Error('DPAPI unavailable'))
    const resolver = new VaultCredentialResolver({ credentials: broken.store })
    await expect(resolver.resolve(profile())).rejects.toMatchObject({
      failure: { code: 'credential-unavailable' },
    })
  })

  it('reads an unencrypted private key from an explicit file path', async () => {
    const readPrivateKeyFile = vi.fn(async () => `${OPENSSH_KEY}\r\n`)
    const { store } = createStore()
    const resolver = new VaultCredentialResolver({
      credentials: store,
      readPrivateKeyFile,
    })

    const auth = await resolver.resolve(
      profile({ authMethod: 'privateKey', credentialRef: 'C:\\keys\\id_ed25519' }),
    )
    expect(readPrivateKeyFile).toHaveBeenCalledWith('C:\\keys\\id_ed25519')
    expect(auth).toEqual({
      method: 'privateKey',
      privateKey: Buffer.from(`${OPENSSH_KEY}\n`, 'utf8'),
    })
    expect(auth).not.toHaveProperty('passphrase')
    expect(JSON.stringify(auth)).not.toContain('PRIVATE KEY')
  })

  it('requires a stored passphrase for an encrypted private key', async () => {
    const encrypted = ['-----BEGIN ENCRYPTED PRIVATE KEY-----', 'ciphertext', '-----END ENCRYPTED PRIVATE KEY-----'].join('\n')
    const passphraseRef = credentialReference('conn-1', 'passphrase')
    const readPrivateKeyFile = vi.fn(async () => encrypted)
    const { store, read } = createStore({ [passphraseRef]: 'key-passphrase' })
    const resolver = new VaultCredentialResolver({
      credentials: store,
      readPrivateKeyFile,
    })

    await expect(
      resolver.resolve(profile({ authMethod: 'privateKey', credentialRef: '~/.ssh/id_rsa' })),
    ).resolves.toMatchObject({
      method: 'privateKey',
      passphrase: 'key-passphrase',
    })
    expect(read).toHaveBeenCalledWith(passphraseRef)

    const noPassphrase = createStore()
    const missing = new VaultCredentialResolver({
      credentials: noPassphrase.store,
      readPrivateKeyFile,
    })
    await expect(
      missing.resolve(profile({ authMethod: 'privateKey', credentialRef: '~/.ssh/id_rsa' })),
    ).rejects.toMatchObject({
      failure: { code: 'credential-required', credentialKind: 'passphrase' },
    })
  })

  it('reads a pasted private key from the vault and asks for it when absent', async () => {
    const reference = credentialReference('conn-1', 'privateKey')
    const { store } = createStore({ [reference]: OPENSSH_KEY })
    const resolver = new VaultCredentialResolver({ credentials: store })

    await expect(resolver.resolve(profile({ authMethod: 'privateKey' }))).resolves.toMatchObject({
      method: 'privateKey',
      privateKey: Buffer.from(OPENSSH_KEY, 'utf8'),
    })

    const missing = new VaultCredentialResolver({ credentials: createStore().store })
    await expect(missing.resolve(profile({ authMethod: 'privateKey' }))).rejects.toMatchObject({
      failure: { code: 'credential-required', credentialKind: 'privateKey' },
    })
  })

  it('uses the located system agent and reports when none is available', async () => {
    const located = new VaultCredentialResolver({
      credentials: createStore().store,
      agentLocator: { locate: async () => '\\\\.\\pipe\\openssh-ssh-agent' },
    })
    await expect(
      located.resolve(profile({ authMethod: 'sshAgent', credentialRef: undefined })),
    ).resolves.toEqual({ method: 'sshAgent', agent: '\\\\.\\pipe\\openssh-ssh-agent' })

    const absent = new VaultCredentialResolver({
      credentials: createStore().store,
      agentLocator: { locate: async () => null },
    })
    await expect(
      absent.resolve(profile({ authMethod: 'sshAgent', credentialRef: undefined })),
    ).rejects.toMatchObject({ failure: { code: 'agent-unavailable' } })
  })

  it('normalizes and validates saved credentials before writing the vault', async () => {
    const { store, save } = createStore()
    const resolver = new VaultCredentialResolver({ credentials: store })

    await resolver.saveCredential(profile(), 'password', 'vault-password')
    expect(save).toHaveBeenCalledWith(
      credentialReference('conn-1', 'password'),
      'vault-password',
    )

    await resolver.saveCredential(
      profile({ authMethod: 'privateKey' }),
      'privateKey',
      `${OPENSSH_KEY}\r\n`,
    )
    expect(save).toHaveBeenLastCalledWith(
      credentialReference('conn-1', 'privateKey'),
      OPENSSH_KEY,
    )

    await expect(
      resolver.saveCredential(profile({ authMethod: 'privateKey' }), 'privateKey', 'not a key'),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      resolver.saveCredential(profile(), 'password', ''),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      resolver.saveCredential(profile({ authMethod: 'sshAgent' }), 'password', 'secret'),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      resolver.saveCredential(profile({ authMethod: 'privateKey' }), 'password', 'secret'),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(save).toHaveBeenCalledTimes(2)
  })
})

describe('system SSH agent locator', () => {
  it('uses the Windows OpenSSH agent pipe when present', async () => {
    const pathExists = vi.fn(async () => true)
    const locator = new SystemSshAgentLocator('win32', {}, pathExists)
    await expect(locator.locate()).resolves.toBe('\\\\.\\pipe\\openssh-ssh-agent')
    expect(pathExists).toHaveBeenCalledWith('\\\\.\\pipe\\openssh-ssh-agent')

    const missing = new SystemSshAgentLocator('win32', {}, async () => false)
    await expect(missing.locate()).resolves.toBeNull()
  })

  it('uses SSH_AUTH_SOCK on POSIX systems and handles stale sockets', async () => {
    const present = new SystemSshAgentLocator(
      'linux',
      { SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
      async (target) => target === '/tmp/ssh-agent.sock',
    )
    await expect(present.locate()).resolves.toBe('/tmp/ssh-agent.sock')

    const stale = new SystemSshAgentLocator('linux', { SSH_AUTH_SOCK: '/tmp/stale.sock' }, async () => false)
    await expect(stale.locate()).resolves.toBeNull()
    await expect(new SystemSshAgentLocator('linux', {}, async () => true).locate()).resolves.toBeNull()
  })
})

describe('private key helpers', () => {
  it('detects encrypted OpenSSH and PEM key material', () => {
    expect(isEncryptedPrivateKey('-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n')).toBe(true)
    expect(isEncryptedPrivateKey(`-----BEGIN OPENSSH PRIVATE KEY-----\n${'A'.repeat(40)}\n-----END OPENSSH PRIVATE KEY-----`)).toBe(false)
    expect(isEncryptedPrivateKey(OPENSSH_KEY)).toBe(false)
  })

  it('resolves ~ paths and rejects relative paths', () => {
    expect(resolvePrivateKeyPath('~/.ssh/id_ed25519', 'C:\\Users\\ops')).toBe(
      'C:\\Users\\ops/.ssh/id_ed25519',
    )
    expect(() => resolvePrivateKeyPath('keys/id_ed25519', 'C:\\Users\\ops')).toThrowError(
      SshFailureError,
    )
    expect(resolvePrivateKeyPath('C:\\keys\\id_ed25519')).toBe('C:\\keys\\id_ed25519')
  })
})
