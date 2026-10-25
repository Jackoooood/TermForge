// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { TransferQueue } from '../../src/main/services/transfers/TransferQueue'

describe('TransferQueue', () => {
  it('rejects non-positive limits', () => {
    expect(() => new TransferQueue({ maxConcurrent: 0, maxPerSession: 1 })).toThrow(
      /must be positive/,
    )
    expect(() => new TransferQueue({ maxConcurrent: 1, maxPerSession: 0 })).toThrow(
      /must be positive/,
    )
  })

  it('takes waiting tasks in FIFO order and ignores duplicate entries', () => {
    const queue = new TransferQueue({ maxConcurrent: 2, maxPerSession: 2 })

    expect(queue.enqueue({ taskId: 'transfer-a', sessionId: 'ssh-1' })).toBe(true)
    expect(queue.enqueue({ taskId: 'transfer-b', sessionId: 'ssh-1' })).toBe(true)
    expect(queue.enqueue({ taskId: 'transfer-a', sessionId: 'ssh-1' })).toBe(false)
    expect(queue.waitingCount()).toBe(2)

    expect(queue.takeNext()).toEqual({ taskId: 'transfer-a', sessionId: 'ssh-1' })
    expect(queue.takeNext()).toEqual({ taskId: 'transfer-b', sessionId: 'ssh-1' })
    expect(queue.takeNext()).toBeNull()
    expect(queue.enqueue({ taskId: 'transfer-a', sessionId: 'ssh-1' })).toBe(false)
  })

  it('enforces the per-session ceiling without blocking other sessions', () => {
    const queue = new TransferQueue({ maxConcurrent: 3, maxPerSession: 1 })

    queue.enqueue({ taskId: 'transfer-a1', sessionId: 'ssh-a' })
    queue.enqueue({ taskId: 'transfer-a2', sessionId: 'ssh-a' })
    queue.enqueue({ taskId: 'transfer-b1', sessionId: 'ssh-b' })

    expect(queue.takeNext()).toEqual({ taskId: 'transfer-a1', sessionId: 'ssh-a' })
    expect(queue.takeNext()).toEqual({ taskId: 'transfer-b1', sessionId: 'ssh-b' })
    expect(queue.takeNext()).toBeNull()
    expect(queue.activeCount()).toBe(2)
    expect(queue.activeCountForSession('ssh-a')).toBe(1)
    expect(queue.waitingCount()).toBe(1)

    queue.release('transfer-a1')
    expect(queue.takeNext()).toEqual({ taskId: 'transfer-a2', sessionId: 'ssh-a' })
  })

  it('removes a waiting task without touching active slots', () => {
    const queue = new TransferQueue({ maxConcurrent: 1, maxPerSession: 1 })
    queue.enqueue({ taskId: 'transfer-a', sessionId: 'ssh-1' })
    queue.enqueue({ taskId: 'transfer-b', sessionId: 'ssh-1' })
    queue.takeNext()

    expect(queue.remove('transfer-a')).toBe(false)
    expect(queue.remove('transfer-b')).toBe(true)
    expect(queue.waitingCount()).toBe(0)
    expect(queue.isActive('transfer-a')).toBe(true)
  })

  it('removes every waiting task for a session', () => {
    const queue = new TransferQueue({ maxConcurrent: 5, maxPerSession: 5 })
    queue.enqueue({ taskId: 'transfer-a1', sessionId: 'ssh-a' })
    queue.enqueue({ taskId: 'transfer-b1', sessionId: 'ssh-b' })
    queue.enqueue({ taskId: 'transfer-a2', sessionId: 'ssh-a' })

    expect(queue.removeSession('ssh-a')).toEqual([
      { taskId: 'transfer-a2', sessionId: 'ssh-a' },
      { taskId: 'transfer-a1', sessionId: 'ssh-a' },
    ])
    expect(queue.waitingCount()).toBe(1)
  })

  it('applies mutable limits to future scheduling and clamps per-session to global', () => {
    const queue = new TransferQueue({ maxConcurrent: 1, maxPerSession: 1 })
    queue.enqueue({ taskId: 'transfer-a1', sessionId: 'ssh-a' })
    queue.enqueue({ taskId: 'transfer-a2', sessionId: 'ssh-a' })
    queue.enqueue({ taskId: 'transfer-b1', sessionId: 'ssh-b' })

    expect(queue.takeNext()?.taskId).toBe('transfer-a1')
    expect(queue.takeNext()).toBeNull()

    queue.setLimits({ maxConcurrent: 3, maxPerSession: 5 })
    expect(queue.getLimits()).toEqual({ maxConcurrent: 3, maxPerSession: 3 })
    expect(queue.takeNext()?.taskId).toBe('transfer-a2')
    expect(queue.takeNext()?.taskId).toBe('transfer-b1')
    expect(queue.activeCount()).toBe(3)
  })

  it('keeps running tasks when limits are reduced and drains before scheduling again', () => {
    const queue = new TransferQueue({ maxConcurrent: 3, maxPerSession: 2 })
    queue.enqueue({ taskId: 'transfer-a1', sessionId: 'ssh-a' })
    queue.enqueue({ taskId: 'transfer-b1', sessionId: 'ssh-b' })
    queue.enqueue({ taskId: 'transfer-c1', sessionId: 'ssh-c' })
    queue.takeNext()
    queue.takeNext()
    queue.takeNext()
    queue.enqueue({ taskId: 'transfer-d1', sessionId: 'ssh-d' })

    queue.setLimits({ maxConcurrent: 1, maxPerSession: 1 })
    expect(queue.activeCount()).toBe(3)
    expect(queue.takeNext()).toBeNull()

    queue.release('transfer-a1')
    queue.release('transfer-b1')
    expect(queue.takeNext()).toBeNull()
    queue.release('transfer-c1')
    expect(queue.takeNext()?.taskId).toBe('transfer-d1')
  })

  it('rejects invalid limits without changing the active limits', () => {
    const queue = new TransferQueue({ maxConcurrent: 2, maxPerSession: 1 })
    expect(() => queue.setLimits({ maxConcurrent: 0, maxPerSession: 1 })).toThrow(
      /positive integers/,
    )
    expect(() => queue.setLimits({ maxConcurrent: 2, maxPerSession: 1.5 })).toThrow(
      /positive integers/,
    )
    expect(queue.getLimits()).toEqual({ maxConcurrent: 2, maxPerSession: 1 })
  })

  it('resets all waiting and active entries', () => {
    const queue = new TransferQueue({ maxConcurrent: 2, maxPerSession: 2 })
    queue.enqueue({ taskId: 'transfer-a', sessionId: 'ssh-1' })
    queue.takeNext()
    queue.enqueue({ taskId: 'transfer-b', sessionId: 'ssh-1' })

    queue.reset()

    expect(queue.waitingCount()).toBe(0)
    expect(queue.activeCount()).toBe(0)
    expect(queue.takeNext()).toBeNull()
  })
})
