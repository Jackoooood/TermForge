export interface CleanupStep {
  name: string
  run: () => void | Promise<void>
}

export interface ShutdownReport {
  failed: string[]
  timedOut: string[]
}

export interface ShutdownOptions {
  timeoutMs?: number
  onError?: (step: string, error: unknown, timedOut: boolean) => void
}

class CleanupTimeoutError extends Error {
  constructor() {
    super('cleanup step timed out')
    this.name = 'CleanupTimeoutError'
  }
}

function runWithTimeout(step: CleanupStep, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new CleanupTimeoutError())
    }, timeoutMs)
    timer.unref?.()

    Promise.resolve()
      .then(() => step.run())
      .then(
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
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
 * Runs cleanup steps sequentially. Each step is isolated and independently
 * bounded, so one hung service cannot prevent SSH, SFTP or log cleanup from
 * being attempted.
 */
export async function runBoundedCleanup(
  steps: readonly CleanupStep[],
  options: ShutdownOptions = {},
): Promise<ShutdownReport> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 3_000)
  const report: ShutdownReport = { failed: [], timedOut: [] }

  for (const step of steps) {
    try {
      await runWithTimeout(step, timeoutMs)
    } catch (error) {
      const timedOut = error instanceof CleanupTimeoutError
      if (timedOut) report.timedOut.push(step.name)
      else report.failed.push(step.name)
      options.onError?.(step.name, error, timedOut)
    }
  }
  return report
}
