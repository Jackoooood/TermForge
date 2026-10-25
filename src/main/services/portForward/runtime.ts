import type { ForwardRuntimeError } from './forwardRuntimeErrors'

export interface ForwardRuntimeEvents {
  onConnectionCountChange(activeConnections: number): void
  onUnexpectedFailure(error: ForwardRuntimeError): void
}

export interface ForwardRuntimeHandle {
  readonly boundAddress: string
  readonly boundPort: number
  readonly activeConnections: number
  /** Resolves only after the listener and every accepted connection are gone. */
  stop(): Promise<void>
}
