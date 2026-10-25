import type { Duplex } from 'node:stream'
import type { PortForwardFailure } from '../../../shared/types/portForward'
import type { SshForwardingSession } from '../ssh/SshForwardingSession'

export class ForwardRuntimeError extends Error {
  readonly failure: PortForwardFailure

  constructor(failure: PortForwardFailure) {
    super(failure.message)
    this.name = 'ForwardRuntimeError'
    this.failure = failure
  }
}

export class ForwardTimeoutError extends ForwardRuntimeError {}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function mapLocalBindFailure(
  error: unknown,
  address: string,
  port: number,
): PortForwardFailure {
  const code = errorCode(error)
  if (code === 'EADDRINUSE') {
    return {
      code: 'bind-failed',
      message: `无法监听 ${address}:${port}，该端口已被其他程序占用。`,
    }
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      code: 'bind-failed',
      message: `没有权限监听 ${address}:${port}，请选择其他端口。`,
    }
  }
  if (code === 'EADDRNOTAVAIL') {
    return {
      code: 'bind-failed',
      message: `监听地址 ${address} 在当前系统上不可用。`,
    }
  }
  return {
    code: 'bind-failed',
    message: `无法在 ${address}:${port} 启动本地监听。`,
  }
}

export function mapRemoteBindFailure(
  error: unknown,
  address: string,
  port: number,
): PortForwardFailure {
  const code = errorCode(error)
  if (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EPERM') {
    return {
      code: 'remote-bind-failed',
      message: `远程服务器拒绝了 ${address}:${port} 的监听请求，该端口可能已被占用或不允许绑定。`,
    }
  }
  return {
    code: 'remote-bind-failed',
    message: `远程服务器无法在 ${address}:${port} 建立监听。`,
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  failure: PortForwardFailure,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new ForwardTimeoutError(failure))
    }, timeoutMs)
    timer.unref?.()

    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Opens one SSH channel to a forwarding target. A channel that arrives after
 * the timeout is destroyed instead of leaking into the runtime.
 */
export async function openForwardChannel(
  facade: SshForwardingSession,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(
        new ForwardTimeoutError({
          code: 'handshake-timeout',
          message: `连接 ${targetHost}:${targetPort} 超时，已关闭本次转发。`,
        }),
      )
    }, timeoutMs)
    timer.unref?.()

    facade.forwardOut('127.0.0.1', 0, targetHost, targetPort).then(
      (channel) => {
        if (settled) {
          try {
            channel.destroy()
          } catch {
            // The channel raced teardown.
          }
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(channel)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
