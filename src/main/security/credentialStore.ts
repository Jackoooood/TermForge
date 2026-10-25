import { z } from 'zod'
import type { CredentialStorageStatus } from '../../shared/types/security'
import { AppOperationError } from '../errors'
import { readJsonFile, writeJsonFileAtomic } from '../storage/jsonFile'

const MAX_SECRET_LENGTH = 65_536
const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
}

const referenceSchema = z
  .string()
  .trim()
  .min(1, '凭据引用不能为空')
  .max(512, '凭据引用过长')
  .refine(
    (value) => !hasControlCharacters(value) && !PRIVATE_KEY_MARKER.test(value),
    '凭据引用不能包含控制字符或密钥内容',
  )

const vaultEntrySchema = z.strictObject({
  reference: referenceSchema,
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, '加密数据格式无效')
    .max(400_000),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})

const persistedCredentialVaultSchema = z
  .strictObject({
    version: z.literal(1),
    entries: z.array(vaultEntrySchema).max(2_000),
  })
  .superRefine((value, context) => {
    const references = new Set<string>()
    for (const [index, entry] of value.entries.entries()) {
      if (references.has(entry.reference)) {
        context.addIssue({
          code: 'custom',
          message: '凭据引用不能重复',
          path: ['entries', index, 'reference'],
        })
      }
      references.add(entry.reference)
    }
  })

type VaultEntry = z.infer<typeof vaultEntrySchema>

export interface CredentialEncryptionAdapter {
  getStatus(): Promise<CredentialStorageStatus>
  encrypt(secret: string): Promise<Buffer>
  decrypt(encrypted: Buffer): Promise<string>
}

export interface CredentialStore {
  getStatus(): Promise<CredentialStorageStatus>
  save(reference: string, secret: string): Promise<void>
  read(reference: string): Promise<string | null>
  remove(reference: string): Promise<boolean>
}

/**
 * Encrypted-at-rest credential vault. Encryption is delegated to Electron
 * safeStorage (DPAPI/Keychain/keyring). There is deliberately no plaintext
 * fallback: if the adapter reports unavailable, every credential operation is
 * refused before any file is touched.
 */
export class EncryptedCredentialStore implements CredentialStore {
  private entries: VaultEntry[] | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly encryption: CredentialEncryptionAdapter,
    private readonly filePath: string,
  ) {}

  getStatus(): Promise<CredentialStorageStatus> {
    return this.encryption.getStatus()
  }

  save(reference: string, secret: string): Promise<void> {
    return this.exclusive(async () => {
      await this.requireAvailable()
      const parsedReference = referenceSchema.safeParse(reference)
      if (!parsedReference.success) {
        throw new AppOperationError('invalid-input', '凭据引用格式无效。')
      }
      if (typeof secret !== 'string' || secret.length === 0) {
        throw new AppOperationError('invalid-input', '凭据内容不能为空。')
      }
      if (secret.length > MAX_SECRET_LENGTH) {
        throw new AppOperationError('invalid-input', '凭据内容超出允许长度。')
      }

      let encrypted: Buffer
      try {
        encrypted = await this.encryption.encrypt(secret)
      } catch {
        throw new AppOperationError(
          'storage-write-failed',
          '操作系统安全存储无法加密凭据，未写入任何数据。',
        )
      }
      if (encrypted.length === 0) {
        throw new AppOperationError(
          'storage-write-failed',
          '操作系统安全存储返回了空加密结果，未写入任何数据。',
        )
      }

      const entries = await this.loadState()
      const now = new Date().toISOString()
      const existing = entries.find((entry) => entry.reference === parsedReference.data)
      const entry = vaultEntrySchema.parse({
        reference: parsedReference.data,
        ciphertext: encrypted.toString('base64'),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      const next = [entry, ...entries.filter((item) => item.reference !== entry.reference)]
      await this.persist(next)
      this.entries = next
    })
  }

  read(reference: string): Promise<string | null> {
    return this.exclusive(async () => {
      await this.requireAvailable()
      const parsedReference = referenceSchema.safeParse(reference)
      if (!parsedReference.success) {
        throw new AppOperationError('invalid-input', '凭据引用格式无效。')
      }
      const entries = await this.loadState()
      const entry = entries.find((item) => item.reference === parsedReference.data)
      if (!entry) return null

      try {
        return await this.encryption.decrypt(Buffer.from(entry.ciphertext, 'base64'))
      } catch {
        throw new AppOperationError(
          'storage-corrupt',
          '无法通过操作系统安全存储解密该凭据，未回退为明文。',
        )
      }
    })
  }

  remove(reference: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.requireAvailable()
      const parsedReference = referenceSchema.safeParse(reference)
      if (!parsedReference.success) {
        throw new AppOperationError('invalid-input', '凭据引用格式无效。')
      }
      const entries = await this.loadState()
      const next = entries.filter((entry) => entry.reference !== parsedReference.data)
      if (next.length === entries.length) return false

      await this.persist(next)
      this.entries = next
      return true
    })
  }

  private async requireAvailable(): Promise<void> {
    const status = await this.encryption.getStatus()
    if (!status.available) {
      throw new AppOperationError(
        'storage-unavailable',
        '操作系统安全存储不可用，已阻止凭据操作；不会回退为明文保存。',
      )
    }
  }

  private async loadState(): Promise<VaultEntry[]> {
    if (this.entries) return this.entries

    const raw = await readJsonFile(this.filePath, '加密凭据库')
    if (raw === null) {
      this.entries = []
      return this.entries
    }

    const parsed = persistedCredentialVaultSchema.safeParse(raw)
    if (!parsed.success) {
      throw new AppOperationError(
        'storage-corrupt',
        '加密凭据库损坏或版本不受支持，已停止加载以避免数据丢失。',
      )
    }
    this.entries = parsed.data.entries
    return this.entries
  }

  private async persist(entries: VaultEntry[]): Promise<void> {
    const envelope = persistedCredentialVaultSchema.parse({ version: 1, entries })
    await writeJsonFileAtomic(this.filePath, envelope, '加密凭据库')
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
