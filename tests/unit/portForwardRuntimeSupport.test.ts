// @vitest-environment node

import { once } from 'node:events'
import { duplexPair } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { RuleConnectionTracker } from '../../src/main/services/portForward/connectionTracker'
import { bridgeStreams } from '../../src/main/services/portForward/streamBridge'

describe('forward connection tracker', () => {
  it('enforces the per-rule cap and releases each slot exactly once', () => {
    const gate = { tryAcquire: vi.fn(() => true), release: vi.fn() }
    const changes: number[] = []
    const tracker = new RuleConnectionTracker(2, gate, (count) => changes.push(count))

    const first = tracker.tryAcquire()
    const second = tracker.tryAcquire()
    const third = tracker.tryAcquire()

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(third).toBeNull()
    expect(tracker.activeConnections).toBe(2)
    expect(changes).toEqual([1, 2])

    first?.release()
    first?.release()
    expect(gate.release).toHaveBeenCalledTimes(1)
    expect(tracker.activeConnections).toBe(1)
    expect(changes).toEqual([1, 2, 1])
  })

  it('shares the global gate across rules and releaseAll clears every slot', () => {
    let globalActive = 0
    const gate = {
      tryAcquire: () => {
        if (globalActive >= 2) return false
        globalActive += 1
        return true
      },
      release: () => {
        globalActive -= 1
      },
    }
    const first = new RuleConnectionTracker(5, gate, () => undefined)
    const second = new RuleConnectionTracker(5, gate, () => undefined)

    expect(first.tryAcquire()).not.toBeNull()
    expect(second.tryAcquire()).not.toBeNull()
    expect(first.tryAcquire()).toBeNull()
    expect(second.tryAcquire()).toBeNull()

    first.releaseAll()
    expect(globalActive).toBe(1)
    expect(first.activeConnections).toBe(0)

    expect(first.tryAcquire()).not.toBeNull()
    second.releaseAll()
    first.releaseAll()
    expect(globalActive).toBe(0)
  })
})

describe('stream bridge', () => {
  it('pipes bytes in both directions and destroys both peers on close once', async () => {
    const [left, leftPeer] = duplexPair()
    const [right, rightPeer] = duplexPair()
    const onClosed = vi.fn()
    const close = bridgeStreams(left, right, onClosed)

    try {
      leftPeer.write('to-right')
      const [rightChunk] = (await once(rightPeer, 'data')) as [Buffer]
      expect(rightChunk.toString()).toBe('to-right')

      rightPeer.write('to-left')
      const [leftChunk] = (await once(leftPeer, 'data')) as [Buffer]
      expect(leftChunk.toString()).toBe('to-left')

      left.destroy()
      await once(left, 'close')
      await new Promise((resolve) => setImmediate(resolve))

      expect(right.destroyed).toBe(true)
      expect(onClosed).toHaveBeenCalledTimes(1)
      close()
      expect(onClosed).toHaveBeenCalledTimes(1)
    } finally {
      leftPeer.destroy()
      rightPeer.destroy()
    }
  })
})
