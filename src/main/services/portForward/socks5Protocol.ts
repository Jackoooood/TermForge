import type { Duplex } from 'node:stream'
import { formatIpv6Bytes } from '../../../shared/portForward/address'
import { isValidHost } from '../../../shared/schemas/connection'

export const SOCKS5_VERSION = 0x05
export const SOCKS5_METHOD_NO_AUTH = 0x00
export const SOCKS5_METHOD_UNACCEPTABLE = 0xff
export const SOCKS5_COMMAND_CONNECT = 0x01
export const SOCKS5_ADDRESS_IPV4 = 0x01
export const SOCKS5_ADDRESS_DOMAIN = 0x03
export const SOCKS5_ADDRESS_IPV6 = 0x04

export const SOCKS5_REPLY_SUCCEEDED = 0x00
export const SOCKS5_REPLY_GENERAL_FAILURE = 0x01
export const SOCKS5_REPLY_COMMAND_UNSUPPORTED = 0x07
export const SOCKS5_REPLY_ADDRESS_UNSUPPORTED = 0x08

export const SOCKS5_MAX_HANDSHAKE_BYTES = 1_024

export type Socks5AddressType = 'ipv4' | 'domain' | 'ipv6'

export interface Socks5ConnectRequest {
  addressType: Socks5AddressType
  targetHost: string
  targetPort: number
}

export interface Socks5HandshakeResult {
  request: Socks5ConnectRequest
  /** Bytes that arrived in the same packet after the CONNECT request. */
  leftover: Buffer
}

/** A full 10-byte SOCKS5 reply with a zeroed BND.ADDR/BND.PORT. */
export function encodeSocks5Reply(replyCode: number): Buffer {
  return Buffer.from([
    SOCKS5_VERSION,
    replyCode & 0xff,
    0x00,
    SOCKS5_ADDRESS_IPV4,
    0,
    0,
    0,
    0,
    0,
    0,
  ])
}

export function encodeSocks5MethodSelection(method: number): Buffer {
  return Buffer.from([SOCKS5_VERSION, method & 0xff])
}

export class Socks5ProtocolError extends Error {
  readonly response: Buffer | null
  readonly timedOut: boolean

  constructor(message: string, response: Buffer | null, timedOut = false) {
    super(message)
    this.name = 'Socks5ProtocolError'
    this.response = response
    this.timedOut = timedOut
  }
}

export interface Socks5HandshakeOptions {
  timeoutMs: number
  maxBytes?: number
}

/**
 * Minimal RFC 1928 server handshake: no-auth negotiation followed by a single
 * CONNECT request. UDP ASSOCIATE, BIND and SOCKS4 are deliberately unsupported.
 * The parser tolerates arbitrary fragmentation and preserves bytes coalesced
 * after the request so no client payload is lost.
 */
export class Socks5Handshake {
  readonly done: Promise<Socks5HandshakeResult>

  private readonly stream: Duplex
  private readonly maxBytes: number
  private readonly timer: NodeJS.Timeout
  private buffer = Buffer.alloc(0)
  private stage: 'greeting' | 'request' | 'settled' = 'greeting'
  private settled = false
  private resolveDone: (result: Socks5HandshakeResult) => void = () => undefined
  private rejectDone: (error: Socks5ProtocolError) => void = () => undefined

  constructor(stream: Duplex, options: Socks5HandshakeOptions) {
    this.stream = stream
    this.maxBytes = options.maxBytes ?? SOCKS5_MAX_HANDSHAKE_BYTES
    this.done = new Promise<Socks5HandshakeResult>((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })

    this.timer = setTimeout(() => {
      this.fail(
        new Socks5ProtocolError('SOCKS5 握手超时，连接已关闭。', null, true),
      )
    }, options.timeoutMs)
    this.timer.unref?.()

    if (stream.destroyed) {
      this.fail(new Socks5ProtocolError('SOCKS5 连接在握手前已关闭。', null))
      return
    }

    stream.on('data', this.handleData)
    stream.on('error', this.handleStreamFailure)
    stream.on('close', this.handleStreamFailure)
  }

