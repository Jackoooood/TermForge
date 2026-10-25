export const HOST_KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  // ssh2 reports the raw key blob type for RSA keys (ssh-rsa) even when the
  // negotiated signature algorithm is one of the rsa-sha2-* variants.
  'ssh-rsa',
] as const

export type HostKeyAlgorithm = (typeof HOST_KEY_ALGORITHMS)[number]

export interface PresentedHostKey {
  host: string
  port: number
  algorithm: HostKeyAlgorithm
  fingerprint: string
}

export interface HostKeyRecord extends PresentedHostKey {
  trustedAt: string
  updatedAt: string
}

export type HostKeyVerdict = 'trusted' | 'unknown' | 'changed'
