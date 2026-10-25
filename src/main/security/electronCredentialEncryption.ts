import { safeStorage } from 'electron'
import type { CredentialStorageStatus } from '../../shared/types/security'
import type { CredentialEncryptionAdapter } from './credentialStore'

const UNAVAILABLE_MESSAGE = '操作系统安全存储不可用；凭据保存功能已禁用，不会降级为明文存储。'

function unavailable(): CredentialStorageStatus {
  return {
    available: false,
    protection: 'unavailable',
    message: UNAVAILABLE_MESSAGE,
  }
}

export class ElectronCredentialEncryption implements CredentialEncryptionAdapter {
  async getStatus(): Promise<CredentialStorageStatus> {
    try {
      const available = await safeStorage.isAsyncEncryptionAvailable()
      if (!available) return unavailable()

      if (process.platform === 'win32') {
        return {
          available: true,
          protection: 'windows-dpapi',
          message: '凭据将由 Windows DPAPI 保护后写入本机。',
        }
      }

      if (process.platform === 'darwin') {
        return {
          available: true,
          protection: 'macos-keychain',
          message: '凭据将由 macOS Keychain 保护后写入本机。',
        }
      }

      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend()
        if (backend === 'basic_text' || backend === 'unknown') return unavailable()
        return {
          available: true,
          protection: 'linux-keyring',
          message: '凭据将由 Linux 密钥环保护后写入本机。',
        }
      }

      return unavailable()
    } catch {
      return unavailable()
    }
  }

  encrypt(secret: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(secret)
  }

  async decrypt(encrypted: Buffer): Promise<string> {
    const result = await safeStorage.decryptStringAsync(encrypted)
    return result.result
  }
}
