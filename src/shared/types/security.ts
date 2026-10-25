export type CredentialProtection =
  'windows-dpapi' | 'macos-keychain' | 'linux-keyring' | 'unavailable'

export interface CredentialStorageStatus {
  available: boolean
  protection: CredentialProtection
  message: string
}

export interface SecurityStatus {
  credentialStorage: CredentialStorageStatus
  hostKeyPolicy: 'explicit-trust-only'
}
