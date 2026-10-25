// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { runBoundedCleanup } from '../../src/main/lifecycle/shutdown'

describe('bounded shutdown cleanup', () => {
  it('runs steps in order and isolates a failed step', async () => {
    const order: string[] = []
    const report = await runBoundedCleanup(
      [
        {
          name: 'transfers',
          run: () => {
            order.push('transfers')
          },
        },
        {
          name: 'sftp',
          run: () => {
            order.push('sftp')
            throw new Error('sftp cleanup failed')
          },
        },
        {
          name: 'ssh',
          run: async () => {
            order.push('ssh')
          },
        },
        {
          name: 'logger',
          run: () => {
            order.push('logger')
          },
        },
      ],
      { timeoutMs: 200 },
    )

    expect(order).toEqual(['transfers', 'sftp', 'ssh', 'logger'])
    expect(report).toEqual({ failed: ['sftp'], timedOut: [] })
  })

  it('times out a hung step, reports it, and still runs the remaining steps', async () => {
    const onError = vi.fn()
    const afterTimeout = vi.fn()

    const started = Date.now()
    const report = await runBoundedCleanup(
      [
        {
          name: 'hung',
          run: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
        },
        { name: 'next', run: afterTimeout },
      ],
      { timeoutMs: 15, onError },
    )

    expect(Date.now() - started).toBeLessThan(100)
    expect(report).toEqual({ failed: [], timedOut: ['hung'] })
    expect(afterTimeout).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('hung', expect.any(Error), true)
  })

  it('returns an empty report for a clean shutdown', async () => {
    await expect(runBoundedCleanup([{ name: 'one', run: async () => undefined }])).resolves.toEqual(
      { failed: [], timedOut: [] },
    )
  })
})
