import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SshFailureError } from './sshFailure'

export const MAX_PRIVATE_KEY_BYTES = 65_536

const OPENSSH_MAGIC = 'openssh-key-v1\0'

export function isEncryptedPrivateKey(content: string): boolean {
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(content)) return true
  if (/Proc-Type:\s*4\s*,\s*ENCRYPTED/i.test(content)) return true
  if (/DEK-Info:/i.test(content)) return true

  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(
    content,
  )
  if (!match?.[1]) return false

  let decoded: Buffer
  try {
    decoded = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  } catch {
    return false
  }
  if (decoded.length < 19) return false
  if (decoded.subarray(0, OPENSSH_MAGIC.length).toString('latin1') !== OPENSSH_MAGIC) {
    return false
  }

  const cipherLength = decoded.readUInt32BE(OPENSSH_MAGIC.length)
  if (cipherLength === 0 || cipherLength > decoded.length - OPENSSH_MAGIC.length - 4) return false
  const cipherName = decoded
    .subarray(OPENSSH_MAGIC.length + 4, OPENSSH_MAGIC.length + 4 + cipherLength)
    .toString('ascii')
  return cipherName !== 'none'
}

export function looksLikePrivateKeyPath(value: string): boolean {
  const trimmed = value.trim()
  return (
    /^file:\/\//i.test(trimmed) ||
    trimmed === '~' ||
    /^~[\\/]/.test(trimmed) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('.\\') ||
    trimmed.startsWith('..\\') ||
    trimmed.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    (isAbsolute(trimmed) && !trimmed.startsWith('termforge:'))
  )
}

export function resolvePrivateKeyPath(rawValue: string, homeDirectory = homedir()): string {
  const value = rawValue.trim()
  if (value.length === 0) {
    throw new SshFailureError('private-key-unreadable', undefined, '私钥路径不能为空。')
  }

  let resolved = value
  if (/^file:\/\//i.test(value)) {
    try {
      resolved = fileURLToPath(new URL(value))
    } catch {
      throw new SshFailureError('private-key-unreadable', undefined, '私钥文件 URL 格式无效。')
    }
  } else if (value === '~') {
    resolved = homeDirectory
  } else if (/^~[\\/]/.test(value)) {
    resolved = `${homeDirectory}${value.slice(1)}`
  }

  if (!isAbsolute(resolved)) {
    throw new SshFailureError(
      'private-key-unreadable',
      undefined,
      '私钥路径必须是绝对路径、file:// URL 或以 ~ 开头。',
    )
  }
  return resolved
}

export type PrivateKeyFileReader = (rawPath: string) => Promise<string>

export const readPrivateKeyFile: PrivateKeyFileReader = async (rawPath) => {
  const filePath = resolvePrivateKeyPath(rawPath)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      throw new SshFailureError('private-key-unreadable', undefined, '私钥路径不是普通文件。')
    }
    if (info.size <= 0 || info.size > MAX_PRIVATE_KEY_BYTES) {
      throw new SshFailureError(
        'private-key-unreadable',
        undefined,
        '私钥文件为空或超出允许大小。',
      )
    }
    const buffer = await readFile(filePath)
    if (buffer.length === 0 || buffer.length > MAX_PRIVATE_KEY_BYTES) {
      throw new SshFailureError(
        'private-key-unreadable',
        undefined,
        '私钥文件为空或超出允许大小。',
      )
    }
    return buffer.toString('utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    if (error instanceof SshFailureError) throw error
    throw new SshFailureError('private-key-unreadable')
  }
}
