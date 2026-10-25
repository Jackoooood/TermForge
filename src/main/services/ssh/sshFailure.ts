import type { AuthMethod } from '../../../shared/types/connection'
import type { SshCredentialKind, SshFailure, SshFailureCode } from '../../../shared/types/ssh'

const DEFAULT_MESSAGES: Record<SshFailureCode, string> = {
  'configuration-invalid': '连接配置不完整或不受支持，无法发起 SSH 连接。',
  'credential-required': '需要提供凭据后才能连接该服务器。',
  'credential-invalid': '凭据内容无效，请重新输入。',
  'credential-unavailable': '无法读取系统凭据存储，连接已取消；不会使用明文替代。',
  'host-key-changed': '服务器主机密钥与已信任记录不一致，连接已被阻止。请核实服务器身份。',
  'host-key-rejected': '已拒绝该服务器的主机密钥，连接未建立。',
  'host-key-timeout': '等待主机密钥确认超时，连接已取消。',
  'host-key-storage-failed': '无法保存主机密钥信任决定，连接已取消。',
  'host-key-unsupported': '服务器使用了不受支持的主机密钥算法，连接已取消。',
  'host-key-verification-failed': '无法验证服务器主机密钥，连接已取消。',
  'dns-failed': '无法解析服务器地址，请检查主机名和网络设置。',
  'connection-refused': '服务器拒绝连接，请检查端口和 SSH 服务是否可用。',
  'connection-timeout': '连接服务器超时，请检查网络和防火墙设置。',
  'authentication-failed': '认证失败，请检查凭据或服务器授权配置。',
  'network-error': '网络连接异常或已中断，请检查网络后重试。',
  'remote-closed': '服务器已断开连接。',
  'agent-unavailable': '未检测到可用的 SSH Agent。请启动系统 SSH Agent 或改用其他认证方式。',
  'private-key-unreadable': '无法读取私钥文件，请检查路径、文件类型和访问权限。',
  'private-key-invalid': '私钥格式无效、已损坏或不受支持。',
  cancelled: '连接已取消。',
  internal: 'SSH 连接过程中发生内部错误，请重试。',
}

const CREDENTIAL_REQUIRED_MESSAGES: Record<SshCredentialKind, string> = {
  password: '需要密码才能连接该服务器。',
  privateKey: '需要提供私钥内容或私钥文件后才能连接该服务器。',
  passphrase: '该私钥已加密，需要输入私钥口令。',
}

export class SshFailureError extends Error {
  readonly failure: SshFailure

  constructor(code: SshFailureCode, credentialKind?: SshCredentialKind, message?: string) {
    const resolvedMessage =
      message ??
      (code === 'credential-required' && credentialKind
        ? CREDENTIAL_REQUIRED_MESSAGES[credentialKind]
        : DEFAULT_MESSAGES[code])
    super(resolvedMessage)
    this.name = 'SshFailureError'
    this.failure = {
      code,
      message: resolvedMessage,
      ...(credentialKind ? { credentialKind } : {}),
    }
  }
}

interface ErrorLike {
  code?: unknown
  level?: unknown
  message?: unknown
}

function asErrorLike(error: unknown): ErrorLike {
  if (typeof error !== 'object' || error === null) return {}
  return error as ErrorLike
}

function codeOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value.toUpperCase() : undefined
}

function messageOf(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

/**
 * Maps transport/authentication failures to fixed, renderer-safe descriptions.
 * The raw ssh2 error (which may contain host details) is never forwarded.
 */
export function mapSshClientError(error: unknown, authMethod: AuthMethod): SshFailure {
  if (error instanceof SshFailureError) return error.failure

  const like = asErrorLike(error)
  const code = codeOf(like.code)
  const message = messageOf(like.message)
  const level = typeof like.level === 'string' ? like.level : ''

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || message.includes('getaddrinfo')) {
    return new SshFailureError('dns-failed').failure
  }
  if (code === 'ECONNREFUSED') {
    return new SshFailureError('connection-refused').failure
  }
  if (code === 'ETIMEDOUT' || message.includes('timed out')) {
    return new SshFailureError('connection-timeout').failure
  }
  if (message.includes('bad passphrase') || message.includes('incorrect passphrase')) {
    return new SshFailureError('credential-invalid', 'passphrase').failure
  }
  if (
    message.includes('encrypted private key') &&
    (message.includes('passphrase') || message.includes('no passphrase'))
  ) {
    return new SshFailureError('credential-required', 'passphrase').failure
  }
  if (
    message.includes('cannot parse privatekey') ||
    message.includes('unsupported key format') ||
    message.includes('invalid key') ||
    message.includes('no key found')
  ) {
    return new SshFailureError('private-key-invalid').failure
  }
  if (
    level === 'client-authentication' ||
    message.includes('authentication methods failed') ||
    message.includes('authentication failed') ||
    message.includes('all configured authentication methods failed')
  ) {
    const credentialKind =
      authMethod === 'password'
        ? ('password' as const)
        : authMethod === 'privateKey'
          ? ('privateKey' as const)
          : undefined
    return new SshFailureError('authentication-failed', credentialKind).failure
  }
  if (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ENETDOWN' ||
    message.includes('socket hang up')
  ) {
    return new SshFailureError('network-error').failure
  }
  if (
    message.includes('no matching host key') ||
    message.includes('host key') ||
    message.includes('host denied')
  ) {
    return new SshFailureError('host-key-verification-failed').failure
  }

  return new SshFailureError('internal').failure
}
