// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialStorageStatus } from '@shared/types'
import type { CredentialEncryptionAdapter } from '../../src/main/security/credentialStore'
import { EncryptedCredentialStore } from '../../src/main/security/credentialStore'

const AVAILABLE: CredentialStorageStatus = {
  available: true,
  protection: 'windows-dpapi',
  message: 'protected',
}

const UNAVAILABLE: CredentialStorageStatus = {
  available: false,
  protection: 'unavailable',
  message: 'unavailable',
}

class FakeEncryption implements CredentialEncryptionAdapter {
  status: CredentialStorageStatus = AVAILABLE
  encryptions = 0

  async getStatus(): Promise<CredentialStorageStatus> {
    return this.status
  }

  async encrypt(secret: string): Promise<Buffer> {
    this.encryptions += 1
    return Buffer.from(`enc:${secret}`, 'utf8')
  }

  async decrypt(encrypted: Buffer): Promise<string> {
    const value = encrypted.toString('utf8')
    if (!value.startsWith('enc:')) throw new Error('cannot decrypt')
    return value.slice(4)
  }
}

describe('encrypted credential store', () => {
  let directory: string
  let filePath: string
  let encryption: FakeEncryption

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-vault-'))
    filePath = join(directory, 'credentials.enc.json')
    encryption = new FakeEncryption()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('round-trips secrets through the vault and persists only ciphertext', async () => {
    const store = new EncryptedCredentialStore(encryption, filePath)
    await store.save('vault://team/ops', 'super-secret-value')

    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('super-secret-value')
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      entries: [{ reference: 'vault://team/ops' }],
    })

    const restarted = new EncryptedCredentialStore(encryption, filePath)
    await expect(restarted.read('vault://team/ops')).resolves.toBe('super-secret-value')
    await expect(restarted.read('vault://team/missing')).resolves.toBeNull()

    await expect(restarted.remove('vault://team/ops')).resolves.toBe(true)
    await expect(restarted.remove('vault://team/ops')).resolves.toBe(false)
    expect(JSON.parse(await readFile(filePath, 'utf8')).entries).toEqual([])
  })

  it('refuses every operation when OS protection is unavailable, without creating a file', async () => {
    encryption.status = UNAVAILABLE
    const store = new EncryptedCredentialStore(encryption, filePath)

    await expect(store.save('vault://ops', 'secret')).rejects.toMatchObject({
      code: 'storage-unavailable',
    })
    await expect(store.read('vault://ops')).rejects.toMatchObject({
      code: 'storage-unavailable',
    })
    await expect(store.remove('vault://ops')).rejects.toMatchObject({
      code: 'storage-unavailable',
    })
    expect(encryption.encryptions).toBe(0)
    await expect(access(filePath)).rejects.toThrow()
  })

  it('rejects secret-looking or malformed references before encrypting', async () => {
    const store = new EncryptedCredentialStore(encryption, filePath)
    await expect(store.save('', 'secret')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.save('-----BEGIN OPENSSH PRIVATE KEY-----', 'secret')).rejects.toMatchObject(
      { code: 'invalid-input' },
    )
    await expect(store.save('vault://ops', '')).rejects.toMatchObject({ code: 'invalid-input' })
    expect(encryption.encryptions).toBe(0)
  })

  it('fails closed when decryption fails and never returns stored ciphertext', async () => {
    const store = new EncryptedCredentialStore(encryption, filePath)
    await store.save('vault://ops', 'secret')

    const failing = new FakeEncryption()
    failedDecrypt(failing)
    const restarted = new EncryptedCredentialStore(failing, filePath)
    const error = await restarted.read('vault://ops').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'storage-corrupt' })
    expect(String(error)).not.toContain('enc:secret')
  })

  it('stops loading a corrupted vault instead of overwriting it', async () => {
    await writeFile(filePath, JSON.stringify({ version: 1, entries: [{ reference: 'x' }] }))
    const store = new EncryptedCredentialStore(encryption, filePath)
    await expect(store.read('vault://ops')).rejects.toMatchObject({ code: 'storage-corrupt' })
    await expect(store.save('vault://ops', 'secret')).rejects.toMatchObject({
      code: 'storage-corrupt',
    })
    expect(JSON.parse(await readFile(filePath, 'utf8')).entries).toEqual([{ reference: 'x' }])
  })
})

function failedDecrypt(encryption: FakeEncryption): void {
  encryption.decrypt = async () => {
    throw new Error('DPAPI unavailable')
  }
}
