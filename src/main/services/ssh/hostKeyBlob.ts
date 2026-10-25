import { createHash } from 'node:crypto'
import { HOST_KEY_ALGORITHMS } from '../../../shared/types/hostKey'
import type { HostKeyAlgorithm } from '../../../shared/types/hostKey'
import { SshFailureError } from './sshFailure'

export interface ParsedHostKey {
  algorithm: HostKeyAlgorithm
  fingerprint: string
}

function isHostKeyAlgorithm(value: string): value is HostKeyAlgorithm {
  return (HOST_KEY_ALGORITHMS as readonly string[]).includes(value)
}

/**
 * ssh2 hands us the raw SSH host-key blob. OpenSSH fingerprints are
 * `SHA256:` + base64(SHA-256(blob)) without trailing padding.
 */
export function parseHostKeyBlob(blob: Buffer): ParsedHostKey {
  try {
    if (!Buffer.isBuffer(blob) || blob.length < 5) {
      throw new SshFailureError('host-key-verification-failed')
    }
    const algorithmLength = blob.readUInt32BE(0)
    if (algorithmLength === 0 || algorithmLength > blob.length - 4) {
      throw new SshFailureError('host-key-verification-failed')
    }
    const algorithm = blob.subarray(4, 4 + algorithmLength).toString('ascii')
    if (!isHostKeyAlgorithm(algorithm)) {
      throw new SshFailureError('host-key-unsupported')
    }

    const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
    return { algorithm, fingerprint: `SHA256:${digest}` }
  } catch (error) {
    if (error instanceof SshFailureError) throw error
    throw new SshFailureError('host-key-verification-failed')
  }
}