  dispose(): void {
    this.detach()
    this.stage = 'settled'
    clearTimeout(this.timer)
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.settled) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (this.buffer.length + bytes.length > this.maxBytes) {
      this.fail(
        new Socks5ProtocolError(
          'SOCKS5 握手数据超出限制。',
          encodeSocks5Reply(SOCKS5_REPLY_GENERAL_FAILURE),
        ),
      )
      return
    }
    this.buffer = Buffer.concat([this.buffer, bytes])
    this.parse()
  }

  private readonly handleStreamFailure = (): void => {
    this.fail(new Socks5ProtocolError('SOCKS5 连接在握手期间中断。', null))
  }

  private parse(): void {
    while (!this.settled) {
      if (this.stage === 'greeting') {
        if (!this.parseGreeting()) return
      } else if (this.stage === 'request') {
        if (!this.parseRequest()) return
      } else {
        return
      }
    }
  }

  private parseGreeting(): boolean {
    if (this.buffer.length < 2) return false
    if (this.buffer[0] !== SOCKS5_VERSION) {
      this.fail(new Socks5ProtocolError('SOCKS5 版本不受支持。', null))
      return false
    }

    const methodCount = this.buffer[1] ?? 0
    if (methodCount === 0) {
      this.fail(
        new Socks5ProtocolError(
          'SOCKS5 客户端未提供认证方法。',
          encodeSocks5MethodSelection(SOCKS5_METHOD_UNACCEPTABLE),
        ),
      )
      return false
    }
    if (this.buffer.length < 2 + methodCount) return false

    const methods = this.buffer.subarray(2, 2 + methodCount)
    if (!methods.includes(SOCKS5_METHOD_NO_AUTH)) {
      this.fail(
        new Socks5ProtocolError(
          'SOCKS5 客户端未提供可接受的认证方法。',
          encodeSocks5MethodSelection(SOCKS5_METHOD_UNACCEPTABLE),
        ),
      )
      return false
    }

    this.buffer = this.buffer.subarray(2 + methodCount)
    this.stage = 'request'
    this.writeToClient(encodeSocks5MethodSelection(SOCKS5_METHOD_NO_AUTH))
    return true
  }

  private parseRequest(): boolean {
    if (this.buffer.length < 4) return false
    const [version, command, reserved, addressType] = this.buffer

    if (version !== SOCKS5_VERSION) {
      this.failProtocol(SOCKS5_REPLY_GENERAL_FAILURE, 'SOCKS5 请求版本无效。')
      return false
    }
    if (command !== SOCKS5_COMMAND_CONNECT) {
      this.failProtocol(SOCKS5_REPLY_COMMAND_UNSUPPORTED, '仅支持 SOCKS5 CONNECT 命令。')
      return false
    }
    if (reserved !== 0x00) {
      this.failProtocol(SOCKS5_REPLY_GENERAL_FAILURE, 'SOCKS5 请求保留字段无效。')
      return false
    }

    let targetHost: string
    let targetPort: number
    let totalLength: number
    let resolvedAddressType: Socks5AddressType

    if (addressType === SOCKS5_ADDRESS_IPV4) {
      totalLength = 10
      if (this.buffer.length < totalLength) return false
      targetHost = [
        this.buffer[4] ?? 0,
        this.buffer[5] ?? 0,
        this.buffer[6] ?? 0,
        this.buffer[7] ?? 0,
      ].join('.')
      targetPort = ((this.buffer[8] ?? 0) << 8) | (this.buffer[9] ?? 0)
      resolvedAddressType = 'ipv4'
    } else if (addressType === SOCKS5_ADDRESS_IPV6) {
      totalLength = 22
      if (this.buffer.length < totalLength) return false
      targetHost = formatIpv6Bytes(this.buffer.subarray(4, 20))
      targetPort = ((this.buffer[20] ?? 0) << 8) | (this.buffer[21] ?? 0)
      resolvedAddressType = 'ipv6'
    } else if (addressType === SOCKS5_ADDRESS_DOMAIN) {
      if (this.buffer.length < 5) return false
      const domainLength = this.buffer[4] ?? 0
      totalLength = 7 + domainLength
      if (this.buffer.length < totalLength) return false
      targetHost = this.buffer.subarray(5, 5 + domainLength).toString('utf8')
      targetPort = ((this.buffer[5 + domainLength] ?? 0) << 8) | (this.buffer[6 + domainLength] ?? 0)
      resolvedAddressType = 'domain'
      if (
        domainLength === 0 ||
        targetHost !== targetHost.trim() ||
        targetHost.includes('\uFFFD') ||
        !isValidHost(targetHost)
      ) {
        this.failProtocol(SOCKS5_REPLY_GENERAL_FAILURE, 'SOCKS5 目标域名无效。')
        return false
      }
    } else {
      this.failProtocol(SOCKS5_REPLY_ADDRESS_UNSUPPORTED, 'SOCKS5 地址类型不受支持。')
      return false
    }

    if (targetPort === 0) {
      this.failProtocol(SOCKS5_REPLY_GENERAL_FAILURE, 'SOCKS5 目标端口无效。')
      return false
    }

    const leftover = Buffer.from(this.buffer.subarray(totalLength))
    this.buffer = Buffer.alloc(0)
    this.stage = 'settled'
    this.settled = true
    clearTimeout(this.timer)
    this.detach()
    this.stream.pause()
    this.resolveDone({
      request: {
        addressType: resolvedAddressType,
        targetHost,
        targetPort,
      },
      leftover,
    })
    return false
  }

  private failProtocol(replyCode: number, message: string): void {
    this.fail(new Socks5ProtocolError(message, encodeSocks5Reply(replyCode)))
  }

  private fail(error: Socks5ProtocolError): void {
    if (this.settled) return
    this.settled = true
    this.stage = 'settled'
    clearTimeout(this.timer)
    this.detach()
    this.stream.pause()

    if (error.response) this.writeToClient(error.response)
    this.rejectDone(error)
  }

  private writeToClient(response: Buffer): void {
    if (this.stream.destroyed || !this.stream.writable) return
    try {
      this.stream.write(response)
    } catch {
      // The caller will close the socket after the rejection.
    }
  }

  private detach(): void {
    this.stream.removeListener('data', this.handleData)
    this.stream.removeListener('error', this.handleStreamFailure)
    this.stream.removeListener('close', this.handleStreamFailure)
  }
}

export function startSocks5Handshake(
  stream: Duplex,
  options: Socks5HandshakeOptions,
): Socks5Handshake {
  const handshake = new Socks5Handshake(stream, options)
  stream.resume()
  return handshake
}
