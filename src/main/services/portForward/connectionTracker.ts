export interface ForwardConnectionSlot {
  release(): void
}

/**
 * Enforces both the per-rule connection cap and the shared global cap. A slot
 * is released exactly once even when teardown races the close event.
 */
export class RuleConnectionTracker {
  private readonly slots = new Set<ForwardConnectionSlot>()
  private active = 0

  constructor(
    private readonly maxPerRule: number,
    private readonly gate: { tryAcquire(): boolean; release(): void },
    private readonly onChange: (activeConnections: number) => void,
  ) {}

  get activeConnections(): number {
    return this.active
  }

  tryAcquire(): ForwardConnectionSlot | null {
    if (this.active >= this.maxPerRule) return null
    if (!this.gate.tryAcquire()) return null

    this.active += 1
    const slot: ForwardConnectionSlot = {
      release: () => {
        if (!this.slots.delete(slot)) return
        this.active -= 1
        this.gate.release()
        this.onChange(this.active)
      },
    }
    this.slots.add(slot)
    this.onChange(this.active)
    return slot
  }

  releaseAll(): void {
    for (const slot of [...this.slots]) slot.release()
  }
}
