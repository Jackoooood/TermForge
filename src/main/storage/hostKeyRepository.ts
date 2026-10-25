import {
  hostKeyEndpointSchema,
  hostKeyRecordSchema,
  persistedHostKeysSchema,
  presentedHostKeySchema,
} from '../../shared/schemas/hostKey'
import type { HostKeyRecord, HostKeyVerdict, PresentedHostKey } from '../../shared/types/hostKey'
import { AppOperationError } from '../errors'
import { readJsonFile, writeJsonFileAtomic } from './jsonFile'

const STORE_VERSION = 1

export function evaluateHostKey(
  presented: PresentedHostKey,
  trustedRecord: HostKeyRecord | null,
): HostKeyVerdict {
  if (!trustedRecord) return 'unknown'
  if (
    trustedRecord.algorithm !== presented.algorithm ||
    trustedRecord.fingerprint !== presented.fingerprint
  ) {
    return 'changed'
  }
  return 'trusted'
}

export interface HostKeyStore {
  list(): Promise<HostKeyRecord[]>
  verify(presented: PresentedHostKey): Promise<HostKeyVerdict>
  trust(presented: PresentedHostKey): Promise<HostKeyRecord>
  remove(host: string, port: number): Promise<boolean>
}

function parsePresented(value: PresentedHostKey): PresentedHostKey {
  const parsed = presentedHostKeySchema.safeParse(value)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '主机密钥数据格式无效。')
  }
  return parsed.data
}

function sameEndpoint(
  a: { host: string; port: number },
  b: { host: string; port: number },
): boolean {
  return a.port === b.port && a.host.toLowerCase() === b.host.toLowerCase()
}

/**
 * Stores trust decisions only. Verification never writes, auto-trusts or
 * silently replaces a different key; rotation requires an explicit `trust`.
 */
export class FileHostKeyStore implements HostKeyStore {
  private records: HostKeyRecord[] | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  list(): Promise<HostKeyRecord[]> {
    return this.exclusive(async () => structuredClone(await this.loadState()))
  }

  verify(presented: PresentedHostKey): Promise<HostKeyVerdict> {
    return this.exclusive(async () => {
      const parsed = parsePresented(presented)
      const records = await this.loadState()
      const record = records.find((candidate) => sameEndpoint(candidate, parsed)) ?? null
      return evaluateHostKey(parsed, record)
    })
  }

  trust(presented: PresentedHostKey): Promise<HostKeyRecord> {
    return this.exclusive(async () => {
      const records = await this.loadState()
      const parsed = parsePresented(presented)
      const now = new Date().toISOString()
      const record = hostKeyRecordSchema.parse({
        ...parsed,
        trustedAt: now,
        updatedAt: now,
      })
      const next = [record, ...records.filter((candidate) => !sameEndpoint(candidate, parsed))]
      await this.persist(next)
      this.records = next
      return structuredClone(record)
    })
  }

  remove(host: string, port: number): Promise<boolean> {
    return this.exclusive(async () => {
      const endpoint = hostKeyEndpointSchema.safeParse({ host, port })
      if (!endpoint.success) {
        throw new AppOperationError('invalid-input', '主机端点格式无效。')
      }
      const records = await this.loadState()
      const next = records.filter((candidate) => !sameEndpoint(candidate, endpoint.data))
      if (next.length === records.length) return false

      await this.persist(next)
      this.records = next
      return true
    })
  }

  private async loadState(): Promise<HostKeyRecord[]> {
    if (this.records) return this.records

    const raw = await readJsonFile(this.filePath, '主机密钥记录')
    if (raw === null) {
      this.records = []
      return this.records
    }

    const parsed = persistedHostKeysSchema.safeParse(raw)
    if (!parsed.success) {
      throw new AppOperationError(
        'storage-corrupt',
        '主机密钥记录损坏或版本不受支持，已停止加载以避免覆盖现有信任决定。',
      )
    }
    this.records = parsed.data.records
    return this.records
  }

  private async persist(records: HostKeyRecord[]): Promise<void> {
    const envelope = persistedHostKeysSchema.parse({ version: STORE_VERSION, records })
    await writeJsonFileAtomic(this.filePath, envelope, '主机密钥记录')
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
