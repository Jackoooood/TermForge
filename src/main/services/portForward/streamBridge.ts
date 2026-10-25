import type { Duplex } from 'node:stream'

function safeDestroy(stream: Duplex): void {
  try {
    stream.destroy()
  } catch {
    // A half-closed peer may already be gone.
  }
}

/**
 * Pipes two duplex streams without inspecting payload bytes. The first close
 * or error tears down both sides so an SSH channel and its TCP peer can never
 * outlive each other.
 */
export function bridgeStreams(left: Duplex, right: Duplex, onClosed: () => void): () => void {
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    safeDestroy(left)
    safeDestroy(right)
    onClosed()
  }

  left.once('error', close)
  right.once('error', close)
  left.once('close', close)
  right.once('close', close)
  left.pipe(right)
  right.pipe(left)
  return close
}
