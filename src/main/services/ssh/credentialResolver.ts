import { access } from 'node:fs/promises'
import type { ConnectionProfile } from '../../../shared/types/connection'
import type { SshCredentialKind } from '../../../shared/types/ssh'
import { AppOperationError } from '../../errors'
import type { CredentialStore } from '../../security/credentialStore'
import {
  isEncryptedPrivateKey,
  looksLikePrivateKeyPath,
  readPrivateKeyFile,
  type PrivateKeyFileReader,
} from './privateKey'
import { SshFailureError } from './sshFailure'

export type ResolvedSshAuth =
  | { method: 'password'; password: string }
  | { method: 'privateKey'; privateKey: Buffer; passphrase?: string }
  | { method: 'sshAgent'; agent: string }

export interface SshCredentialResolver {
  resolve(connection: ConnectionProfile): Promise<ResolvedSshAuth>
  saveCredential(
    connection: ConnectionProfile,
    kind: SshCredentialKind,
    secret: string,
  ): Promise<void>
}

export interface SshAgentLocator {
  locate(): Promise<string | null>
}

export interface SshCredentialResolverOptions {
  credentials: CredentialStore
  agentLocator?: SshAgentLocator
  readPrivateKeyFile?: PrivateKeyFileReader
}

const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Locates the native OpenSSH agent only. Pageant and other third-party agents
 * are intentionally not guessed at; unsupported setups get an explicit error.
 */
export class SystemSshAgentLocator implements SshAgentLocator {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly pathExists: (target: string) => Promise<boolean> = defaultPathExists,
  ) {}

  async locate(): Promise<string | null> {
    if (this.platform === 'win32') {
      return (await this.pathExists(WINDOWS_OPENSSH_AGENT_PIPE))
        ? WINDOWS_OPENSSH_AGENT_PIPE
        : null
    }
    const socketPath = this.env.SSH_AUTH_SOCK?.trim()
    if (!socketPath) return null
    return (await this.pathExists(socketPath)) ? socketPath : null
  }
}

export function credentialReference(connectionId: string, kind: SshCredentialKind): string {
  const suffix = kind === 'privateKey' ? 'private-key' : kind
  return `termforge://connection/${connectionId}/${suffix}`
}

/**
 * Reads credentials exclusively from the OS-protected credential vault (or an
 * explicitly configured private-key file). Secrets are returned directly to
 * the SSH layer and never persisted in connection profiles or renderer state.
 */
export class VaultCredentialResolver implements SshCredentialResolver {
  private readonly agentLocator: SshAgentLocator
  private readonly readPrivateKey: PrivateKeyFileReader

  constructor(private readonly options: SshCredentialResolverOptions) {
    this.agentLocator = options.agentLocator ?? new SystemSshAgentLocator()
    this.readPrivateKey = options.readPrivateKeyFile ?? readPrivateKeyFile
  }

  async resolve(connection: ConnectionProfile): Promise<ResolvedSshAuth> {
    if (connection.authMethod === 'password') {
      const password = await this.readFirstVaultValue(
        this.candidateVaultReferences(connection, 'password'),
      )
      if (password === null) {
        throw new SshFailureError('credential-required', 'password')
      }
      return { method: 'password', password }
    }

    if (connection.authMethod === 'privateKey') {
      const privateKey = await this.readPrivateKeyValue(connection)
      const encrypted = isEncryptedPrivateKey(privateKey)
      let passphrase: string | undefined
      if (encrypted) {
        passphrase =
          (await this.readVaultValue(credentialReference(connection.id, 'passphrase'))) ??
          undefined
        if (!passphrase) {
          throw new SshFailureError('credential-required', 'passphrase')
        }
      }
      return {
        method: 'privateKey',
        privateKey: Buffer.from(privateKey, 'utf8'),
        ...(passphrase ? { passphrase } : {}),
      }
    }

    const agent = await this.agentLocator.locate()
    if (!agent) {
      throw new SshFailureError('agent-unavailable')
    }
    return { method: 'sshAgent', agent }
  }

  async saveCredential(
    connection: ConnectionProfile,
    kind: SshCredentialKind,
    secret: string,
  ): Promise<void> {
    if (connection.authMethod === 'sshAgent') {
      throw new AppOperationError(
        'invalid-input',
        'SSH Agent 连接不接受保存的密码或私钥，请由系统 Agent 管理凭据。',
      )
    }
    if (kind === 'password' && connection.authMethod !== 'password') {
      throw new AppOperationError('invalid-input', '当前连接不支持保存密码。')
    }
    if (kind !== 'password' && connection.authMethod !== 'privateKey') {
      throw new AppOperationError('invalid-input', '当前连接不支持保存私钥或私钥口令。')
    }

    let value = secret
    if (kind === 'privateKey') {
      value = secret.replace(/\r\n/g, '\n').trim()
      if (!/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(value)) {
        throw new AppOperationError('invalid-input', '私钥内容格式无效。')
      }
    } else if (value.length === 0) {
      throw new AppOperationError('invalid-input', '凭据内容不能为空。')
    }

    await this.options.credentials.save(credentialReference(connection.id, kind), value)
  }

  private async readPrivateKeyValue(connection: ConnectionProfile): Promise<string> {
    const reference = connection.credentialRef?.trim()
    if (reference && looksLikePrivateKeyPath(reference)) {
      const content = await this.readPrivateKey(reference)
      if (content.trim().length === 0) {
        throw new SshFailureError('private-key-invalid')
      }
      return content.replace(/\r\n/g, '\n')
    }

    const content = await this.readFirstVaultValue(
      this.candidateVaultReferences(connection, 'privateKey'),
    )
    if (content === null) {
      throw new SshFailureError('credential-required', 'privateKey')
    }
    return content.replace(/\r\n/g, '\n')
  }

  private candidateVaultReferences(
    connection: ConnectionProfile,
    kind: SshCredentialKind,
  ): string[] {
    const references: string[] = []
    const configured = connection.credentialRef?.trim()
    if (configured && !looksLikePrivateKeyPath(configured)) {
      references.push(configured)
    }
    const fallback = credentialReference(connection.id, kind)
    if (!references.includes(fallback)) references.push(fallback)
    return references
  }

  private async readFirstVaultValue(references: string[]): Promise<string | null> {
    for (const reference of references) {
      const value = await this.readVaultValue(reference)
      if (value !== null) return value
    }
    return null
  }

  private async readVaultValue(reference: string): Promise<string | null> {
    try {
      return await this.options.credentials.read(reference)
    } catch {
      throw new SshFailureError('credential-unavailable')
    }
  }
}
