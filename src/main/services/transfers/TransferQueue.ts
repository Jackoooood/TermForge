export interface TransferQueueLimits {
  maxConcurrent: number
  maxPerSession: number
}

export interface TransferQueueEntry {
  taskId: string
  sessionId: string
}

/**
 * FIFO queue with a global concurrency ceiling and an optional per-session
 * ceiling. A task occupies a slot from `takeNext()` until `release()`, even
 * while it is being prepared, cancelled or cleaned up.
 */
export class TransferQueue {
  private readonly waiting: TransferQueueEntry[] = []
  private readonly active = new Map<string, string>()
  private limits: TransferQueueLimits

  constructor(limits: TransferQueueLimits) {
    this.limits = this.validateLimits(limits)
  }

  /**
   * Applies new ceilings to future scheduling. Running tasks keep their slots;
   * already active counts above a reduced ceiling drain naturally.
   */
  setLimits(limits: TransferQueueLimits): void {
    this.limits = this.validateLimits(limits)
  }

  getLimits(): TransferQueueLimits {
    return { ...this.limits }
  }

  enqueue(entry: TransferQueueEntry): boolean {
    if (this.active.has(entry.taskId)) return false
    if (this.waiting.some((item) => item.taskId === entry.taskId)) return false
    this.waiting.push(entry)
    return true
  }

  remove(taskId: string): boolean {
    const index = this.waiting.findIndex((entry) => entry.taskId === taskId)
    if (index === -1) return false
    this.waiting.splice(index, 1)
    return true
  }

  /** Marks the next eligible FIFO task active, or returns null when full. */
  takeNext(): TransferQueueEntry | null {
    if (this.active.size >= this.limits.maxConcurrent) return null
    const index = this.waiting.findIndex(
      (entry) => this.countActiveForSession(entry.sessionId) < this.limits.maxPerSession,
    )
    if (index === -1) return null
    const [entry] = this.waiting.splice(index, 1)
    if (!entry) return null
    this.active.set(entry.taskId, entry.sessionId)
    return entry
  }

  release(taskId: string): void {
    this.active.delete(taskId)
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId)
  }

  activeCount(): number {
    return this.active.size
  }

  activeCountForSession(sessionId: string): number {
    return this.countActiveForSession(sessionId)
  }

  waitingCount(): number {
    return this.waiting.length
  }

  removeSession(sessionId: string): TransferQueueEntry[] {
    const removed: TransferQueueEntry[] = []
    for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
      const entry = this.waiting[index]
      if (entry?.sessionId === sessionId) {
        removed.push(entry)
        this.waiting.splice(index, 1)
      }
    }
    return removed
  }

  reset(): void {
    this.waiting.length = 0
    this.active.clear()
  }

  private countActiveForSession(sessionId: string): number {
    let count = 0
    for (const activeSessionId of this.active.values()) {
      if (activeSessionId === sessionId) count += 1
    }
    return count
  }

  private validateLimits(limits: TransferQueueLimits): TransferQueueLimits {
    if (
      !Number.isInteger(limits.maxConcurrent) ||
      !Number.isInteger(limits.maxPerSession) ||
      limits.maxConcurrent < 1 ||
      limits.maxPerSession < 1
    ) {
      throw new Error('Transfer queue limits must be positive integers')
    }
    return {
      maxConcurrent: limits.maxConcurrent,
      maxPerSession: Math.min(limits.maxPerSession, limits.maxConcurrent),
    }
  }
}
