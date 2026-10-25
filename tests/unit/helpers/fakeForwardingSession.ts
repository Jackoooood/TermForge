import { createServer, createConnection, type AddressInfo, type Server, type Socket } from 'node:net'
import { once } from 'node:events'
import { duplexPair, type Duplex } from 'node:stream'
import type {
  ForwardedTcpConnection,
  ForwardedTcpConnectionListener,
  SshForwardingSession,
} from '../../../src/main/services/ssh/SshForwardingSession'

export type ForwardOutHandler = (
  srcAddress: string,
  srcPort: number,
  destAddress: string,
  destPort: number,
) => Promise<Duplex>

export type ForwardInHandler = (bindAddress: string, bindPort: number) => Promise<number>
export type UnforwardInHandler = (bindAddress: string, bindPort: number) => Promise<void>

export class FakeForwardingSession implements SshForwardingSession {
  readonly sessionId: string
  readonly forwardOutCalls: Array<[string, number, string, number]> = []
  readonly forwardInCalls: Array<[string, number]> = []
  readonly unforwardInCalls: Array<[string, number]> = []
  readonly acceptedChannels: Duplex[] = []
  rejectedConnections = 0

  forwardOutHandler: ForwardOutHandler = async () => {
    throw new Error('forwardOut handler is not configured')
  }
  forwardInHandler: ForwardInHandler = async (_bindAddress, bindPort) => bindPort
  unforwardInHandler: UnforwardInHandler = async () => {}

  private readonly tcpListeners = new Set<ForwardedTcpConnectionListener>()
  private readonly closedListeners = new Set<() => void>()
  private isClosed = false

  constructor(sessionId = 'ssh-forward-test') {
    this.sessionId = sessionId
  }

  get closed(): boolean {
    return this.isClosed
  }

  forwardOut(
    srcAddress: string,
    srcPort: number,
    destAddress: string,
    destPort: number,
  ): Promise<Duplex> {
    this.forwardOutCalls.push([srcAddress, srcPort, destAddress, destPort])
    if (this.isClosed) return Promise.reject(new Error('session closed'))
    return this.forwardOutHandler(srcAddress, srcPort, destAddress, destPort)
  }

  forwardIn(bindAddress: string, bindPort: number): Promise<number> {
    this.forwardInCalls.push([bindAddress, bindPort])
    if (this.isClosed) return Promise.reject(new Error('session closed'))
    return this.forwardInHandler(bindAddress, bindPort)
  }

  unforwardIn(bindAddress: string, bindPort: number): Promise<void> {
    this.unforwardInCalls.push([bindAddress, bindPort])
    if (this.isClosed) return Promise.reject(new Error('session closed'))
    return this.unforwardInHandler(bindAddress, bindPort)
  }

  onTcpConnection(listener: ForwardedTcpConnectionListener): () => void {
    if (this.isClosed) return () => {}
    this.tcpListeners.add(listener)
    return () => {
      this.tcpListeners.delete(listener)
    }
  }

  onClosed(listener: () => void): () => void {
    if (this.isClosed) {
      listener()
      return () => {}
    }
    this.closedListeners.add(listener)
    return () => {
      this.closedListeners.delete(listener)
    }
  }

  emitTcpConnection(
    details: {
      sourceAddress: string
      sourcePort: number
      destinationAddress: string
      destinationPort: number
    },
    createChannel: () => Duplex = () => duplexPair()[0],
  ): { accepted: boolean; channel: Duplex | null; rejected: boolean } {
    let decided = false
    let acceptedChannel: Duplex | null = null
    let rejected = false

    const reject = (): void => {
      if (decided) return
      decided = true
      rejected = true
      this.rejectedConnections += 1
    }
    const accept = (): Duplex => {
      if (decided) throw new Error('connection already decided')
      decided = true
      acceptedChannel = createChannel()
      this.acceptedChannels.push(acceptedChannel)
      return acceptedChannel
    }

    const connection: ForwardedTcpConnection = { ...details, accept, reject }
    for (const listener of [...this.tcpListeners]) {
      listener(connection)
    }
    if (!decided) reject()
    return { accepted: acceptedChannel !== null, channel: acceptedChannel, rejected }
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.tcpListeners.clear()
    const listeners = [...this.closedListeners]
    this.closedListeners.clear()
    for (const listener of listeners) listener()
  }
}

export interface EchoServer {
  port: number
  server: Server
  close(): Promise<void>
}

export async function createEchoServer(): Promise<EchoServer> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => {
      socket.write(chunk)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

export async function getFreeLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return address.port
}

export async function connectToPort(port: number): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  return socket
}

export async function readExact(stream: Duplex | Socket, length: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let received = 0
  while (received < length) {
    const [chunk] = (await once(stream, 'data')) as [Buffer]
    chunks.push(chunk)
    received += chunk.length
  }
  return Buffer.concat(chunks).subarray(0, length)
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('Timed out waiting for condition')
}

export const unlimitedGate = {
  tryAcquire: () => true,
  release: () => {},
}
